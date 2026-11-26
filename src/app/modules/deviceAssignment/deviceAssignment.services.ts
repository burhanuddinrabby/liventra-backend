import status from "http-status";
import { isValidObjectId, Types } from "mongoose";
import type { ClientSession } from "mongoose";
import AppError from "../../errors/AppError.js";
import { requireRole, requireWritableFarm, resolveFarm } from "../../utils/farmAccess.js";
import type { TFarmContext } from "../../utils/farmAccess.js";
import { AnimalLifeStatuses } from "../animal/animal.constants.js";
import { AnimalModel } from "../animal/animal.model.js";
import { AuditActions, AuditEntityTypes, AuditModules } from "../auditLog/auditLog.constants.js";
import { recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext, TRecordAuditInput } from "../auditLog/auditLog.utils.js";
import { ConnectionStatuses, DEVICE_CODE_PATTERN, DeviceHealthStatuses, DeviceTypes } from "../device/device.constants.js";
import type { TDeviceDoc } from "../device/device.interface.js";
import { readingsOfAssignment } from "../device/device.links.js";
import { DeviceModel } from "../device/device.model.js";
import {
  escapeRegex,
  executeAtomically,
  isBlank,
  pageMeta,
  parseBoolean,
  parseCalendarDate,
  parseDateRange,
  parseEnum,
  parseEnumList,
  parsePaging,
} from "../feedRecord/feedRecord.utils.js";
import type { TPayload, TUndo } from "../feedRecord/feedRecord.utils.js";
import { NotificationProducers } from "../notification/notification.producers.js";
import {
  ASSIGNMENT_MAX_LIMIT,
  ASSIGNMENT_NO_PATTERN,
  ASSIGNMENT_SORT_FIELDS,
  AssignmentPermissions,
  AssignmentReasons,
  AssignmentStatuses,
  CANCEL_WINDOW_HOURS,
  DIRECT_ASSIGNMENT_REASONS,
  MANUAL_REMOVAL_REASONS,
  MAX_REMARKS,
  OldDeviceActions,
  PER_ANIMAL_NOTE_TYPES,
  PICKER_LIMIT,
  RemovalReasonValues,
  REPLACEMENT_REMOVAL_REASONS,
  RemovalReasons,
  ReplaceModes,
} from "./deviceAssignment.constants.js";
import type {
  TAssignmentReason,
  TDeviceAssignment,
  TDeviceAssignmentDoc,
  TRemovalReason,
} from "./deviceAssignment.interface.js";
import { DeviceAssignmentModel, generateAssignmentNo } from "./deviceAssignment.model.js";
import {
  ALREADY_CLOSED,
  appendRemark,
  assignmentAudit,
  cancelDeadline,
  closeAssignmentRow,
  sessionOpts,
} from "./deviceAssignment.utils.js";

type TId = Types.ObjectId;
type TFilter = Record<string, unknown>;

const { ACTIVE, REMOVED, CANCELLED } = AssignmentStatuses;

const bad = (message: string) => new AppError(status.BAD_REQUEST, message);
const conflict = (message: string) => new AppError(status.CONFLICT, message);
//a clock a few minutes ahead of the server is not "the future"
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/* ---------- access ---------- */

const readAccess = async (farmId: string, requester: string): Promise<TFarmContext> => {
  const access = await resolveFarm(farmId, requester);
  requireRole(access, AssignmentPermissions.READ, "Your farm role cannot see device assignments!");
  return access;
};

const writeAccess = async (farmId: string, requester: string): Promise<TFarmContext> => {
  const access = await resolveFarm(farmId, requester);
  requireRole(access, AssignmentPermissions.WRITE, "Only the farm owner or a manager can assign devices!");
  requireWritableFarm(access);
  return access;
};

/* ---------- lookups (always inside the caller's farm: another farm's record is "not found") ---------- */

const findDevice = async (access: TFarmContext, ref: unknown, session: ClientSession | null = null): Promise<TDeviceDoc> => {
  const value = typeof ref === "string" ? ref.trim() : "";
  const isCode = DEVICE_CODE_PATTERN.test(value);
  const device =
    isCode || isValidObjectId(value)
      ? await DeviceModel.findOne({
          ...(isCode ? { deviceCode: value.toUpperCase() } : { _id: new Types.ObjectId(value) }),
          farmId: access.farm._id,
        })
          .session(session)
          .lean()
      : null;
  if (!device) throw new AppError(status.NOT_FOUND, "Device not found in this farm!");
  return device;
};

type TAnimalRow = { _id: TId; animalCode: string; name?: string | null; lifeStatus: string; isActive: boolean };

const findAnimal = async (access: TFarmContext, ref: unknown, session: ClientSession | null = null): Promise<TAnimalRow> => {
  const value = typeof ref === "string" ? ref.trim() : "";
  const animal = value
    ? await AnimalModel.findOne({
        ...(isValidObjectId(value)
          ? { _id: new Types.ObjectId(value) }
          : { animalCode: new RegExp(`^${escapeRegex(value)}$`, "i") }),
        farmId: access.farm._id,
      })
        .select("animalCode name lifeStatus isActive")
        .session(session)
        .lean<TAnimalRow>()
    : null;
  if (!animal) throw new AppError(status.NOT_FOUND, "Animal not found in this farm!");
  return animal;
};

const findAssignment = async (access: TFarmContext, ref: string, session: ClientSession | null = null) => {
  const isNo = ASSIGNMENT_NO_PATTERN.test(ref);
  const row =
    isNo || isValidObjectId(ref)
      ? await DeviceAssignmentModel.findOne({
          ...(isNo ? { assignmentNo: ref.toUpperCase() } : { _id: new Types.ObjectId(ref) }),
          farmId: access.farm._id,
        })
          .session(session)
          .lean()
      : null;
  if (!row) throw new AppError(status.NOT_FOUND, "Assignment not found!");
  return row;
};

const requireActiveRow = (row: TDeviceAssignmentDoc) => {
  if (row.status !== ACTIVE) throw conflict(`${row.assignmentNo} is already ${row.status}!`);
};

/* ---------- rules ---------- */

/** Device isActive, not Maintenance, not Faulty. */
const requireAssignableDevice = (device: TDeviceDoc) => {
  if (!device.isActive) throw conflict(`${device.deviceCode} is inactive. Reactivate it before assigning it!`);
  if (device.connectionStatus === ConnectionStatuses.MAINTENANCE) {
    throw conflict(`${device.deviceCode} is in maintenance. End the maintenance before assigning it!`);
  }
  if (device.healthStatus === DeviceHealthStatuses.FAULTY) {
    throw conflict(`${device.deviceCode} is marked Faulty and cannot be assigned!`);
  }
};

const requireActiveAnimal = (animal: TAnimalRow) => {
  if (animal.lifeStatus !== AnimalLifeStatuses.ACTIVE || !animal.isActive) {
    throw conflict(`${animal.animalCode} is ${animal.lifeStatus}: only Active animals can receive a device!`);
  }
};

/** An exact time (ISO) or a calendar day (UTC midnight); blank = now. Never in the future. */
const parseMoment = (field: string, value: unknown): Date => {
  if (isBlank(value)) return new Date();
  if (typeof value !== "string") throw bad(`${field} must be a date!`);
  const text = value.trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? parseCalendarDate(field, text) : new Date(text);
  if (Number.isNaN(date.getTime())) throw bad(`${field} must be a valid date!`);
  if (date.getTime() > Date.now() + CLOCK_SKEW_MS) throw bad(`${field} cannot be in the future!`);
  return date;
};

const parseRemarks = (value: unknown, required = false, label = "remarks"): string | null => {
  if (isBlank(value)) {
    if (required) throw bad(`${label} are required!`);
    return null;
  }
  if (typeof value !== "string") throw bad(`${label} must be text!`);
  const text = value.trim();
  if (required && text.length < 3) throw bad(`${label} must be at least 3 characters!`);
  if (text.length > MAX_REMARKS) throw bad(`${label} cannot exceed ${MAX_REMARKS} characters!`);
  return text;
};

/** Newest end of this device's closed periods: a new period may not start before it (no overlap). */
const lastRemovedDateOf = async (deviceId: TId, session: ClientSession | null): Promise<Date | null> => {
  const last = await DeviceAssignmentModel.findOne({ deviceId, status: REMOVED })
    .sort({ removedDate: -1 })
    .select("removedDate")
    .session(session)
    .lean();
  return last?.removedDate ?? null;
};

const requireValidStart = async (device: TDeviceDoc, assignedDate: Date, session: ClientSession | null) => {
  if (device.installationDate && assignedDate < device.installationDate) {
    throw bad(`assignedDate cannot be before ${device.deviceCode} was installed!`);
  }
  const lastEnd = await lastRemovedDateOf(device._id, session);
  if (lastEnd && assignedDate < lastEnd) {
    throw bad(
      `assignedDate overlaps an earlier assignment of ${device.deviceCode}: it was removed on ${lastEnd.toISOString()}. Choose a later date!`,
    );
  }
};

const requireFree = async (device: TDeviceDoc, session: ClientSession | null) => {
  const open = await DeviceAssignmentModel.findOne({ deviceId: device._id, status: ACTIVE })
    .select("assignmentNo")
    .session(session)
    .lean();
  if (open) throw conflict(`${device.deviceCode} is already assigned (${open.assignmentNo}). Remove or reassign it first!`);
};

/** A second Active device of the same type on one animal needs `confirmSameType: true`. */
const requireSameTypeConfirmed = async (
  animal: TAnimalRow,
  device: TDeviceDoc,
  confirmed: boolean,
  session: ClientSession | null,
) => {
  if (confirmed) return;
  const deviceIds = await DeviceAssignmentModel.find({ animalId: animal._id, status: ACTIVE })
    .session(session)
    .distinct("deviceId");
  if (!deviceIds.length) return;
  const same = await DeviceModel.find({ _id: { $in: deviceIds }, deviceType: device.deviceType })
    .select("deviceCode")
    .session(session)
    .lean();
  if (same.length) {
    throw conflict(
      `${animal.animalCode} already has an active ${device.deviceType} (${same.map((row) => row.deviceCode).join(", ")}). Resend with confirmSameType: true to add another one.`,
    );
  }
};

/** The partial unique index answered: someone assigned this device first. */
const translateDuplicate = (error: unknown): never => {
  const { code, keyPattern } = error as { code?: number; keyPattern?: object };
  if (code === 11000 && keyPattern && "deviceId" in keyPattern) {
    throw conflict("This device was just assigned by someone else. Reload and try again!");
  }
  throw error;
};

const ROW_AUDIT_FIELDS = [
  "assignmentNo",
  "deviceId",
  "animalId",
  "assignedDate",
  "assignmentReason",
  "status",
  "removedDate",
  "removalReason",
  "remarks",
] as const;

const snapshot = (row: Partial<TDeviceAssignment>) =>
  Object.fromEntries(ROW_AUDIT_FIELDS.map((field) => [field, row[field] ?? null]));

type TNewRow = TDeviceAssignment & { _id: TId };

const buildRow = async (
  access: TFarmContext,
  device: TDeviceDoc,
  animal: TAnimalRow,
  assignedDate: Date,
  assignmentReason: TAssignmentReason,
  remarks: string | null,
): Promise<TNewRow> => ({
  _id: new Types.ObjectId(),
  assignmentNo: await generateAssignmentNo(),
  farmId: access.farm._id,
  deviceId: device._id,
  animalId: animal._id,
  assignedDate,
  removedDate: null,
  assignmentReason,
  removalReason: null,
  assignedBy: access.user._id,
  removedBy: null,
  status: ACTIVE,
  remarks,
});

const insertRow = async (
  access: TFarmContext,
  context: TAuditContext,
  row: TNewRow,
  event: string,
  session: ClientSession | null,
  undo: TUndo,
): Promise<TRecordAuditInput> => {
  await DeviceAssignmentModel.create([row], sessionOpts(session));
  undo.push(() => DeviceAssignmentModel.deleteOne({ _id: row._id }));
  return assignmentAudit(access.farm._id, context, row._id, AuditActions.CREATE, event, { newData: snapshot(row) });
};

/** One unit of work whose audit step writes every collected row (assignment and device). */
const runAudited = async <T>(
  access: TFarmContext,
  context: TAuditContext,
  trace: { entityId: TId | null; action: TRecordAuditInput["action"]; event: string },
  // eslint-disable-next-line no-unused-vars
  work: (session: ClientSession | null, undo: TUndo, audits: TRecordAuditInput[]) => Promise<T>,
): Promise<T> => {
  let audits: TRecordAuditInput[] = [];
  try {
    return await executeAtomically(
      (session, undo) => {
        //a retried transaction starts again with an empty list
        audits = [];
        return work(session, undo, audits);
      },
      {
        trace: assignmentAudit(access.farm._id, context, trace.entityId ?? access.farm._id, trace.action, trace.event, {}),
        log: async () => {
          for (const entry of audits) await recordAuditLog(entry);
        },
      },
    );
  } catch (error) {
    return translateDuplicate(error);
  }
};

/* ---------- reads ---------- */

const DEVICE_FIELDS = "deviceCode deviceType company model serialNumber connectionStatus healthStatus batteryLevel batteryType isActive";
const ANIMAL_FIELDS = "animalCode name tagNumber gender lifeStatus profilePhoto";
const USER_FIELDS = "userId fullName";

const withDerived = <T extends TDeviceAssignmentDoc>(row: T, now = Date.now()) => {
  const deadline = cancelDeadline(row);
  const end = row.removedDate ? row.removedDate.getTime() : now;
  return {
    ...row,
    durationDays: Math.max(0, Math.floor((end - row.assignedDate.getTime()) / (24 * 60 * 60 * 1000))),
    cancelUntil: row.status === ACTIVE ? deadline : null,
    //readings are checked on the detail page and by the cancel endpoint itself
    withinCancelWindow: row.status === ACTIVE && !!deadline && deadline.getTime() > now,
  };
};

const POPULATE = [
  { path: "deviceId", select: DEVICE_FIELDS },
  { path: "animalId", select: ANIMAL_FIELDS },
  { path: "assignedBy", select: USER_FIELDS },
  { path: "removedBy", select: USER_FIELDS },
];

const listQuery = (where: TFilter) => DeviceAssignmentModel.find(where).select("-__v").populate(POPULATE);

const detail = async (access: TFarmContext, id: TId) => {
  const row = await DeviceAssignmentModel.findOne({ _id: id, farmId: access.farm._id })
    .select("-__v")
    .populate(POPULATE)
    .lean<TDeviceAssignmentDoc>();
  if (!row) throw new AppError(status.NOT_FOUND, "Assignment not found!");
  const readings = await readingsOfAssignment(id);
  const derived = withDerived(row);
  return {
    ...derived,
    readings,
    cancellable: derived.withinCancelWindow && readings.count === 0,
  };
};

const getAssignment = async (farmId: string, requester: string, ref: string) => {
  const access = await readAccess(farmId, requester);
  return detail(access, (await findAssignment(access, ref))._id);
};

/** Device / animal filters accept the `_id` or the code; unknown ones simply match nothing. */
const refFilter = async (access: TFarmContext, kind: "device" | "animal", ref: unknown): Promise<TId | null> => {
  const value = typeof ref === "string" ? ref.trim() : "";
  if (!value) return null;
  if (isValidObjectId(value)) return new Types.ObjectId(value);
  const row =
    kind === "device"
      ? await DeviceModel.findOne({ farmId: access.farm._id, deviceCode: value.toUpperCase() }).select("_id").lean()
      : await AnimalModel.findOne({ farmId: access.farm._id, animalCode: new RegExp(`^${escapeRegex(value)}$`, "i") })
          .select("_id")
          .lean();
  return (row?._id as TId | undefined) ?? new Types.ObjectId();
};

const buildFilter = async (access: TFarmContext, query: TPayload): Promise<TFilter> => {
  const and: TFilter[] = [{ farmId: access.farm._id }];
  const deviceId = await refFilter(access, "device", query.deviceId);
  if (deviceId) and.push({ deviceId });
  const animalId = await refFilter(access, "animal", query.animalId);
  if (animalId) and.push({ animalId });
  if (!isBlank(query.status)) and.push({ status: { $in: parseEnumList("status", query.status, Object.values(AssignmentStatuses)) } });
  if (!isBlank(query.assignmentReason)) {
    and.push({ assignmentReason: { $in: parseEnumList("assignmentReason", query.assignmentReason, Object.values(AssignmentReasons)) } });
  }
  if (!isBlank(query.removalReason)) {
    and.push({ removalReason: { $in: parseEnumList("removalReason", query.removalReason, RemovalReasons) } });
  }
  if (!isBlank(query.deviceType)) {
    const types: TFilter = { $in: parseEnumList("deviceType", query.deviceType, Object.values(DeviceTypes)) };
    const ids = await DeviceModel.find({ farmId: access.farm._id, deviceType: types } as TFilter).distinct("_id");
    and.push({ deviceId: { $in: ids } });
  }
  const dateField = isBlank(query.dateField) ? "assignedDate" : parseEnum("dateField", query.dateField, ["assignedDate", "removedDate"]);
  const range = parseDateRange(query, dateField);
  if (Object.keys(range).length) and.push(range);
  if (!isBlank(query.searchTerm)) {
    if (typeof query.searchTerm !== "string" || query.searchTerm.length > 100) throw bad("searchTerm is invalid!");
    const regex = new RegExp(escapeRegex(query.searchTerm.trim()), "i");
    const [devices, animals] = await Promise.all([
      DeviceModel.find({ farmId: access.farm._id, $or: [{ deviceCode: regex }, { serialNumber: regex }] }).distinct("_id"),
      AnimalModel.find({ farmId: access.farm._id, $or: [{ animalCode: regex }, { name: regex }, { tagNumber: regex }] }).distinct("_id"),
    ]);
    and.push({ $or: [{ assignmentNo: regex }, { deviceId: { $in: devices } }, { animalId: { $in: animals } }] });
  }
  return { $and: and };
};

const sortOf = (query: TPayload) => {
  const raw = isBlank(query.sort) ? "-assignedDate" : String(query.sort);
  const field = parseEnum("sort", raw.replace(/^-/, ""), ASSIGNMENT_SORT_FIELDS);
  return { [field]: raw.startsWith("-") ? -1 : 1, _id: -1 } as Record<string, 1 | -1>;
};

const pageOf = async (where: TFilter, query: TPayload) => {
  const { page, limit, skip } = parsePaging(query, ASSIGNMENT_MAX_LIMIT, 20);
  const [total, rows, counts] = await Promise.all([
    DeviceAssignmentModel.countDocuments(where),
    listQuery(where).sort(sortOf(query)).skip(skip).limit(limit).lean<TDeviceAssignmentDoc[]>(),
    DeviceAssignmentModel.aggregate<{ _id: string; count: number }>([{ $match: where }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
  ]);
  const now = Date.now();
  return {
    meta: { ...pageMeta(page, limit, total), byStatus: Object.fromEntries(counts.map((row) => [row._id, row.count])) },
    rows: rows.map((row) => withDerived(row, now)),
  };
};

const getAssignments = async (farmId: string, requester: string, query: TPayload) => {
  const access = await readAccess(farmId, requester);
  return pageOf(await buildFilter(access, query), query);
};

/** GET /devices/:id/assignments — the device's history, newest first. */
const getDeviceAssignments = async (farmId: string, requester: string, deviceRef: string, query: TPayload) => {
  const access = await readAccess(farmId, requester);
  const device = await findDevice(access, deviceRef);
  return pageOf({ farmId: access.farm._id, deviceId: device._id }, query);
};

/** GET /animals/:animalId/devices — current and previous devices of one animal. */
const getAnimalDevices = async (farmId: string, requester: string, animalRef: string) => {
  const access = await readAccess(farmId, requester);
  const animal = await findAnimal(access, animalRef);
  const rows = await listQuery({ farmId: access.farm._id, animalId: animal._id })
    .sort({ assignedDate: -1, _id: -1 })
    .limit(200)
    .lean<TDeviceAssignmentDoc[]>();
  const now = Date.now();
  const derived = rows.map((row) => withDerived(row, now));
  return {
    animal,
    current: derived.filter((row) => row.status === ACTIVE),
    previous: derived.filter((row) => row.status !== ACTIVE),
  };
};

const getMeta = async (farmId: string, requester: string) => {
  const access = await readAccess(farmId, requester);
  const canWrite = AssignmentPermissions.WRITE.includes(access.role) && access.farm.status === "Active";
  return {
    statuses: Object.values(AssignmentStatuses),
    assignmentReasons: Object.values(AssignmentReasons),
    directAssignmentReasons: DIRECT_ASSIGNMENT_REASONS,
    removalReasons: RemovalReasons,
    manualRemovalReasons: MANUAL_REMOVAL_REASONS,
    replacementRemovalReasons: REPLACEMENT_REMOVAL_REASONS,
    replaceModes: Object.values(ReplaceModes),
    oldDeviceActions: Object.values(OldDeviceActions),
    perAnimalNoteTypes: PER_ANIMAL_NOTE_TYPES,
    limits: { cancelWindowHours: CANCEL_WINDOW_HOURS, remarks: MAX_REMARKS },
    permissions: {
      role: access.role,
      canWrite,
      canDeactivateOldDevice: canWrite && AssignmentPermissions.OWNER.includes(access.role),
    },
  };
};

/** Picker: devices that can be assigned now. */
const getEligibleDevices = async (farmId: string, requester: string, query: TPayload) => {
  const access = await writeAccess(farmId, requester);
  const busy: TId[] = await DeviceAssignmentModel.distinct("deviceId", { farmId: access.farm._id, status: ACTIVE });
  if (!isBlank(query.exclude) && isValidObjectId(query.exclude)) busy.push(new Types.ObjectId(String(query.exclude)));
  const where: TFilter = {
    farmId: access.farm._id,
    isActive: true,
    connectionStatus: { $ne: ConnectionStatuses.MAINTENANCE },
    healthStatus: { $ne: DeviceHealthStatuses.FAULTY },
    _id: { $nin: busy },
  };
  if (!isBlank(query.deviceType)) where.deviceType = { $in: parseEnumList("deviceType", query.deviceType, Object.values(DeviceTypes)) };
  if (!isBlank(query.searchTerm)) {
    const regex = new RegExp(escapeRegex(String(query.searchTerm).trim().slice(0, 100)), "i");
    where.$or = [{ deviceCode: regex }, { serialNumber: regex }, { company: regex }, { model: regex }];
  }
  const devices = await DeviceModel.find(where)
    .select(`${DEVICE_FIELDS} installationDate`)
    .sort({ deviceCode: 1 })
    .limit(PICKER_LIMIT)
    .lean();
  const history = await DeviceAssignmentModel.aggregate<{ _id: TId; lastRemovedDate: Date | null; removed: number }>([
    { $match: { deviceId: { $in: devices.map((device) => device._id) }, status: REMOVED } },
    { $group: { _id: "$deviceId", lastRemovedDate: { $max: "$removedDate" }, removed: { $sum: 1 } } },
  ]);
  const byId = new Map(history.map((row) => [String(row._id), row]));
  return devices.map((device) => {
    const past = byId.get(String(device._id));
    return {
      ...device,
      lastRemovedDate: past?.lastRemovedDate ?? null,
      everAssigned: !!past,
      suggestedReason: past ? AssignmentReasons.REASSIGNMENT : AssignmentReasons.NEW_INSTALLATION,
      perAnimalNote: PER_ANIMAL_NOTE_TYPES.includes(device.deviceType),
    };
  });
};

/** Picker: Active animals, each with the devices it already wears (same-type warning). */
const getEligibleAnimals = async (farmId: string, requester: string, query: TPayload) => {
  const access = await writeAccess(farmId, requester);
  const where: TFilter = { farmId: access.farm._id, lifeStatus: AnimalLifeStatuses.ACTIVE, isActive: true };
  if (!isBlank(query.exclude) && isValidObjectId(query.exclude)) where._id = { $ne: new Types.ObjectId(String(query.exclude)) };
  if (!isBlank(query.searchTerm)) {
    const regex = new RegExp(escapeRegex(String(query.searchTerm).trim().slice(0, 100)), "i");
    where.$or = [{ animalCode: regex }, { name: regex }, { tagNumber: regex }];
  }
  const animals = await AnimalModel.find(where)
    .select("animalCode name tagNumber gender")
    .sort({ animalCode: 1 })
    .limit(PICKER_LIMIT)
    .lean();
  const open = await DeviceAssignmentModel.find({ animalId: { $in: animals.map((animal) => animal._id) }, status: ACTIVE })
    .select("animalId deviceId")
    .populate<{ deviceId: { deviceCode: string; deviceType: string } | null }>("deviceId", "deviceCode deviceType")
    .lean();
  return animals.map((animal) => ({
    ...animal,
    activeDevices: open
      .filter((row) => String(row.animalId) === String(animal._id) && row.deviceId)
      .map((row) => ({ deviceCode: row.deviceId?.deviceCode, deviceType: row.deviceId?.deviceType })),
  }));
};

/* ---------- writes ---------- */

const assign = async (farmId: string, requester: string, body: TPayload, context: TAuditContext) => {
  const access = await writeAccess(farmId, requester);
  if (isBlank(body.deviceId)) throw bad("deviceId is required!");
  if (isBlank(body.animalId)) throw bad("animalId is required!");
  const device = await findDevice(access, body.deviceId);
  const animal = await findAnimal(access, body.animalId);
  requireAssignableDevice(device);
  requireActiveAnimal(animal);
  const assignedDate = parseMoment("assignedDate", body.assignedDate);
  const remarks = parseRemarks(body.remarks);
  const confirmed = parseBoolean(body.confirmSameType);

  const everRemoved = (await lastRemovedDateOf(device._id, null)) !== null;
  const assignmentReason = (
    isBlank(body.assignmentReason)
      ? everRemoved
        ? AssignmentReasons.REASSIGNMENT
        : AssignmentReasons.NEW_INSTALLATION
      : parseEnum("assignmentReason", body.assignmentReason, DIRECT_ASSIGNMENT_REASONS)
  ) as TAssignmentReason;
  if (assignmentReason === AssignmentReasons.NEW_INSTALLATION && everRemoved) {
    throw bad(`${device.deviceCode} has been assigned before: use Reassignment (or Testing) instead of New Installation!`);
  }

  const row = await buildRow(access, device, animal, assignedDate, assignmentReason, remarks);
  await runAudited(access, context, { entityId: row._id, action: AuditActions.CREATE, event: "Device Assigned" }, async (session, undo, audits) => {
    //re-read inside the unit of work: the state may have changed since the checks above
    const current = await findDevice(access, String(device._id), session);
    requireAssignableDevice(current);
    requireActiveAnimal(await findAnimal(access, String(animal._id), session));
    await requireFree(current, session);
    await requireValidStart(current, assignedDate, session);
    await requireSameTypeConfirmed(animal, current, confirmed, session);
    audits.push(await insertRow(access, context, row, "Device Assigned", session, undo));
  });
  return detail(access, row._id);
};

/** Same device, another animal: old row Removed (Manual Removal), new row Reassignment. */
const reassign = async (farmId: string, requester: string, ref: string, body: TPayload, context: TAuditContext) => {
  const access = await writeAccess(farmId, requester);
  const old = await findAssignment(access, ref);
  requireActiveRow(old);
  if (isBlank(body.animalId)) throw bad("animalId is required!");
  const animal = await findAnimal(access, body.animalId);
  if (animal._id.equals(old.animalId)) throw bad("Choose another animal: the device is already on this one!");
  requireActiveAnimal(animal);
  const device = await findDevice(access, String(old.deviceId));
  requireAssignableDevice(device);
  const date = parseMoment("date", body.date);
  const remarks = parseRemarks(body.remarks);
  const confirmed = parseBoolean(body.confirmSameType);

  const row = await buildRow(access, device, animal, date, AssignmentReasons.REASSIGNMENT, remarks);
  await runAudited(access, context, { entityId: old._id, action: AuditActions.UPDATE, event: "Device Reassigned" }, async (session, undo, audits) => {
    const current = await findAssignment(access, String(old._id), session);
    requireActiveRow(current);
    //step 1: close the old period
    audits.push(
      await closeAssignmentRow(
        current,
        {
          removalReason: RemovalReasonValues.MANUAL_REMOVAL,
          removedBy: access.user._id,
          removedDate: date,
          remarks: `Reassigned to ${animal.animalCode} (${row.assignmentNo}).`,
          context,
          event: "Device Reassigned",
        },
        session,
        undo,
      ),
    );
    //step 2: open the new one (any failure here rolls step 1 back)
    requireActiveAnimal(await findAnimal(access, String(animal._id), session));
    await requireSameTypeConfirmed(animal, device, confirmed, session);
    audits.push(await insertRow(access, context, row, "Device Reassigned", session, undo));
  });
  return { closed: await detail(access, old._id), assignment: await detail(access, row._id) };
};

/** Same animal, another device. Replacement: old reason from the body; upgrade: old reason Replacement. */
const replace = async (farmId: string, requester: string, ref: string, body: TPayload, context: TAuditContext) => {
  const access = await writeAccess(farmId, requester);
  const old = await findAssignment(access, ref);
  requireActiveRow(old);
  const mode = parseEnum("mode", body.mode, Object.values(ReplaceModes));
  const removalReason = (
    mode === ReplaceModes.UPGRADE
      ? RemovalReasonValues.REPLACEMENT
      : parseEnum("removalReason", body.removalReason, REPLACEMENT_REMOVAL_REASONS)
  ) as TRemovalReason;
  const oldDeviceAction = isBlank(body.oldDeviceAction)
    ? OldDeviceActions.NONE
    : parseEnum("oldDeviceAction", body.oldDeviceAction, Object.values(OldDeviceActions));
  if (oldDeviceAction === OldDeviceActions.DEACTIVATE) {
    requireRole(access, AssignmentPermissions.OWNER, "Only the farm owner can deactivate the old device!");
  }
  if (isBlank(body.deviceId)) throw bad("deviceId (the new device) is required!");
  const device = await findDevice(access, body.deviceId);
  if (device._id.equals(old.deviceId)) throw bad("Choose another device: this one is the device being replaced!");
  requireAssignableDevice(device);
  const animal = await findAnimal(access, String(old.animalId));
  requireActiveAnimal(animal);
  const oldDevice = await findDevice(access, String(old.deviceId));
  const date = parseMoment("date", body.date);
  const remarks = parseRemarks(body.remarks);
  const confirmed = parseBoolean(body.confirmSameType);
  const reason = mode === ReplaceModes.UPGRADE ? AssignmentReasons.DEVICE_UPGRADE : AssignmentReasons.REPLACEMENT;
  const event = mode === ReplaceModes.UPGRADE ? "Device Upgraded" : "Device Replaced";

  const row = await buildRow(access, device, animal, date, reason, remarks);
  await runAudited(access, context, { entityId: old._id, action: AuditActions.UPDATE, event }, async (session, undo, audits) => {
    const current = await findAssignment(access, String(old._id), session);
    requireActiveRow(current);
    audits.push(
      await closeAssignmentRow(
        current,
        {
          removalReason,
          removedBy: access.user._id,
          removedDate: date,
          remarks: `${mode === ReplaceModes.UPGRADE ? "Upgraded" : "Replaced"} by ${device.deviceCode} (${row.assignmentNo}).`,
          context,
          event,
        },
        session,
        undo,
      ),
    );
    if (oldDeviceAction !== OldDeviceActions.NONE) {
      const set =
        oldDeviceAction === OldDeviceActions.FAULTY
          ? { healthStatus: DeviceHealthStatuses.FAULTY }
          : { isActive: false, connectionStatus: ConnectionStatuses.DISCONNECTED };
      const before = Object.fromEntries(Object.keys(set).map((key) => [key, (oldDevice as unknown as TPayload)[key]]));
      await DeviceModel.updateOne({ _id: oldDevice._id }, { $set: { ...set, updatedBy: access.user._id } }, sessionOpts(session));
      undo.push(() => DeviceModel.updateOne({ _id: oldDevice._id }, { $set: before }));
      audits.push({
        context,
        farmId: access.farm._id,
        entityType: AuditEntityTypes.DEVICE,
        entityId: oldDevice._id,
        action: oldDeviceAction === OldDeviceActions.DEACTIVATE ? AuditActions.ARCHIVE : AuditActions.UPDATE,
        module: AuditModules.FARM,
        event: oldDeviceAction === OldDeviceActions.DEACTIVATE ? "Device Deactivated" : "Device Status Changed",
        oldData: before,
        newData: { ...set, reason: `${event}: ${row.assignmentNo}` },
        changedFields: Object.keys(set),
      });
    }
    const fresh = await findDevice(access, String(device._id), session);
    requireAssignableDevice(fresh);
    await requireFree(fresh, session);
    await requireValidStart(fresh, date, session);
    //a like-for-like swap adds no second device of that type
    await requireSameTypeConfirmed(animal, fresh, confirmed || fresh.deviceType === oldDevice.deviceType, session);
    audits.push(await insertRow(access, context, row, event, session, undo));
  });
  if (oldDeviceAction !== OldDeviceActions.NONE) await NotificationProducers.deviceChanged(access.farm._id, oldDevice.deviceCode);
  return { closed: await detail(access, old._id), assignment: await detail(access, row._id) };
};

const remove = async (farmId: string, requester: string, ref: string, body: TPayload, context: TAuditContext) => {
  const access = await writeAccess(farmId, requester);
  const old = await findAssignment(access, ref);
  requireActiveRow(old);
  const removalReason = parseEnum("removalReason", body.removalReason, MANUAL_REMOVAL_REASONS) as TRemovalReason;
  const removedDate = parseMoment("removedDate", body.removedDate);
  //Manual Removal says nothing by itself (spec §36)
  const remarks = parseRemarks(body.remarks, removalReason === RemovalReasonValues.MANUAL_REMOVAL);
  const toMaintenance = parseBoolean(body.deviceToMaintenance);
  if (toMaintenance && removalReason !== RemovalReasonValues.MAINTENANCE) {
    throw bad("deviceToMaintenance is only for the Maintenance removal reason!");
  }
  const device = await findDevice(access, String(old.deviceId));

  await runAudited(access, context, { entityId: old._id, action: AuditActions.UPDATE, event: "Device Removed" }, async (session, undo, audits) => {
    const current = await findAssignment(access, String(old._id), session);
    requireActiveRow(current);
    audits.push(
      await closeAssignmentRow(
        current,
        { removalReason, removedBy: access.user._id, removedDate, remarks, context, event: "Device Removed" },
        session,
        undo,
      ),
    );
    if (toMaintenance && device.isActive && device.connectionStatus !== ConnectionStatuses.MAINTENANCE) {
      await DeviceModel.updateOne(
        { _id: device._id },
        { $set: { connectionStatus: ConnectionStatuses.MAINTENANCE, updatedBy: access.user._id } },
        sessionOpts(session),
      );
      undo.push(() => DeviceModel.updateOne({ _id: device._id }, { $set: { connectionStatus: device.connectionStatus } }));
      audits.push({
        context,
        farmId: access.farm._id,
        entityType: AuditEntityTypes.DEVICE,
        entityId: device._id,
        action: AuditActions.UPDATE,
        module: AuditModules.FARM,
        event: "Device Status Changed",
        oldData: { connectionStatus: device.connectionStatus },
        newData: { connectionStatus: ConnectionStatuses.MAINTENANCE, reason: `Removed for maintenance (${old.assignmentNo})` },
        changedFields: ["connectionStatus"],
      });
    }
  });
  if (toMaintenance) await NotificationProducers.deviceChanged(access.farm._id, device.deviceCode);
  return detail(access, old._id);
};

/** A mistake, not an ended period: under 24 h old and without readings; otherwise remove it. */
const cancel = async (farmId: string, requester: string, ref: string, body: TPayload, context: TAuditContext) => {
  const access = await writeAccess(farmId, requester);
  const old = await findAssignment(access, ref);
  requireActiveRow(old);
  const note = parseRemarks(body.remarks, true);

  await runAudited(access, context, { entityId: old._id, action: AuditActions.UPDATE, event: "Assignment Cancelled" }, async (session, undo, audits) => {
    const current = await findAssignment(access, String(old._id), session);
    requireActiveRow(current);
    const deadline = cancelDeadline(current);
    if (!deadline || deadline.getTime() <= Date.now()) {
      throw conflict(`${current.assignmentNo} is older than ${CANCEL_WINDOW_HOURS} hours: remove it instead of cancelling it!`);
    }
    //PLAN 7 HOOK: always 0 until SensorData exists
    const { count } = await readingsOfAssignment(current._id, session);
    if (count > 0) throw conflict(`${current.assignmentNo} already has readings: remove it instead of cancelling it!`);
    const remarks = appendRemark(current.remarks, `Cancelled: ${note}`);
    const removedDate = new Date();
    const result = await DeviceAssignmentModel.updateOne(
      { _id: current._id, status: ACTIVE },
      { $set: { status: CANCELLED, removedDate, removedBy: access.user._id, removalReason: null, remarks } },
      sessionOpts(session),
    );
    if (!result.matchedCount) throw conflict(ALREADY_CLOSED);
    undo.push(() =>
      DeviceAssignmentModel.updateOne(
        { _id: current._id },
        { $set: { status: ACTIVE, removedDate: null, removedBy: null, remarks: current.remarks ?? null } },
      ),
    );
    audits.push(
      assignmentAudit(access.farm._id, context, current._id, AuditActions.UPDATE, "Assignment Cancelled", {
        oldData: { status: ACTIVE, removedDate: null, remarks: current.remarks ?? null },
        newData: { status: CANCELLED, removedDate, remarks },
        changedFields: ["status", "removedDate", "removedBy", "remarks"],
      }),
    );
  });
  return detail(access, old._id);
};

/** The only field that can be edited, on any row. */
const updateRemarks = async (farmId: string, requester: string, ref: string, body: TPayload, context: TAuditContext) => {
  const access = await writeAccess(farmId, requester);
  const old = await findAssignment(access, ref);
  if (!("remarks" in body)) throw bad("remarks is required (null clears it)!");
  const remarks = parseRemarks(body.remarks);
  if ((old.remarks ?? null) === remarks) return detail(access, old._id);
  await runAudited(access, context, { entityId: old._id, action: AuditActions.UPDATE, event: "Assignment Remarks Updated" }, async (session, undo, audits) => {
    const result = await DeviceAssignmentModel.updateOne(
      { _id: old._id, remarks: old.remarks ?? null },
      { $set: { remarks } },
      sessionOpts(session),
    );
    if (!result.matchedCount) throw conflict("These remarks were changed by someone else. Reload and try again!");
    undo.push(() => DeviceAssignmentModel.updateOne({ _id: old._id }, { $set: { remarks: old.remarks ?? null } }));
    audits.push(
      assignmentAudit(access.farm._id, context, old._id, AuditActions.UPDATE, "Assignment Remarks Updated", {
        oldData: { remarks: old.remarks ?? null },
        newData: { remarks },
        changedFields: ["remarks"],
      }),
    );
  });
  return detail(access, old._id);
};

const deleteAssignment = async () => {
  throw new AppError(
    status.FORBIDDEN,
    "Assignment history cannot be deleted. Cancel a mistaken assignment (within 24 hours) or remove the device instead.",
  );
};

export const DeviceAssignmentServices = {
  assign,
  reassign,
  replace,
  remove,
  cancel,
  updateRemarks,
  deleteAssignment,
  getAssignments,
  getAssignment,
  getMeta,
  getEligibleDevices,
  getEligibleAnimals,
  getDeviceAssignments,
  getAnimalDevices,
};
