import status from "http-status";
import { isValidObjectId, Types } from "mongoose";
import AppError from "../../errors/AppError.js";
import { requireRole, resolveFarm } from "../../utils/farmAccess.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { UserModel } from "../auth/auth.model.js";
import { FarmModel } from "../farm/farm.model.js";
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";
import { DAY_MS, isBlank, pageMeta, parseCalendarDate, parseEnum, parsePaging } from "../feedRecord/feedRecord.utils.js";
import type { TPayload } from "../feedRecord/feedRecord.utils.js";
import {
  AUDIT_DEFAULT_DAYS,
  AUDIT_MAX_DAYS,
  AUDIT_MAX_LIMIT,
  AuditActions,
  AuditDeviceTypes,
  AuditEntityTypes,
  AuditModules,
  AuditStatuses,
} from "./auditLog.constants.js";
import { AuditLogModel } from "./auditLog.model.js";

const READ_ROLES = [FarmMemberRoles.OWNER, FarmMemberRoles.MANAGER];
const READ_MESSAGE = "Only the farm owner or a manager can read the audit log!";

//what each reader may not see (the audit trail itself never hides a row)
const MANAGER_HIDDEN = "-ipAddress -userAgent -browser -operatingSystem -location";
const ADMIN_HIDDEN = "-ipAddress -location";

type TFilter = Record<string, unknown>;
type TScope = { filter: TFilter; hidden: string };

const farmScope = async (farmId: string, requester: string): Promise<TScope> => {
  const access = await resolveFarm(farmId, requester);
  requireRole(access, READ_ROLES, READ_MESSAGE);
  return {
    filter: { farmId: access.farm._id },
    hidden: access.role === FarmMemberRoles.OWNER ? "" : MANAGER_HIDDEN,
  };
};

const platformScope = async (requester: string): Promise<TScope> => {
  const user = await UserModel.findOne({ userId: requester, isActive: true, isDeleted: false }).select("systemRole").lean();
  if (user?.systemRole === SystemRoles.SUPER_ADMIN) return { filter: {}, hidden: "" };
  if (user?.systemRole === SystemRoles.ADMIN) return { filter: {}, hidden: ADMIN_HIDDEN };
  throw new AppError(status.FORBIDDEN, "Only a platform administrator can read the platform audit log!");
};

const text = (field: string, value: unknown): string => {
  if (typeof value !== "string" || value.length > 100) throw new AppError(status.BAD_REQUEST, `${field} is invalid!`);
  return value.trim();
};

/** `_id` or U-… ; an unknown user matches nothing. "system" = rows without a user. */
const resolveUserRef = async (value: unknown): Promise<Types.ObjectId | null> => {
  const ref = text("user", value);
  if (ref === "system") return null;
  if (isValidObjectId(ref)) return new Types.ObjectId(ref);
  const user = await UserModel.findOne({ userId: ref }).select("_id").lean();
  return (user?._id as Types.ObjectId | undefined) ?? new Types.ObjectId();
};

const parseRange = (query: TPayload, useDefault: boolean): TFilter => {
  if (isBlank(query.from) && isBlank(query.to) && !useDefault) return {};
  const to = isBlank(query.to) ? new Date() : new Date(parseCalendarDate("to", query.to).getTime() + DAY_MS - 1);
  const from = isBlank(query.from)
    ? new Date(to.getTime() - AUDIT_DEFAULT_DAYS * DAY_MS)
    : parseCalendarDate("from", query.from);
  if (from > to) throw new AppError(status.BAD_REQUEST, "from must be before to!");
  if (to.getTime() - from.getTime() > AUDIT_MAX_DAYS * DAY_MS) {
    throw new AppError(status.BAD_REQUEST, `The date range cannot exceed ${AUDIT_MAX_DAYS} days!`);
  }
  return { createdAt: { $gte: from, $lte: to } };
};

const ENUM_FILTERS: [string, Record<string, string>][] = [
  ["entityType", AuditEntityTypes],
  ["action", AuditActions],
  ["module", AuditModules],
  ["status", AuditStatuses],
  ["deviceType", AuditDeviceTypes],
];

/** Only these query keys reach MongoDB, each one parsed to a plain value. */
const buildFilter = async (query: TPayload, useDefaultRange = true): Promise<TFilter> => {
  const filter: TFilter = parseRange(query, useDefaultRange);
  for (const [field, values] of ENUM_FILTERS) {
    if (!isBlank(query[field])) filter[field] = parseEnum(field, query[field], Object.values(values));
  }
  if (!isBlank(query.entityId)) {
    const id = text("entityId", query.entityId);
    if (!isValidObjectId(id)) throw new AppError(status.BAD_REQUEST, "entityId must be a valid id!");
    filter.entityId = new Types.ObjectId(id);
  }
  if (!isBlank(query.requestId)) filter.requestId = text("requestId", query.requestId);
  if (!isBlank(query.user)) filter.userId = await resolveUserRef(query.user);
  return filter;
};

const USER_FIELDS = "userId fullName profilePicture";

const list = async (scope: TScope, filter: TFilter, query: TPayload) => {
  const { page, limit, skip } = parsePaging(query, AUDIT_MAX_LIMIT, 20);
  //the scope is spread last: no filter can widen it
  const where = { ...filter, ...scope.filter };
  const [total, logs] = await Promise.all([
    AuditLogModel.countDocuments(where),
    AuditLogModel.find(where)
      .select(`-__v ${scope.hidden}`.trim())
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .populate("userId", USER_FIELDS)
      .populate("farmId", "farmId farmName")
      .lean(),
  ]);
  return { meta: pageMeta(page, limit, total), logs };
};

const detail = async (scope: TScope, ref: string) => {
  const isNumber = /^LOG-\d{1,15}$/i.test(ref);
  if (!isNumber && !isValidObjectId(ref)) {
    throw new AppError(status.BAD_REQUEST, "Use an audit log _id or a number like LOG-000001!");
  }
  const log = await AuditLogModel.findOne({
    ...(isNumber ? { logNo: ref.toUpperCase() } : { _id: new Types.ObjectId(ref) }),
    ...scope.filter,
  })
    .select(`-__v ${scope.hidden}`.trim())
    .populate("userId", USER_FIELDS)
    .populate("farmId", "farmId farmName")
    .lean();
  if (!log) throw new AppError(status.NOT_FOUND, "Audit log not found!");
  return log;
};

const getFarmLogs = async (farmId: string, requester: string, query: TPayload) =>
  list(await farmScope(farmId, requester), await buildFilter(query), query);

const getFarmLog = async (farmId: string, requester: string, ref: string) =>
  detail(await farmScope(farmId, requester), ref);

/** History of one record: without dates, the whole history (paged). */
const getEntityLogs = async (farmId: string, requester: string, entityType: string, entityId: string, query: TPayload) =>
  list(
    await farmScope(farmId, requester),
    await buildFilter({ ...query, entityType, entityId }, false),
    query,
  );

const getUserLogs = async (farmId: string, requester: string, user: string, query: TPayload) =>
  list(await farmScope(farmId, requester), await buildFilter({ ...query, user }), query);

/** Tiles of the list screen; same filters as the list, `today` is the current UTC day. */
const getSummary = async (farmId: string, requester: string, query: TPayload) => {
  const scope = await farmScope(farmId, requester);
  const where = { ...(await buildFilter(query)), ...scope.filter };
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const count = (extra: TFilter) => AuditLogModel.countDocuments({ $and: [where, extra] });
  const [total, todayCount, failed, finance, deletions, exports] = await Promise.all([
    count({}),
    AuditLogModel.countDocuments({ ...scope.filter, createdAt: { $gte: today } }),
    count({ status: { $ne: AuditStatuses.SUCCESS } }),
    count({ module: AuditModules.FINANCE }),
    count({ action: AuditActions.DELETE }),
    count({ action: AuditActions.EXPORT }),
  ]);
  return { total, today: todayCount, failed, finance, deletions, exports };
};

const getMeta = async (farmId: string, requester: string) => {
  await farmScope(farmId, requester);
  return {
    entityTypes: Object.values(AuditEntityTypes),
    actions: Object.values(AuditActions),
    modules: Object.values(AuditModules),
    statuses: Object.values(AuditStatuses),
    deviceTypes: Object.values(AuditDeviceTypes),
    defaultDays: AUDIT_DEFAULT_DAYS,
    maxDays: AUDIT_MAX_DAYS,
    maxLimit: AUDIT_MAX_LIMIT,
  };
};

/** Every farm plus the account history; `farm` narrows it, `farm=none` = rows without a farm. */
const getPlatformLogs = async (requester: string, query: TPayload) => {
  const scope = await platformScope(requester);
  const filter = await buildFilter(query);
  if (!isBlank(query.farm)) {
    const ref = text("farm", query.farm);
    if (ref === "none") filter.farmId = null;
    else if (isValidObjectId(ref)) filter.farmId = new Types.ObjectId(ref);
    else {
      const farm = await FarmModel.findOne({ farmId: ref }).select("_id").lean();
      filter.farmId = farm?._id ?? new Types.ObjectId();
    }
  }
  return list(scope, filter, query);
};

const getPlatformLog = async (requester: string, ref: string) => detail(await platformScope(requester), ref);

export const AuditLogServices = {
  getFarmLogs,
  getFarmLog,
  getEntityLogs,
  getUserLogs,
  getSummary,
  getMeta,
  getPlatformLogs,
  getPlatformLog,
};
