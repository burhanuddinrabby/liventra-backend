import { AsyncLocalStorage } from "async_hooks";
import type { Request } from "express";
import { Types } from "mongoose";
import type { ClientSession } from "mongoose";
import { emitToAuditRoom } from "../../realtime/realtime.js";
import { UserModel } from "../auth/auth.model.js";
import { AUDIT_LOG_NO_PREFIX, AuditDeviceTypes, AuditStatuses } from "./auditLog.constants.js";
import { AuditCounterModel, AuditLogModel } from "./auditLog.model.js";
import { sanitizeForAudit } from "./auditLog.sanitize.js";
import type {
  TAuditAction,
  TAuditDeviceType,
  TAuditEntityType,
  TAuditModule,
  TAuditStatus,
} from "./auditLog.interface.js";

//example: LOG-000001 (atomic counter, safe under concurrent writes; never inside a
//transaction, where every writer would conflict on this one document; gaps are harmless)
const generateLogNo = async (): Promise<string> => {
  const counter = await AuditCounterModel.findOneAndUpdate(
    { _id: "auditLog" },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  return `${AUDIT_LOG_NO_PREFIX}-${String(counter?.seq ?? 1).padStart(6, "0")}`;
};

const detectDeviceType = (userAgent?: string): TAuditDeviceType => {
  if (!userAgent) return AuditDeviceTypes.API;
  if (/ipad|tablet/i.test(userAgent)) return AuditDeviceTypes.TABLET;
  if (/mobi|android|iphone/i.test(userAgent)) return AuditDeviceTypes.MOBILE;
  if (/mozilla|chrome|safari|firefox|edge/i.test(userAgent)) return AuditDeviceTypes.DESKTOP;
  return AuditDeviceTypes.API;
};

//first match wins: Edge and Opera also say "Chrome", Chrome also says "Safari"
const BROWSERS: [RegExp, string][] = [
  [/edg(e|a|ios)?\//i, "Edge"],
  [/opr\/|opera/i, "Opera"],
  [/samsungbrowser/i, "Samsung Internet"],
  [/firefox|fxios/i, "Firefox"],
  [/chrome|crios/i, "Chrome"],
  [/safari/i, "Safari"],
];
const SYSTEMS: [RegExp, string][] = [
  [/windows/i, "Windows"],
  [/android/i, "Android"],
  [/iphone|ipad|ipod/i, "iOS"],
  [/mac os|macintosh/i, "macOS"],
  [/linux/i, "Linux"],
];
const firstMatch = (list: [RegExp, string][], userAgent?: string) =>
  userAgent ? list.find(([pattern]) => pattern.test(userAgent))?.[1] : undefined;

//request metadata stored with each audit row (never the token or request body)
export type TAuditContext = {
  //custom string userId from the JWT (U-YY-NNNN); resolved to the User _id on write
  actorUserId?: string;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
};

export const auditContextFromRequest = (req: Request): TAuditContext => {
  const context: TAuditContext = {};
  const actor = req.user?.userId as string | undefined;
  if (actor) context.actorUserId = actor;
  if (req.ip) context.ipAddress = req.ip;
  const userAgent = req.get("user-agent");
  if (userAgent) context.userAgent = userAgent.slice(0, 300);
  if (req.requestId) context.requestId = req.requestId;
  return context;
};

export type TRecordAuditInput = {
  context?: TAuditContext | undefined;
  farmId?: Types.ObjectId | string | null;
  entityType: TAuditEntityType;
  entityId?: Types.ObjectId | string | null;
  action: TAuditAction;
  module: TAuditModule;
  event?: string;
  oldData?: Record<string, unknown> | null;
  newData?: Record<string, unknown> | null;
  changedFields?: string[];
  status?: TAuditStatus;
  /**
   * Passed (even as null = standalone MongoDB): the row belongs to the business change and
   * a failed write throws. Left out: best effort.
   */
  session?: ClientSession | null;
};

//everything recorded inside withAuditSession() belongs to that transaction
const auditScope = new AsyncLocalStorage<{ session: ClientSession | null }>();

/** Runs audit calls as part of the caller's transaction (see `session` above). */
export const withAuditSession = <T>(session: ClientSession | null, work: () => Promise<T>): Promise<T> =>
  auditScope.run({ session }, work);

type TAuditEvent = { farmId: Types.ObjectId; payload: object };

//live events wait for the commit; a retried transaction starts with an empty list
const pendingEvents = new WeakMap<ClientSession, TAuditEvent[]>();

export const beginAuditAttempt = (session: ClientSession): void => {
  pendingEvents.set(session, []);
};

export const publishCommittedAudits = (session: ClientSession): void => {
  for (const event of pendingEvents.get(session) ?? []) emitToAuditRoom(event.farmId, "audit.created", event.payload);
  pendingEvents.delete(session);
};

const writeAuditRow = async (input: TRecordAuditInput, session: ClientSession | null): Promise<void> => {
  const { context } = input;
  let userObjectId: Types.ObjectId | null = null;
  if (context?.actorUserId) {
    const actor = await UserModel.findOne({ userId: context.actorUserId }).select("_id").lean();
    userObjectId = (actor?._id as Types.ObjectId | undefined) ?? null;
  }

  const userAgent = context?.userAgent;
  const browser = firstMatch(BROWSERS, userAgent);
  const operatingSystem = firstMatch(SYSTEMS, userAgent);
  const farmId = input.farmId ? new Types.ObjectId(String(input.farmId)) : null;

  const [row] = await AuditLogModel.create(
    [
      {
        logNo: await generateLogNo(),
        farmId,
        userId: userObjectId,
        entityType: input.entityType,
        entityId: input.entityId ? new Types.ObjectId(String(input.entityId)) : null,
        action: input.action,
        module: input.module,
        ...(input.event ? { event: input.event } : {}),
        oldData: sanitizeForAudit(input.oldData),
        newData: sanitizeForAudit(input.newData),
        changedFields: input.changedFields ?? [],
        ...(context?.ipAddress ? { ipAddress: context.ipAddress } : {}),
        ...(userAgent ? { userAgent } : {}),
        deviceType: detectDeviceType(userAgent),
        ...(browser ? { browser } : {}),
        ...(operatingSystem ? { operatingSystem } : {}),
        ...(context?.requestId ? { requestId: context.requestId } : {}),
        status: input.status ?? AuditStatuses.SUCCESS,
      },
    ],
    session ? { session } : {},
  );
  if (!row || !farmId) return;

  const event: TAuditEvent = {
    farmId,
    payload: {
      logId: row._id.toString(),
      logNo: row.logNo,
      entityType: row.entityType,
      entityId: row.entityId?.toString() ?? null,
      action: row.action,
      module: row.module,
      status: row.status,
      createdAt: row.createdAt,
    },
  };
  const waiting = session ? pendingEvents.get(session) : undefined;
  if (waiting) waiting.push(event);
  else emitToAuditRoom(event.farmId, "audit.created", event.payload);
};

/**
 * Writes one audit row. Inside withAuditSession() (or with `session`) it is part of the
 * business change and throws on failure; otherwise it is best effort, because the change
 * is already committed.
 */
export const recordAuditLog = async (input: TRecordAuditInput): Promise<void> => {
  const scope = input.session !== undefined ? { session: input.session } : auditScope.getStore();
  if (scope) {
    await writeAuditRow(input, scope.session);
    return;
  }
  try {
    await writeAuditRow(input, null);
  } catch (error) {
    console.error("Failed to write audit log:", error);
  }
};

/** After an abort, outside the transaction: the Success row was rolled back with the change. */
export const recordRolledBack = (trace: TRecordAuditInput): Promise<void> =>
  auditScope.exit(() => recordAuditLog({ ...trace, status: AuditStatuses.ROLLED_BACK }));

const THROTTLE_MS = 60_000;
const MAX_THROTTLE_KEYS = 5_000;
const recent = new Map<string, number>();

/** True at most once a minute per key: refused requests must not flood the log. */
export const allowAuditOnce = (throttleKey: string): boolean => {
  const now = Date.now();
  if (now - (recent.get(throttleKey) ?? 0) < THROTTLE_MS) return false;
  if (recent.size >= MAX_THROTTLE_KEYS) {
    for (const [entry, at] of recent) if (now - at >= THROTTLE_MS) recent.delete(entry);
    //still full of fresh keys: an attack; keep memory bounded
    if (recent.size >= MAX_THROTTLE_KEYS) recent.clear();
  }
  recent.set(throttleKey, now);
  return true;
};
