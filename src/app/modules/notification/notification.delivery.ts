import type { QueryFilter, Types } from "mongoose";
import { emitToUser } from "../../realtime/realtime.js";
import { UserModel } from "../auth/auth.model.js";
import { FarmStatuses } from "../farm/farm.constants.js";
import { FarmModel } from "../farm/farm.model.js";
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";
import { FarmMemberModel } from "../farmMember/farmMember.model.js";
import { escapeRegex } from "../feedRecord/feedRecord.utils.js";
import { MAX_MESSAGE_LENGTH, NotificationStatuses } from "./notification.constants.js";
import type { TNotificationEvent, TNotificationReferenceType } from "./notification.constants.js";
import type { TNotification } from "./notification.interface.js";
import { generateNotificationNo, NotificationModel } from "./notification.model.js";

const { ACTIVE, ARCHIVED, EXPIRED } = NotificationStatuses;

/** Active members (with active accounts) by role; the owner account always counts as Owner. */
export type TAudience = { farmId: Types.ObjectId; byRole: Map<string, Types.ObjectId[]> };

/** null = the farm is not Active, so nothing new is delivered. */
export const loadAudience = async (farmId: Types.ObjectId): Promise<TAudience | null> => {
  const farm = await FarmModel.findById(farmId).select("ownerId status").lean();
  if (!farm || farm.status !== FarmStatuses.ACTIVE) return null;
  const members = await FarmMemberModel.find({ farmId, isActive: true }).select("userId role").lean();
  const accounts = await UserModel.find({
    _id: { $in: [farm.ownerId, ...members.map((member) => member.userId)] },
    isActive: true,
    isDeleted: false,
  })
    .select("_id")
    .lean();
  const usable = new Set(accounts.map((account) => String(account._id)));
  const byRole = new Map<string, Types.ObjectId[]>();
  const add = (role: string, userId: Types.ObjectId) => {
    if (usable.has(String(userId))) byRole.set(role, [...(byRole.get(role) ?? []), userId]);
  };
  add(FarmMemberRoles.OWNER, farm.ownerId);
  for (const member of members) add(member.role, member.userId);
  return { farmId, byRole };
};

export const recipientsOf = (audience: TAudience, roles: readonly string[]): Types.ObjectId[] => {
  const unique = new Map<string, Types.ObjectId>();
  for (const role of roles) for (const id of audience.byRole.get(role) ?? []) unique.set(String(id), id);
  return [...unique.values()];
};

/** Small hint for every open tab of the users; details come from the REST API. */
export const emitUpdated = (userIds: Iterable<unknown>): void => {
  for (const id of new Set([...userIds].map(String))) emitToUser(id, "notification.updated", {});
};

export const emitCreated = (row: { _id: unknown; farmId: unknown; userId: unknown; type: string; priority: string }): void =>
  emitToUser(String(row.userId), "notification.created", {
    notificationId: String(row._id),
    farmId: String(row.farmId),
    type: row.type,
    priority: row.priority,
  });

type TContent = { message: string; expiresAt?: Date | null };

/** Inserts one row; "already told" (duplicate key) is not an error. */
const insertFor = async (
  farmId: Types.ObjectId,
  userId: Types.ObjectId,
  event: TNotificationEvent,
  referenceId: Types.ObjectId | null,
  content: TContent,
): Promise<void> => {
  const { title, type, priority, referenceType } = event;
  try {
    const row = await NotificationModel.create({
      notificationNo: await generateNotificationNo(),
      farmId,
      userId,
      title,
      type,
      priority,
      referenceType,
      referenceId,
      message: content.message.slice(0, MAX_MESSAGE_LENGTH),
      expiresAt: content.expiresAt ?? null,
    });
    emitCreated(row);
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
  }
};

/**
 * Delivers one notification to a single named user (not an audience). Used for one-off,
 * personal events such as Report Ready / Report Failed, which go only to the requester.
 * Never throws; "already told" duplicate keys are swallowed by insertFor.
 */
export const notifyUser = (
  farmId: Types.ObjectId,
  userId: Types.ObjectId,
  event: TNotificationEvent,
  content: TContent,
): Promise<void> => insertFor(farmId, userId, event, null, content);

/** Moves matching rows to Expired. Archived rows are included only where asked. */
export const expireRows = async (filter: QueryFilter<TNotification>, withArchived = false): Promise<void> => {
  const wanted = withArchived ? [ACTIVE, ARCHIVED] : [ACTIVE];
  const rows = await NotificationModel.find({ ...filter, status: { $in: wanted } })
    .select("_id userId")
    .lean();
  if (!rows.length) return;
  await NotificationModel.updateMany(
    { _id: { $in: rows.map((row) => row._id) }, status: { $in: wanted } },
    { $set: { status: EXPIRED } },
  );
  emitUpdated(rows.map((row) => row.userId));
};

/** The condition behind these events is over (completed, cancelled, voided, stock recovered …). */
export const resolveFor = (
  farmId: Types.ObjectId,
  referenceType: TNotificationReferenceType,
  referenceId: Types.ObjectId,
  options: { events?: readonly TNotificationEvent[]; withArchived?: boolean } = {},
): Promise<void> =>
  expireRows(
    {
      farmId,
      referenceType,
      referenceId,
      ...(options.events ? { title: { $in: options.events.map((event) => event.title) } } : {}),
    },
    options.withArchived ?? false,
  );

/**
 * Condition / one-off event: told again only when the recipient has no Active or Archived row
 * for this key. `refresh` keeps message and expiry of open rows current.
 */
export const raise = async (
  audience: TAudience,
  event: TNotificationEvent,
  referenceId: Types.ObjectId,
  content: TContent & { refresh?: boolean },
): Promise<void> => {
  const key = { farmId: audience.farmId, referenceType: event.referenceType, referenceId, title: event.title };
  if (content.refresh) {
    await NotificationModel.updateMany(
      { ...key, status: ACTIVE },
      { $set: { message: content.message.slice(0, MAX_MESSAGE_LENGTH), expiresAt: content.expiresAt ?? null } },
    );
  }
  const open = await NotificationModel.find({ ...key, status: { $in: [ACTIVE, ARCHIVED] } })
    .select("userId")
    .lean();
  const told = new Set(open.map((row) => String(row.userId)));
  for (const userId of recipientsOf(audience, event.roles)) {
    if (!told.has(String(userId))) await insertFor(audience.farmId, userId, event, referenceId, content);
  }
};

/** Rows of a record without a reference type (Device): the message starts with `fact`. */
export const factFilter = (farmId: Types.ObjectId, event: TNotificationEvent, fact: string): QueryFilter<TNotification> => ({
  farmId,
  referenceType: event.referenceType,
  referenceId: null,
  //an announcement may use the same title, but never this type
  type: event.type,
  title: event.title,
  message: { $regex: `^${escapeRegex(fact)}` },
});

/**
 * Event without a reference id, so without the unique index: call it from a job only (its lock
 * stops parallel runs). Each recipient is told once per `fact`, in any status.
 */
export const raiseFact = async (
  audience: TAudience,
  event: TNotificationEvent,
  fact: string,
  content: { details: string; expiresAt?: Date },
): Promise<void> => {
  const rows = await NotificationModel.find(factFilter(audience.farmId, event, fact)).select("userId").lean();
  const told = new Set(rows.map((row) => String(row.userId)));
  for (const userId of recipientsOf(audience, event.roles)) {
    if (told.has(String(userId))) continue;
    await insertFor(audience.farmId, userId, event, null, {
      message: `${fact} ${content.details}`,
      expiresAt: content.expiresAt ?? null,
    });
  }
};

const reopenRow = async (id: Types.ObjectId, message: string): Promise<void> => {
  const row = await NotificationModel.findOneAndUpdate(
    { _id: id, status: EXPIRED },
    { $set: { status: ACTIVE, isRead: false, readAt: null, message: message.slice(0, MAX_MESSAGE_LENGTH) } },
    { returnDocument: "after" },
  );
  if (row) emitCreated(row);
};

export type TDue = {
  referenceId: Types.ObjectId;
  event: TNotificationEvent;
  //another stage that already covers this one for the same date (neither replaced nor repeated)
  coveredBy?: TNotificationEvent;
  expiresAt: Date;
  message: string;
};

/**
 * Timed reminders. `dues` is the complete current state of `events` (inside `scope` when given):
 * open rows that no longer match it expire, and each recipient is told once per record, stage
 * and due date. A row counts as "already told" in any status while its expiry matches the
 * current due date, so a rescheduled record is announced again. An expired row whose own expiry
 * is still ahead was closed early (record closed or moved): it comes back when the due does.
 */
export const syncTimed = async (
  farmId: Types.ObjectId,
  audience: TAudience | null,
  events: readonly [TNotificationEvent, ...TNotificationEvent[]],
  dues: TDue[],
  scope?: Types.ObjectId[],
): Promise<void> => {
  const rows = await NotificationModel.find({
    farmId,
    referenceType: events[0].referenceType,
    title: { $in: events.map((event) => event.title) },
    ...(scope
      ? { referenceId: { $in: scope } }
      : { $or: [{ status: ACTIVE }, { referenceId: { $in: dues.map((due) => due.referenceId) } }] }),
  })
    .select("_id userId title referenceId expiresAt status")
    .lean();

  const dueOf = new Map(dues.map((due) => [String(due.referenceId), due]));
  const covers = (due: TDue | undefined, row: (typeof rows)[number]) =>
    !!due &&
    (row.title === due.event.title || row.title === due.coveredBy?.title) &&
    row.expiresAt?.getTime() === due.expiresAt.getTime();

  const told = new Set<string>();
  const closedEarly = new Map<string, (typeof rows)[number]>();
  const stale: Types.ObjectId[] = [];
  for (const row of rows) {
    const key = `${row.referenceId}:${row.userId}`;
    if (covers(dueOf.get(String(row.referenceId)), row)) {
      if (row.status === EXPIRED) closedEarly.set(key, row);
      else told.add(key);
    }
    else if (row.status === ACTIVE) stale.push(row._id);
  }
  //before the inserts: an open row of the old date would block the new one
  if (stale.length) await expireRows({ _id: { $in: stale } });
  if (!audience) return;

  for (const due of dueOf.values()) {
    if (due.expiresAt.getTime() <= Date.now()) continue;
    for (const userId of recipientsOf(audience, due.event.roles)) {
      const key = `${due.referenceId}:${userId}`;
      if (told.has(key)) continue;
      const closed = closedEarly.get(key);
      if (!closed) await insertFor(farmId, userId, due.event, due.referenceId, due);
      else await reopenRow(closed._id, due.message);
    }
  }
};
