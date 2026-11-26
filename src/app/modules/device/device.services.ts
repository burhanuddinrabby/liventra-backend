import status from "http-status";
import { isValidObjectId, Types } from "mongoose";
import type { ClientSession } from "mongoose";
import AppError from "../../errors/AppError.js";
import { requireRole, requireWritableFarm, resolveFarm } from "../../utils/farmAccess.js";
import type { TFarmContext } from "../../utils/farmAccess.js";
import { AuditActions, AuditEntityTypes, AuditModules } from "../auditLog/auditLog.constants.js";
import type { TAuditAction } from "../auditLog/auditLog.interface.js";
import { AuditLogServices } from "../auditLog/auditLog.services.js";
import { recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext, TRecordAuditInput } from "../auditLog/auditLog.utils.js";
import {
  escapeRegex,
  executeAtomically,
  isBlank,
  pageMeta,
  parseCalendarDate,
  parseEnum,
  parseEnumList,
  parseNumber,
  parsePaging,
} from "../feedRecord/feedRecord.utils.js";
import type { TPayload, TUndo } from "../feedRecord/feedRecord.utils.js";
import { NotificationProducers } from "../notification/notification.producers.js";
import {
  BATTERY_CRITICAL,
  BATTERY_LOW,
  BatteryStates,
  BatteryTypes,
  CommunicationProtocols,
  ConnectionStatuses,
  DASHBOARD_LIST_LIMIT,
  DEVICE_CODE_PATTERN,
  DEVICE_MAX_LIMIT,
  DEVICE_SORT_FIELDS,
  DeviceHealthStatuses,
  DevicePermissions,
  DeviceTypes,
  IDENTITY_FIELDS,
  MAX_FIRMWARE,
  MAX_NAME,
  MAX_NOTES,
  MAX_REASON,
  MAX_SERIAL,
  OFFLINE_AFTER_HOURS,
  RemovalReasons,
  WARRANTY_SOON_DAYS,
  WarrantyStates,
} from "./device.constants.js";
import type { TDevice, TDeviceDoc } from "./device.interface.js";
import { MANUAL_REMOVAL_REASONS } from "../deviceAssignment/deviceAssignment.constants.js";
import type { TRemovalReason } from "../deviceAssignment/deviceAssignment.interface.js";
import { closeDeviceAssignment } from "../deviceAssignment/deviceAssignment.utils.js";
import {
  activeAssignmentsOf,
  assignedDeviceIds,
  countDeviceHistory,
  hasActiveAssignment,
  latestReadingOf,
} from "./device.links.js";
import { DeviceModel, generateDeviceCode } from "./device.model.js";
import { appToday, warrantyLimit, withDerived } from "./device.utils.js";

const { OFFLINE, ONLINE, DISCONNECTED, MAINTENANCE } = ConnectionStatuses;

type TFilter = Record<string, unknown>;

const bad = (message: string) => new AppError(status.BAD_REQUEST, message);
const conflict = (message: string) => new AppError(status.CONFLICT, message);
const CHANGED_MEANWHILE = "This device was changed by someone else. Reload and try again!";
const sessionOpts = (session: ClientSession | null) => (session ? { session } : {});

/* ---------- access ---------- */

const readAccess = async (farmId: string, requester: string): Promise<TFarmContext> => {
  const access = await resolveFarm(farmId, requester);
  requireRole(access, DevicePermissions.READ, "Your farm role cannot see devices!");
  return access;
};

const writeAccess = async (farmId: string, requester: string): Promise<TFarmContext> => {
  const access = await resolveFarm(farmId, requester);
  requireRole(access, DevicePermissions.WRITE, "Only the farm owner or a manager can change devices!");
  requireWritableFarm(access);
  return access;
};

const ownerAccess = async (farmId: string, requester: string): Promise<TFarmContext> => {
  const access = await resolveFarm(farmId, requester);
  requireRole(access, DevicePermissions.OWNER, "Only the farm owner can do this!");
  requireWritableFarm(access);
  return access;
};

/** `_id` or DEV-000001; a device of another farm answers like an unknown one. */
const findDevice = async (access: TFarmContext, ref: string): Promise<TDeviceDoc> => {
  const isCode = DEVICE_CODE_PATTERN.test(ref);
  const device =
    isCode || isValidObjectId(ref)
      ? await DeviceModel.findOne({
          ...(isCode ? { deviceCode: ref.toUpperCase() } : { _id: new Types.ObjectId(ref) }),
          farmId: access.farm._id,
        })
          .select("-__v")
          .lean()
      : null;
  if (!device) throw new AppError(status.NOT_FOUND, "Device not found!");
  return device;
};

/* ---------- field parsing ---------- */

const parseText = (field: string, value: unknown, max: number): string | null => {
  if (isBlank(value)) return null;
  if (typeof value !== "string") throw bad(`${field} must be text!`);
  const text = field === "notes" ? value.trim() : value.trim().replace(/\s+/g, " ");
  if (text.length > max) throw bad(`${field} cannot exceed ${max} characters!`);
  return text;
};

const requireText = (field: string, value: unknown, max: number): string => {
  const text = parseText(field, value, max);
  if (!text) throw bad(`${field} is required!`);
  return text;
};

const parseReason = (value: unknown): string => {
  const text = requireText("reason", value, MAX_REASON);
  if (text.length < 3) throw bad("reason must be at least 3 characters!");
  return text;
};

const parseDay = (field: string, value: unknown) => (isBlank(value) ? null : parseCalendarDate(field, value));

// eslint-disable-next-line no-unused-vars
const FIELD_PARSERS: Record<string, (value: unknown) => unknown> = {
  company: (v) => requireText("company", v, MAX_NAME),
  model: (v) => requireText("model", v, MAX_NAME),
  serialNumber: (v) => requireText("serialNumber", v, MAX_SERIAL).toUpperCase(),
  deviceType: (v) => parseEnum("deviceType", v, Object.values(DeviceTypes)),
  communicationProtocol: (v) =>
    isBlank(v) ? null : parseEnum("communicationProtocol", v, Object.values(CommunicationProtocols)),
  firmwareVersion: (v) => parseText("firmwareVersion", v, MAX_FIRMWARE),
  installationDate: (v) => parseDay("installationDate", v),
  purchaseDate: (v) => parseDay("purchaseDate", v),
  warrantyExpiry: (v) => parseDay("warrantyExpiry", v),
  batteryType: (v) => parseEnum("batteryType", v, Object.values(BatteryTypes)),
  batteryLevel: (v) => (isBlank(v) ? null : parseNumber("batteryLevel", v, { min: 0, max: 100 })),
  notes: (v) => parseText("notes", v, MAX_NOTES),
};
const REQUIRED_FIELDS = ["company", "model", "serialNumber", "deviceType", "batteryType"];

type TEditable = Omit<
  TDevice,
  "deviceCode" | "farmId" | "lastSyncAt" | "connectionStatus" | "healthStatus" | "isActive" | "createdBy" | "updatedBy"
>;

/** Only known fields that were sent. */
const parseFields = (body: TPayload): Partial<TEditable> =>
  Object.fromEntries(
    Object.entries(FIELD_PARSERS)
      .filter(([field]) => body[field] !== undefined)
      .map(([field, parse]) => [field, parse(body[field])]),
  );

/** Rules across fields, checked on the state that would be saved. */
const checkConsistency = (next: Partial<TEditable>): void => {
  const today = appToday();
  const { purchaseDate, installationDate, warrantyExpiry } = next;
  if (purchaseDate && purchaseDate > today) throw bad("purchaseDate cannot be in the future!");
  if (installationDate && installationDate > today) throw bad("installationDate cannot be in the future!");
  if (purchaseDate && installationDate && purchaseDate > installationDate) {
    throw bad("installationDate cannot be before purchaseDate!");
  }
  if (purchaseDate && warrantyExpiry && warrantyExpiry <= purchaseDate) {
    throw bad("warrantyExpiry must be after purchaseDate!");
  }
  if (next.batteryType === BatteryTypes.NOT_APPLICABLE && next.batteryLevel !== null && next.batteryLevel !== undefined) {
    throw bad("batteryLevel must be empty when batteryType is Not Applicable!");
  }
};

/** The unique index decides; the answer is the same for this farm and any other. */
const translateDuplicate = (error: unknown): never => {
  const { code, keyPattern } = error as { code?: number; keyPattern?: object };
  if (code === 11000 && keyPattern && "serialNumber" in keyPattern) {
    throw conflict("A device of this company with this serial number is already registered!");
  }
  throw error;
};

/* ---------- audit ---------- */

const AUDIT_FIELDS = ["deviceCode", ...Object.keys(FIELD_PARSERS), "connectionStatus", "healthStatus", "isActive"];

const snapshot = (device: object): Record<string, unknown> =>
  Object.fromEntries(AUDIT_FIELDS.map((field) => [field, (device as TPayload)[field] ?? null]));

const auditing = (
  access: TFarmContext,
  context: TAuditContext,
  entityId: Types.ObjectId,
  action: TAuditAction,
  event: string,
  data: Pick<TRecordAuditInput, "oldData" | "newData" | "changedFields">,
) => {
  const entry: TRecordAuditInput = {
    context,
    farmId: access.farm._id,
    entityType: AuditEntityTypes.DEVICE,
    entityId,
    action,
    module: AuditModules.FARM,
    event,
    ...data,
  };
  return { trace: entry, log: () => recordAuditLog(entry) };
};

const same = (a: unknown, b: unknown) =>
  (a instanceof Date ? a.getTime() : (a ?? null)) === (b instanceof Date ? b.getTime() : (b ?? null));

/**
 * Writes `changes` only when the document is still the one that was read, so two editors
 * never overwrite each other silently. The undo step restores the old values.
 */
const applyChanges = async (
  before: TDeviceDoc,
  changes: Partial<TDevice>,
  session: ClientSession | null,
  undo: TUndo,
): Promise<void> => {
  const result = await DeviceModel.updateOne(
    {
      _id: before._id,
      farmId: before.farmId,
      updatedAt: before.updatedAt,
      connectionStatus: before.connectionStatus,
      isActive: before.isActive,
    } as TFilter,
    { $set: changes },
    sessionOpts(session),
  );
  if (!result.matchedCount) throw conflict(CHANGED_MEANWHILE);
  const old = Object.fromEntries(Object.keys(changes).map((key) => [key, (before as TPayload)[key] ?? null]));
  undo.push(() => DeviceModel.updateOne({ _id: before._id }, { $set: old }));
};

/* ---------- reads ---------- */

const USER_FIELDS = "userId fullName";

const attachAssignments = async (farmId: Types.ObjectId, devices: TDeviceDoc[]) => {
  const open = await activeAssignmentsOf(farmId, devices.map((device) => device._id));
  const today = appToday();
  return devices.map((device) => ({
    ...withDerived(device, today),
    currentAssignment: open.get(String(device._id)) ?? null,
  }));
};

const detail = async (access: TFarmContext, id: Types.ObjectId) => {
  const device = await DeviceModel.findOne({ _id: id, farmId: access.farm._id })
    .select("-__v")
    .populate("createdBy", USER_FIELDS)
    .populate("updatedBy", USER_FIELDS)
    .lean();
  if (!device) throw new AppError(status.NOT_FOUND, "Device not found!");
  const [assignments, latestReading, usage] = await Promise.all([
    activeAssignmentsOf(access.farm._id, [id]),
    latestReadingOf(id),
    countDeviceHistory(id),
  ]);
  return {
    ...withDerived(device),
    currentAssignment: assignments.get(String(id)) ?? null,
    latestReading,
    usage,
    identityLocked: usage.assignments + usage.readings > 0,
  };
};

const getDevice = async (farmId: string, requester: string, ref: string) => {
  const access = await readAccess(farmId, requester);
  return detail(access, (await findDevice(access, ref))._id);
};

const warrantyFilter = (state: string, today: Date): TFilter => {
  const soon = warrantyLimit(today);
  switch (state) {
    case WarrantyStates.EXPIRED:
      return { warrantyExpiry: { $ne: null, $lt: today } };
    case WarrantyStates.EXPIRING:
      return { warrantyExpiry: { $gte: today, $lte: soon } };
    case WarrantyStates.ACTIVE:
      return { warrantyExpiry: { $gt: soon } };
    default:
      return { warrantyExpiry: null };
  }
};

const batteryFilter = (state: string): TFilter => {
  switch (state) {
    case BatteryStates.CRITICAL:
      return { batteryLevel: { $ne: null, $lte: BATTERY_CRITICAL } };
    case BatteryStates.LOW:
      return { batteryLevel: { $gt: BATTERY_CRITICAL, $lte: BATTERY_LOW } };
    case BatteryStates.NORMAL:
      return { batteryLevel: { $gt: BATTERY_LOW } };
    default:
      return { batteryLevel: null };
  }
};

const ENUM_FILTERS: [string, Record<string, string>][] = [
  ["deviceType", DeviceTypes],
  ["communicationProtocol", CommunicationProtocols],
  ["connectionStatus", ConnectionStatuses],
  ["healthStatus", DeviceHealthStatuses],
];

const parseQueryText = (field: string, value: unknown): string => {
  if (typeof value !== "string" || value.length > MAX_NAME) throw bad(`${field} is invalid!`);
  return value.trim();
};

/** Only these query keys reach MongoDB. */
const buildFilter = async (farmId: Types.ObjectId, query: TPayload): Promise<TFilter> => {
  const and: TFilter[] = [{ farmId }];
  for (const [field, values] of ENUM_FILTERS) {
    if (!isBlank(query[field])) and.push({ [field]: { $in: parseEnumList(field, query[field], Object.values(values)) } });
  }
  const active = isBlank(query.isActive) ? "true" : parseEnum("isActive", query.isActive, ["true", "false", "all"]);
  if (active !== "all") and.push({ isActive: active === "true" });
  if (!isBlank(query.company)) {
    and.push({ company: { $regex: `^${escapeRegex(parseQueryText("company", query.company))}$`, $options: "i" } });
  }
  if (!isBlank(query.warranty)) {
    and.push(warrantyFilter(parseEnum("warranty", query.warranty, Object.values(WarrantyStates)), appToday()));
  }
  if (!isBlank(query.battery)) {
    and.push(batteryFilter(parseEnum("battery", query.battery, Object.values(BatteryStates))));
  }
  if (!isBlank(query.assignment)) {
    const wanted = parseEnum("assignment", query.assignment, ["assigned", "free"]);
    const ids = await assignedDeviceIds(farmId);
    and.push({ _id: wanted === "assigned" ? { $in: ids } : { $nin: ids } });
  }
  if (!isBlank(query.searchTerm)) {
    const $regex = escapeRegex(parseQueryText("searchTerm", query.searchTerm));
    and.push({
      $or: ["deviceCode", "serialNumber", "company", "model"].map((field) => ({ [field]: { $regex, $options: "i" } })),
    });
  }
  return { $and: and };
};

const getDevices = async (farmId: string, requester: string, query: TPayload) => {
  const access = await readAccess(farmId, requester);
  const { page, limit, skip } = parsePaging(query, DEVICE_MAX_LIMIT, 20);
  const where = await buildFilter(access.farm._id, query);
  const raw = isBlank(query.sort) ? "-createdAt" : String(query.sort);
  const sortField = parseEnum("sort", raw.replace(/^-/, ""), DEVICE_SORT_FIELDS);
  const [total, devices] = await Promise.all([
    DeviceModel.countDocuments(where),
    DeviceModel.find(where)
      .select("-__v -notes")
      .sort({ [sortField]: raw.startsWith("-") ? -1 : 1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);
  return { meta: pageMeta(page, limit, total), devices: await attachAssignments(access.farm._id, devices) };
};

/** Scanner: exact serial number (companies may share one) or device code. */
const lookup = async (farmId: string, requester: string, query: TPayload) => {
  const access = await readAccess(farmId, requester);
  if (isBlank(query.serial)) throw bad("serial is required!");
  const text = parseQueryText("serial", query.serial).replace(/\s+/g, " ").toUpperCase();
  const devices = await DeviceModel.find({
    farmId: access.farm._id,
    $or: [{ serialNumber: text }, { deviceCode: text }],
  })
    .select("-__v -notes")
    .sort({ isActive: -1, _id: 1 })
    .limit(20)
    .lean();
  return attachAssignments(access.farm._id, devices);
};

const getMeta = async (farmId: string, requester: string) => {
  const access = await readAccess(farmId, requester);
  return {
    deviceTypes: Object.values(DeviceTypes),
    communicationProtocols: Object.values(CommunicationProtocols),
    batteryTypes: Object.values(BatteryTypes),
    connectionStatuses: Object.values(ConnectionStatuses),
    healthStatuses: Object.values(DeviceHealthStatuses),
    warrantyStates: Object.values(WarrantyStates),
    batteryStates: Object.values(BatteryStates),
    removalReasons: RemovalReasons,
    companies: (await DeviceModel.distinct("company", { farmId: access.farm._id })).sort(),
    limits: {
      batteryLow: BATTERY_LOW,
      batteryCritical: BATTERY_CRITICAL,
      warrantySoonDays: WARRANTY_SOON_DAYS,
      offlineAfterHours: OFFLINE_AFTER_HOURS,
      notes: MAX_NOTES,
    },
  };
};

/** Active devices; `inactive` is only a count. */
const getDashboard = async (farmId: string, requester: string) => {
  const access = await readAccess(farmId, requester);
  const base: TFilter = { farmId: access.farm._id, isActive: true };
  const today = appToday();
  const { WARNING, CRITICAL, FAULTY } = DeviceHealthStatuses;
  const expiring = warrantyFilter(WarrantyStates.EXPIRING, today);
  const lowBattery: TFilter = { batteryLevel: { $ne: null, $lte: BATTERY_LOW } };

  const count = (extra: TFilter) => DeviceModel.countDocuments({ ...base, ...extra });
  const groupBy = async (field: string) =>
    Object.fromEntries(
      (
        await DeviceModel.aggregate<{ _id: string; count: number }>([
          { $match: base },
          { $group: { _id: `$${field}`, count: { $sum: 1 } } },
        ])
      ).map((row) => [row._id, row.count]),
    );
  const list = async (extra: TFilter, sort: Record<string, 1 | -1>) =>
    attachAssignments(
      access.farm._id,
      await DeviceModel.find({ ...base, ...extra })
        .select("-__v -notes")
        .sort({ ...sort, _id: 1 })
        .limit(DASHBOARD_LIST_LIMIT)
        .lean(),
    );

  const assignedIds = await assignedDeviceIds(access.farm._id);
  const [total, inactive, assigned, lowCount, expiringCount, expiredCount] = await Promise.all([
    count({}),
    count({ isActive: false }),
    count({ _id: { $in: assignedIds } }),
    count(lowBattery),
    count(expiring),
    count(warrantyFilter(WarrantyStates.EXPIRED, today)),
  ]);
  const [byType, byConnection, byHealth] = await Promise.all(["deviceType", "connectionStatus", "healthStatus"].map(groupBy));
  const [connection, health, battery, maintenance, warranty] = await Promise.all([
    list({ connectionStatus: { $in: [OFFLINE, DISCONNECTED] } }, { lastSyncAt: 1 }),
    list({ healthStatus: { $in: [WARNING, CRITICAL, FAULTY] } }, { updatedAt: -1 }),
    list(lowBattery, { batteryLevel: 1 }),
    list({ connectionStatus: MAINTENANCE }, { updatedAt: -1 }),
    list(expiring, { warrantyExpiry: 1 }),
  ]);
  return {
    total,
    inactive,
    assigned,
    free: total - assigned,
    byType,
    byConnection,
    byHealth,
    lowBattery: lowCount,
    warrantyExpiring: expiringCount,
    warrantyExpired: expiredCount,
    lists: { connection, health, battery, maintenance, warranty },
  };
};

const getAuditLogs = async (farmId: string, requester: string, ref: string, query: TPayload) => {
  const access = await readAccess(farmId, requester);
  requireRole(access, DevicePermissions.WRITE, "Only the farm owner or a manager can read the audit log!");
  const device = await findDevice(access, ref);
  return AuditLogServices.getEntityLogs(farmId, requester, AuditEntityTypes.DEVICE, String(device._id), query);
};

/* ---------- writes ---------- */

const createDevice = async (farmId: string, requester: string, body: TPayload, context: TAuditContext) => {
  const access = await writeAccess(farmId, requester);
  const missing = REQUIRED_FIELDS.filter((field) => isBlank(body[field]));
  if (missing.length) throw bad(`${missing.join(", ")} required!`);
  const fields = parseFields(body) as TEditable;
  checkConsistency(fields);

  const device = {
    ...fields,
    _id: new Types.ObjectId(),
    deviceCode: await generateDeviceCode(),
    farmId: access.farm._id,
    connectionStatus: OFFLINE,
    healthStatus: DeviceHealthStatuses.HEALTHY,
    isActive: true,
    createdBy: access.user._id,
    updatedBy: access.user._id,
  };
  try {
    await executeAtomically(
      async (session, undo) => {
        await DeviceModel.create([device], sessionOpts(session));
        undo.push(() => DeviceModel.deleteOne({ _id: device._id }));
      },
      auditing(access, context, device._id, AuditActions.CREATE, "Device Registered", { newData: snapshot(device) }),
    );
  } catch (error) {
    translateDuplicate(error);
  }
  return detail(access, device._id);
};

const updateDevice = async (farmId: string, requester: string, ref: string, context: TAuditContext, body: TPayload) => {
  const access = await writeAccess(farmId, requester);
  const before = await findDevice(access, ref);
  if (!before.isActive) throw conflict("Reactivate the device before changing it!");

  const fields = parseFields(body);
  //a device without a battery has no level; an explicit level is refused below
  if (fields.batteryType === BatteryTypes.NOT_APPLICABLE && fields.batteryLevel === undefined) fields.batteryLevel = null;
  const changes = Object.fromEntries(
    Object.entries(fields).filter(([field, value]) => !same(value, (before as TPayload)[field])),
  ) as Partial<TEditable>;
  const changedFields = Object.keys(changes);
  if (!changedFields.length) return { mode: "unchanged" as const, changedFields, device: await detail(access, before._id) };
  const after = { ...before, ...changes };
  checkConsistency(after);

  const identity = changedFields.filter((field) => IDENTITY_FIELDS.includes(field));
  try {
    await executeAtomically(
      async (session, undo) => {
        if (identity.length) {
          const usage = await countDeviceHistory(before._id, session);
          if (usage.assignments + usage.readings > 0) {
            throw conflict(`${identity.join(", ")} cannot be changed after the first assignment or reading!`);
          }
        }
        await applyChanges(before, { ...changes, updatedBy: access.user._id }, session, undo);
      },
      auditing(access, context, before._id, AuditActions.UPDATE, "Device Updated", {
        oldData: snapshot(before),
        newData: snapshot(after),
        changedFields,
      }),
    );
  } catch (error) {
    translateDuplicate(error);
  }
  await NotificationProducers.deviceChanged(access.farm._id, before.deviceCode);
  return { mode: "updated" as const, changedFields, device: await detail(access, before._id) };
};

/** Connection and health are independent: neither changes the other, nor any animal. */
const changeStatus = async (farmId: string, requester: string, ref: string, context: TAuditContext, body: TPayload) => {
  const access = await writeAccess(farmId, requester);
  const before = await findDevice(access, ref);
  if (!before.isActive) throw conflict("Reactivate the device before changing its status!");
  const reason = parseReason(body.reason);

  const changes: Partial<TDevice> = {};
  if (!isBlank(body.connectionStatus)) {
    const next = parseEnum("connectionStatus", body.connectionStatus, [
      MAINTENANCE,
      DISCONNECTED,
      OFFLINE,
    ]) as TDevice["connectionStatus"];
    if (next === OFFLINE && before.connectionStatus === ONLINE) {
      throw conflict(`An online device becomes Offline by itself after ${OFFLINE_AFTER_HOURS} hours without a sync!`);
    }
    if (next !== before.connectionStatus) changes.connectionStatus = next;
  }
  if (!isBlank(body.healthStatus)) {
    const next = parseEnum("healthStatus", body.healthStatus, Object.values(DeviceHealthStatuses)) as TDevice["healthStatus"];
    if (next !== before.healthStatus) changes.healthStatus = next;
  }
  const changedFields = Object.keys(changes);
  if (!changedFields.length) throw bad("Nothing to change: choose another connection or health status!");

  const pick = (source: object) => Object.fromEntries(changedFields.map((field) => [field, (source as TPayload)[field]]));
  await executeAtomically(
    (session, undo) => applyChanges(before, { ...changes, updatedBy: access.user._id }, session, undo),
    auditing(access, context, before._id, AuditActions.UPDATE, "Device Status Changed", {
      oldData: pick(before),
      newData: { ...pick(changes), reason },
      changedFields,
    }),
  );
  await NotificationProducers.deviceChanged(access.farm._id, before.deviceCode);
  return detail(access, before._id);
};

const deactivate = async (farmId: string, requester: string, ref: string, context: TAuditContext, body: TPayload) => {
  const access = await ownerAccess(farmId, requester);
  const before = await findDevice(access, ref);
  if (!before.isActive) throw conflict("This device is already inactive!");
  const reason = parseReason(body.reason);
  //Animal Sold / Animal Dead belong to the animal life cycle
  const removalReason = isBlank(body.removalReason)
    ? null
    : (parseEnum("removalReason", body.removalReason, MANUAL_REMOVAL_REASONS) as TRemovalReason);

  const steps = auditing(access, context, before._id, AuditActions.ARCHIVE, "Device Deactivated", {
    oldData: { isActive: true, connectionStatus: before.connectionStatus },
    newData: { isActive: false, connectionStatus: DISCONNECTED, reason, ...(removalReason ? { removalReason } : {}) },
    changedFields: ["isActive", "connectionStatus"],
  });
  let released: TRecordAuditInput | null = null;
  await executeAtomically(
    async (session, undo) => {
      released = null;
      const assigned = await hasActiveAssignment(before._id, session);
      if (assigned && !removalReason) {
        throw conflict("This device is assigned to an animal: choose a removal reason to release it!");
      }
      await applyChanges(
        before,
        { isActive: false, connectionStatus: DISCONNECTED, updatedBy: access.user._id },
        session,
        undo,
      );
      if (assigned && removalReason) {
        //the assignment module's removal workflow, in this unit of work
        released = await closeDeviceAssignment(
          before._id,
          {
            removalReason,
            removedBy: access.user._id,
            remarks: `Device deactivated: ${reason}`,
            context,
            event: "Device Removed (Device Deactivated)",
          },
          session,
          undo,
        );
      }
    },
    {
      trace: steps.trace,
      log: async () => {
        await steps.log();
        if (released) await recordAuditLog(released);
      },
    },
  );
  await NotificationProducers.deviceChanged(access.farm._id, before.deviceCode);
  return detail(access, before._id);
};

const reactivate = async (farmId: string, requester: string, ref: string, context: TAuditContext) => {
  const access = await ownerAccess(farmId, requester);
  const before = await findDevice(access, ref);
  if (before.isActive) throw conflict("This device is already active!");
  await executeAtomically(
    (session, undo) =>
      applyChanges(before, { isActive: true, connectionStatus: OFFLINE, updatedBy: access.user._id }, session, undo),
    auditing(access, context, before._id, AuditActions.UPDATE, "Device Reactivated", {
      oldData: { isActive: false, connectionStatus: before.connectionStatus },
      newData: { isActive: true, connectionStatus: OFFLINE },
      changedFields: ["isActive", "connectionStatus"],
    }),
  );
  return detail(access, before._id);
};

/** Wrong registration only: a device with any history is deactivated instead. */
const deleteDevice = async (farmId: string, requester: string, ref: string, context: TAuditContext) => {
  const access = await ownerAccess(farmId, requester);
  const before = await findDevice(access, ref);
  await executeAtomically(
    async (session, undo) => {
      const usage = await countDeviceHistory(before._id, session);
      if (usage.assignments + usage.readings > 0) {
        throw conflict("This device has assignments or readings and cannot be deleted. Deactivate it instead!");
      }
      const removed = await DeviceModel.findOneAndDelete({ _id: before._id, farmId: access.farm._id }, sessionOpts(session)).lean();
      if (!removed) throw new AppError(status.NOT_FOUND, "Device not found!");
      //raw insert: timestamps stay as they were
      undo.push(() => DeviceModel.collection.insertOne(removed));
    },
    auditing(access, context, before._id, AuditActions.DELETE, "Device Deleted", { oldData: snapshot(before) }),
  );
  await NotificationProducers.deviceChanged(access.farm._id, before.deviceCode);
  return { _id: before._id, deviceCode: before.deviceCode, deleted: true };
};

/* ---------- jobs ---------- */

/** Online without a sync for 24 h → Offline. Maintenance, Disconnected and healthStatus are never touched. */
const checkFarmConnectivity = async (farmId: Types.ObjectId): Promise<void> => {
  const cutoff = new Date(Date.now() - OFFLINE_AFTER_HOURS * 60 * 60 * 1000);
  const stale: TFilter = {
    farmId,
    isActive: true,
    connectionStatus: ONLINE,
    $or: [{ lastSyncAt: null }, { lastSyncAt: { $lte: cutoff } }],
  };
  for (const device of await DeviceModel.find(stale).lean()) {
    //told first: if this run stops here, the next one repeats it without a duplicate
    await NotificationProducers.tellDeviceOffline(device);
    const moved = await DeviceModel.updateOne({ ...stale, _id: device._id }, { $set: { connectionStatus: OFFLINE } });
    //it synced in between
    if (!moved.modifiedCount) await NotificationProducers.deviceChanged(farmId, device.deviceCode);
  }
};

const checkFarmWarranties = async (farmId: Types.ObjectId): Promise<void> => {
  const expiring = warrantyFilter(WarrantyStates.EXPIRING, appToday());
  const devices = await DeviceModel.find({ farmId, isActive: true, ...expiring }).lean();
  for (const device of devices) await NotificationProducers.tellWarrantyEnding(device);
};

export const DeviceServices = {
  createDevice,
  getDevices,
  getDashboard,
  getMeta,
  lookup,
  getDevice,
  updateDevice,
  changeStatus,
  deactivate,
  reactivate,
  deleteDevice,
  getAuditLogs,
  checkFarmConnectivity,
  checkFarmWarranties,
};
