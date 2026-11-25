import status from "http-status";
import { isValidObjectId, Types } from "mongoose";
import AppError from "../../errors/AppError.js";
import { requireRole, requireWritableFarm, resolveFarm } from "../../utils/farmAccess.js";
import type { TFarmContext } from "../../utils/farmAccess.js";
import { AuditActions, AuditEntityTypes, AuditModules, AuditStatuses } from "../auditLog/auditLog.constants.js";
import { AuditLogModel } from "../auditLog/auditLog.model.js";
import { recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext, TRecordAuditInput } from "../auditLog/auditLog.utils.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { UserModel } from "../auth/auth.model.js";
import { FarmModel } from "../farm/farm.model.js";
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";
import { FarmMemberModel } from "../farmMember/farmMember.model.js";
import {
  DAY_MS,
  executeAtomically,
  isBlank,
  pageMeta,
  parseCalendarDate,
  parseEnum,
  parsePaging,
} from "../feedRecord/feedRecord.utils.js";
import type { TPayload } from "../feedRecord/feedRecord.utils.js";
import {
  ANNOUNCEMENT_DEFAULT_DAYS,
  ANNOUNCEMENT_EVENT,
  ANNOUNCEMENT_MAX_DAYS,
  ANNOUNCEMENT_PRIORITIES,
  ANNOUNCEMENTS_PER_HOUR,
  NOTIFICATION_MAX_LIMIT,
  NotificationPriorities,
  NotificationReferenceTypes,
  NotificationStatuses,
  NotificationTypes,
} from "./notification.constants.js";
import { emitCreated, emitUpdated, loadAudience, recipientsOf } from "./notification.delivery.js";
import type { TNotification } from "./notification.interface.js";
import { generateNotificationNo, NotificationModel } from "./notification.model.js";

const { OWNER, MANAGER } = FarmMemberRoles;
const { ACTIVE, ARCHIVED } = NotificationStatuses;

type TFilter = Record<string, unknown>;

/** Own rows of farms the user can open right now (removed members see nothing). */
const myFarmsScope = async (requester: string): Promise<TFilter> => {
  const user = await UserModel.findOne({ userId: requester, isActive: true, isDeleted: false }).select("_id systemRole").lean();
  if (!user) throw new AppError(status.FORBIDDEN, "Only an active user can read notifications!");
  if (user.systemRole === SystemRoles.SUPER_ADMIN) return { userId: user._id };
  const [owned, memberOf] = await Promise.all([
    FarmModel.find({ ownerId: user._id }).distinct("_id"),
    FarmMemberModel.find({ userId: user._id, isActive: true }).distinct("farmId"),
  ]);
  return { userId: user._id, farmId: { $in: [...owned, ...memberOf] } };
};

const farmScope = (access: TFarmContext): TFilter => ({ farmId: access.farm._id, userId: access.user._id });

//an Active row past its expiry is hidden even before the expire job has run
const stillActive = (): TFilter => ({
  status: ACTIVE,
  $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
});

const buildFilter = (query: TPayload): TFilter => {
  const wanted = isBlank(query.status) ? ACTIVE : parseEnum("status", query.status, Object.values(NotificationStatuses));
  const filter: TFilter = wanted === ACTIVE ? stillActive() : { status: wanted };
  if (!isBlank(query.isRead)) filter.isRead = parseEnum("isRead", query.isRead, ["true", "false"]) === "true";
  if (!isBlank(query.type)) filter.type = parseEnum("type", query.type, Object.values(NotificationTypes));
  if (!isBlank(query.priority)) filter.priority = parseEnum("priority", query.priority, Object.values(NotificationPriorities));
  if (!isBlank(query.referenceType)) {
    filter.referenceType = parseEnum("referenceType", query.referenceType, Object.values(NotificationReferenceTypes));
  }
  return filter;
};

const FARM_FIELDS = "farmId farmName";

const list = async (scope: TFilter, query: TPayload) => {
  const { page, limit, skip } = parsePaging(query, NOTIFICATION_MAX_LIMIT, 20);
  //the scope is spread last: no filter can widen it
  const where = { ...buildFilter(query), ...scope };
  const [total, notifications] = await Promise.all([
    NotificationModel.countDocuments(where),
    NotificationModel.find(where)
      .select("-__v -userId")
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .populate("farmId", FARM_FIELDS)
      .lean(),
  ]);
  return { meta: pageMeta(page, limit, total), notifications };
};

const getFarmNotifications = async (farmId: string, requester: string, query: TPayload) =>
  list(farmScope(await resolveFarm(farmId, requester)), query);

const getMyNotifications = async (requester: string, query: TPayload) =>
  isBlank(query.farmId)
    ? list(await myFarmsScope(requester), query)
    : getFarmNotifications(String(query.farmId), requester, query);

/** Badge numbers. `critical` counts open Critical rows, read or not. */
const getUnreadCount = async (requester: string) => {
  const rows = await NotificationModel.aggregate<{ _id: Types.ObjectId; unread: number; critical: number }>([
    { $match: { ...stillActive(), ...(await myFarmsScope(requester)) } },
    {
      $group: {
        _id: "$farmId",
        unread: { $sum: { $cond: ["$isRead", 0, 1] } },
        critical: { $sum: { $cond: [{ $eq: ["$priority", NotificationPriorities.CRITICAL] }, 1, 0] } },
      },
    },
  ]);
  const farms = await FarmModel.find({ _id: { $in: rows.map((row) => row._id) } })
    .select(FARM_FIELDS)
    .lean();
  const farmOf = new Map(farms.map((farm) => [String(farm._id), farm]));
  return {
    total: rows.reduce((sum, row) => sum + row.unread, 0),
    critical: rows.reduce((sum, row) => sum + row.critical, 0),
    farms: rows.map((row) => ({
      _id: row._id,
      farmId: farmOf.get(String(row._id))?.farmId ?? null,
      farmName: farmOf.get(String(row._id))?.farmName ?? null,
      unread: row.unread,
      critical: row.critical,
    })),
  };
};

/** Someone else's id answers 404, exactly like an unknown one. */
const findOwn = async (access: TFarmContext, ref: string) => {
  const isNumber = /^NOT-\d{4}-\d{1,12}$/i.test(ref);
  const row =
    isNumber || isValidObjectId(ref)
      ? await NotificationModel.findOne({
          ...(isNumber ? { notificationNo: ref.toUpperCase() } : { _id: new Types.ObjectId(ref) }),
          ...farmScope(access),
        }).lean()
      : null;
  if (!row) throw new AppError(status.NOT_FOUND, "Notification not found!");
  return row;
};

const view = (id: Types.ObjectId) =>
  NotificationModel.findById(id).select("-__v -userId").populate("farmId", FARM_FIELDS).lean();

const getNotification = async (farmId: string, requester: string, ref: string) => {
  const row = await findOwn(await resolveFarm(farmId, requester), ref);
  return view(row._id);
};

const setRead = async (farmId: string, requester: string, ref: string, isRead: boolean) => {
  const access = await resolveFarm(farmId, requester);
  const row = await findOwn(access, ref);
  if (row.isRead !== isRead) {
    await NotificationModel.updateOne(
      { _id: row._id, ...farmScope(access) },
      { $set: { isRead, readAt: isRead ? new Date() : null } },
    );
    emitUpdated([access.user._id]);
  }
  return view(row._id);
};

/** Reading never dismisses a Critical row: it stays Active until the Owner archives it. */
const markAllRead = async (farmId: string, requester: string) => {
  const access = await resolveFarm(farmId, requester);
  const result = await NotificationModel.updateMany(
    { ...farmScope(access), status: ACTIVE, isRead: false },
    { $set: { isRead: true, readAt: new Date() } },
  );
  if (result.modifiedCount) emitUpdated([access.user._id]);
  return { updated: result.modifiedCount };
};

const archive = async (farmId: string, requester: string, ref: string, context: TAuditContext) => {
  const access = await resolveFarm(farmId, requester);
  const row = await findOwn(access, ref);
  requireRole(access, [OWNER, MANAGER], "Only the farm owner or a manager can archive notifications!");
  const critical = row.priority === NotificationPriorities.CRITICAL;
  if (critical) requireRole(access, [OWNER], "Only the farm owner can resolve a critical notification!");
  if (row.status === ARCHIVED) return view(row._id);
  if (row.status !== ACTIVE) throw new AppError(status.CONFLICT, "An expired notification cannot be archived!");

  //a Critical event is resolved once, for everybody who was told
  const target: TFilter = critical
    ? {
        farmId: row.farmId,
        referenceType: row.referenceType,
        referenceId: row.referenceId ?? null,
        title: row.title,
        ...(row.referenceId ? {} : { message: row.message }),
        status: ACTIVE,
      }
    : { _id: row._id, status: ACTIVE };
  const rows = await NotificationModel.find(target).select("_id userId").lean();
  const ids = rows.map((item) => item._id);

  const entry: TRecordAuditInput = {
    context,
    farmId: row.farmId,
    entityType: AuditEntityTypes.NOTIFICATION,
    entityId: row._id,
    action: AuditActions.ARCHIVE,
    module: AuditModules.FARM,
    event: critical ? "Critical Notification Resolved" : "Notification Archived",
    oldData: { status: ACTIVE },
    newData: { status: ARCHIVED, notificationNo: row.notificationNo, title: row.title, recipients: rows.length },
    changedFields: ["status"],
  };
  await executeAtomically(
    async (session, undo) => {
      undo.push(() =>
        NotificationModel.updateMany({ _id: { $in: ids }, status: ARCHIVED }, { $set: { status: ACTIVE } }),
      );
      await NotificationModel.updateMany(
        { _id: { $in: ids }, status: ACTIVE },
        { $set: { status: ARCHIVED } },
        session ? { session } : {},
      );
    },
    { trace: entry, log: () => recordAuditLog(entry) },
  );
  emitUpdated(rows.map((item) => item.userId));
  return view(row._id);
};

const announce = async (farmId: string, requester: string, body: TPayload, context: TAuditContext) => {
  const access = await resolveFarm(farmId, requester);
  requireRole(access, [OWNER, MANAGER], "Only the farm owner or a manager can send announcements!");
  requireWritableFarm(access);

  //shape and lengths are checked by the route validation
  const title = String(body.title).trim();
  const message = String(body.message).trim();
  const roles = [...new Set(body.roles as string[])];
  const priority = isBlank(body.priority)
    ? NotificationPriorities.MEDIUM
    : (parseEnum("priority", body.priority, ANNOUNCEMENT_PRIORITIES) as TNotification["priority"]);

  const now = Date.now();
  //the chosen day is included
  const expiresAt = isBlank(body.expiresAt)
    ? new Date(now + ANNOUNCEMENT_DEFAULT_DAYS * DAY_MS)
    : new Date(parseCalendarDate("expiresAt", body.expiresAt).getTime() + DAY_MS);
  if (expiresAt.getTime() <= now) throw new AppError(status.BAD_REQUEST, "expiresAt cannot be in the past!");
  if (expiresAt.getTime() > now + (ANNOUNCEMENT_MAX_DAYS + 1) * DAY_MS) {
    throw new AppError(status.BAD_REQUEST, `expiresAt cannot be more than ${ANNOUNCEMENT_MAX_DAYS} days away!`);
  }

  //the audit row is written in the same unit of work, so it is an exact count of sent announcements
  const recent = await AuditLogModel.countDocuments({
    farmId: access.farm._id,
    createdAt: { $gt: new Date(now - 60 * 60 * 1000) },
    entityType: AuditEntityTypes.NOTIFICATION,
    event: ANNOUNCEMENT_EVENT,
    status: AuditStatuses.SUCCESS,
  });
  if (recent >= ANNOUNCEMENTS_PER_HOUR) {
    throw new AppError(
      status.TOO_MANY_REQUESTS,
      `At most ${ANNOUNCEMENTS_PER_HOUR} announcements per hour can be sent on one farm!`,
    );
  }

  const audience = await loadAudience(access.farm._id);
  const recipients = audience ? recipientsOf(audience, roles) : [];
  if (!recipients.length) throw new AppError(status.UNPROCESSABLE_ENTITY, "No active member has one of the chosen roles!");

  const rows: (TNotification & { _id: Types.ObjectId })[] = [];
  for (const userId of recipients) {
    rows.push({
      _id: new Types.ObjectId(),
      notificationNo: await generateNotificationNo(),
      farmId: access.farm._id,
      userId,
      title,
      message,
      type: NotificationTypes.INFORMATION,
      priority,
      referenceType: NotificationReferenceTypes.MANUAL,
      referenceId: null,
      isRead: false,
      readAt: null,
      expiresAt,
      status: ACTIVE,
    });
  }
  const entry: TRecordAuditInput = {
    context,
    farmId: access.farm._id,
    entityType: AuditEntityTypes.NOTIFICATION,
    entityId: rows[0]?._id ?? null,
    action: AuditActions.CREATE,
    module: AuditModules.FARM,
    event: ANNOUNCEMENT_EVENT,
    newData: { title, message, roles, priority, expiresAt, recipients: rows.length },
  };
  await executeAtomically(
    async (session, undo) => {
      undo.push(() => NotificationModel.deleteMany({ _id: { $in: rows.map((row) => row._id) } }));
      await NotificationModel.insertMany(rows, session ? { session } : {});
    },
    { trace: entry, log: () => recordAuditLog(entry) },
  );
  for (const row of rows) emitCreated(row);
  return { title, message, roles, priority, expiresAt, recipients: rows.length };
};

export const NotificationServices = {
  getMyNotifications,
  getFarmNotifications,
  getUnreadCount,
  getNotification,
  setRead,
  markAllRead,
  archive,
  announce,
};
