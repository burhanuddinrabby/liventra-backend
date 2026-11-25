import status from "http-status";
import mongoose, { isValidObjectId, Types } from "mongoose";
import type { ClientSession } from "mongoose";
import AppError from "../../errors/AppError.js";
import { AnimalModel } from "../animal/animal.model.js";
import { AnimalLifeStatuses } from "../animal/animal.constants.js";
import { AuditLogModel } from "../auditLog/auditLog.model.js";
import { AuditActions, AuditEntityTypes, AuditModules } from "../auditLog/auditLog.constants.js";
import type { TAuditAction } from "../auditLog/auditLog.interface.js";
import { recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext } from "../auditLog/auditLog.utils.js";
import { FarmModel } from "../farm/farm.model.js";
import { FarmStatuses } from "../farm/farm.constants.js";
import { FarmMemberModel } from "../farmMember/farmMember.model.js";
import type { TFarmMemberRole } from "../farmMember/farmMember.interface.js";
import { FarmMemberServices } from "../farmMember/farmMember.service.js";
import {
  escapeRegex,
  executeAtomically,
  isBlank,
  pageMeta,
  parseCalendarDate,
  parseDateRange,
  parseEnumList,
  parseNumber,
  parsePaging,
} from "../feedRecord/feedRecord.utils.js";
import type { TPayload, TUndo } from "../feedRecord/feedRecord.utils.js";
import {
  InventoryItemTypes,
  InventoryReferenceTypes,
  InventoryTransactionTypes,
} from "../inventory/inventory.constants.js";
import type { TInventoryUnit } from "../inventory/inventory.interface.js";
import { InventoryModel, InventoryTransactionModel } from "../inventory/inventory.model.js";
import { applyStockChange, generateTransactionNo, isUnusableInventory } from "../inventory/inventory.utils.js";
import { VaccineModel } from "../vaccine/vaccine.model.js";
import {
  DEFAULT_UPCOMING_DAYS,
  DELETABLE_STATUSES,
  DUPLICATE_CHECK_STATUSES,
  FUTURE_TOLERANCE_HOURS,
  MANUAL_STATUS_TARGETS,
  MAX_ANIMAL_HISTORY,
  MAX_BACKDATE_DAYS,
  MAX_BATCH_LENGTH,
  MAX_LIST_LIMIT,
  MAX_QUANTITY_USED,
  MAX_SCHEDULE_AHEAD_DAYS,
  MAX_TEXT_LENGTH,
  MAX_UPCOMING_DAYS,
  SERVER_MANAGED_FIELDS,
  VACCINATION_NO_PATTERN,
  VACCINATION_WARNING_HEALTH_STATUSES,
  VaccinationPermissions,
  VaccinationStatuses,
} from "./vaccination.constants.js";
import type { TVaccination, TVaccinationStatus } from "./vaccination.interface.js";
import { VaccinationModel } from "./vaccination.model.js";
import {
  addDays,
  ageInMonths,
  computeNextDue,
  DAY_MS,
  defaultDoseQuantity,
  generateVaccinationNo,
  startOfTodayUtc,
} from "./vaccination.utils.js";

const STATUSES = Object.values(VaccinationStatuses) as string[];
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
const sessionOpts = (session: ClientSession | null) => (session ? { session } : {});
const dayKey = (date: Date | string) => new Date(date).toISOString().slice(0, 10);

type TVaccinationDoc = TVaccination & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

/* -------------------------------------------------------------------------- */
/*                         Farm-scoped authorization                          */
/* -------------------------------------------------------------------------- */

type TAccess = {
  farmObjectId: Types.ObjectId;
  farmStatus: string;
  role: TFarmMemberRole;
  //FarmMember _id of the caller; null only for a super admin without a membership row
  memberObjectId: Types.ObjectId | null;
};

/** Active membership (super admin / Farm.ownerId act as Owner) + farm status. */
const resolveAccess = async (farmId: string, requesterUserId: string): Promise<TAccess> => {
  const access = await FarmMemberServices.resolveFarmAccess(farmId, requesterUserId);
  const role = FarmMemberServices.getActorRole(access);
  if (!role) throw new AppError(status.FORBIDDEN, "You are not an active member of this farm!");

  let memberObjectId = (access.membership?._id as Types.ObjectId | undefined) ?? null;
  if (!memberObjectId && access.isOwnerAccount) {
    //the owner account self-heals a missing Owner row so it can always sign records
    const row = await FarmMemberServices.ensureOwnerMembership(access.farm._id, access.user._id);
    memberObjectId = (row?._id as Types.ObjectId | undefined) ?? null;
  }
  const farm = await FarmModel.findById(access.farm._id).select("status").lean();
  return {
    farmObjectId: access.farm._id,
    farmStatus: farm?.status ?? FarmStatuses.ACTIVE,
    role,
    memberObjectId,
  };
};

const can = (access: TAccess, allowed: readonly TFarmMemberRole[]) => allowed.includes(access.role);

const requireRole = (access: TAccess, allowed: readonly TFarmMemberRole[], action: string) => {
  if (!can(access, allowed)) {
    throw new AppError(status.FORBIDDEN, `Your farm role (${access.role}) is not allowed to ${action}!`);
  }
};

/** Setup / Suspended / Inactive farms cannot write vaccinations (records stay readable). */
const requireWritableFarm = (access: TAccess) => {
  if (access.farmStatus !== FarmStatuses.ACTIVE) {
    throw new AppError(
      status.FORBIDDEN,
      `This farm is ${access.farmStatus} — vaccinations can only be written on an Active farm!`,
    );
  }
};

//createdBy / stock movements are signed by a FarmMember row
const requireMemberRow = (access: TAccess): Types.ObjectId => {
  if (!access.memberObjectId) {
    throw new AppError(status.FORBIDDEN, "An active farm membership is required to write vaccination records!");
  }
  return access.memberObjectId;
};

const rejectServerFields = (body: TPayload) => {
  const sent = SERVER_MANAGED_FIELDS.filter((field) => field in body);
  if (sent.length) {
    throw new AppError(status.BAD_REQUEST, `${sent.join(", ")} cannot be sent — the server manages these values.`);
  }
};

/* -------------------------------------------------------------------------- */
/*                               Field parsing                                */
/* -------------------------------------------------------------------------- */

const parseText = (field: string, value: unknown, max = MAX_TEXT_LENGTH): string | undefined => {
  if (isBlank(value)) return undefined;
  if (typeof value !== "string") throw new AppError(status.BAD_REQUEST, `${field} must be text!`);
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length > max) throw new AppError(status.BAD_REQUEST, `${field} cannot exceed ${max} characters!`);
  return text;
};

const parseBatch = (value: unknown) => parseText("batchNumber", value, MAX_BATCH_LENGTH)?.toUpperCase();

const parseQuantityUsed = (value: unknown) =>
  isBlank(value)
    ? null
    : round4(parseNumber("quantityUsed", value, { min: 0, max: MAX_QUANTITY_USED, exclusiveMin: true }));

/**
 * Calendar-day vaccination date with the status-specific rule (spec §69–71):
 *  - "administered" (Completed): not in the future, backdating allowed (MAX_BACKDATE_DAYS)
 *  - "planned" (Scheduled): may be in the future (MAX_SCHEDULE_AHEAD_DAYS)
 *  - "rescheduled": a new plan must be today or later
 * Never before the animal's birth date.
 */
const parseVaccinationDate = (
  field: string,
  value: unknown,
  mode: "administered" | "planned" | "rescheduled",
  birthDate?: Date | null,
): Date => {
  const date = parseCalendarDate(field, value);
  const now = Date.now();
  const today = startOfTodayUtc();
  if (mode === "administered" && date.getTime() > now + FUTURE_TOLERANCE_HOURS * 60 * 60 * 1000) {
    throw new AppError(status.BAD_REQUEST, `${field} cannot be in the future for a Completed vaccination!`);
  }
  if (mode === "rescheduled" && date < today) {
    throw new AppError(status.BAD_REQUEST, `${field} of a rescheduled dose must be today or later!`);
  }
  if (date.getTime() > now + MAX_SCHEDULE_AHEAD_DAYS * DAY_MS) {
    throw new AppError(status.BAD_REQUEST, `${field} cannot be more than ${MAX_SCHEDULE_AHEAD_DAYS} days ahead!`);
  }
  if (date.getTime() < now - MAX_BACKDATE_DAYS * DAY_MS) {
    throw new AppError(status.BAD_REQUEST, `${field} cannot be more than ${MAX_BACKDATE_DAYS} days in the past!`);
  }
  if (birthDate && date.getTime() < new Date(dayKey(birthDate)).getTime()) {
    throw new AppError(status.BAD_REQUEST, `${field} cannot be before the animal's birth date!`);
  }
  return date;
};

/* -------------------------------------------------------------------------- */
/*                               Reference lookups                            */
/* -------------------------------------------------------------------------- */

type TAnimalRef = {
  _id: Types.ObjectId;
  animalCode: string;
  name?: string;
  lifeStatus: string;
  healthStatus: string;
  birthDate?: Date | null;
};

const ANIMAL_FIELDS = "animalCode name gender lifeStatus healthStatus birthDate";

//animal reference: Mongo _id or the farm's animalCode (AN-000001), always farm-scoped
const findAnimal = async (access: TAccess, ref: unknown): Promise<TAnimalRef> => {
  const value = String(ref ?? "").trim();
  if (!value) throw new AppError(status.BAD_REQUEST, "animalId is required!");
  const animal = await AnimalModel.findOne(
    isValidObjectId(value)
      ? { _id: new Types.ObjectId(value), farmId: access.farmObjectId }
      : { animalCode: value.toUpperCase(), farmId: access.farmObjectId },
  )
    .select(ANIMAL_FIELDS)
    .lean();
  //an animal of another farm is reported as missing (farm isolation, spec §86)
  if (!animal) throw new AppError(status.NOT_FOUND, "Animal not found in this farm!");
  return animal as unknown as TAnimalRef;
};

//new doses only for Active animals (Sold / Dead / Transferred / Archived are read-only)
const requireActiveAnimal = (animal: TAnimalRef) => {
  if (animal.lifeStatus !== AnimalLifeStatuses.ACTIVE) {
    throw new AppError(
      status.CONFLICT,
      `${animal.animalCode} is ${animal.lifeStatus} — new vaccinations are only allowed for Active animals!`,
    );
  }
};

type TVaccineRef = {
  _id: Types.ObjectId;
  vaccineCode: string;
  vaccineName: string;
  shortCode: string;
  dosage: number;
  dosageUnit: string;
  administrationRoute: string;
  minimumAge?: number;
  boosterRequired: boolean;
  boosterAfterDays?: number;
  repeatIntervalDays?: number;
  isMandatory: boolean;
  isActive: boolean;
};

const VACCINE_FIELDS =
  "vaccineCode vaccineName shortCode dosage dosageUnit administrationRoute minimumAge boosterRequired boosterAfterDays repeatIntervalDays isMandatory isActive";

//vaccine reference: Mongo _id or vaccineCode (VAC-00001)
const findVaccine = async (ref: unknown): Promise<TVaccineRef> => {
  const value = String(ref ?? "").trim();
  if (!value) throw new AppError(status.BAD_REQUEST, "vaccineId is required!");
  const vaccine = await VaccineModel.findOne(
    isValidObjectId(value) ? { _id: new Types.ObjectId(value) } : { vaccineCode: value.toUpperCase() },
  )
    .select(VACCINE_FIELDS)
    .lean();
  if (!vaccine) throw new AppError(status.NOT_FOUND, "Vaccine not found in the vaccine catalog!");
  return vaccine as unknown as TVaccineRef;
};

//new routine doses need an active catalog entry (spec §85); history may keep retired ones
const requireActiveVaccine = (vaccine: TVaccineRef) => {
  if (!vaccine.isActive) {
    throw new AppError(status.CONFLICT, `${vaccine.vaccineName} is retired from the vaccine catalog!`);
  }
};

//administeredBy must be an active member of THIS farm (FarmMember _id)
const resolveAdministrator = async (access: TAccess, ref: unknown): Promise<Types.ObjectId> => {
  const value = String(ref ?? "").trim();
  if (!value) throw new AppError(status.BAD_REQUEST, "administeredBy is required for a Completed vaccination!");
  if (!isValidObjectId(value)) throw new AppError(status.BAD_REQUEST, "administeredBy must be a farm member id!");
  const member = await FarmMemberModel.findOne({
    _id: new Types.ObjectId(value),
    farmId: access.farmObjectId,
    isActive: true,
  })
    .select("_id")
    .lean();
  if (!member) throw new AppError(status.BAD_REQUEST, "administeredBy must be an active member of this farm!");
  return member._id as Types.ObjectId;
};

//same animal + vaccine + calendar day + (Scheduled | Completed) is a duplicate (final schema rule)
const findDuplicate = (
  access: TAccess,
  animalId: Types.ObjectId,
  vaccineId: Types.ObjectId,
  date: Date,
  excludeId: Types.ObjectId | null,
) =>
  VaccinationModel.findOne({
    farmId: access.farmObjectId,
    animalId,
    vaccineId,
    vaccinationDate: { $gte: date, $lt: addDays(date, 1) },
    status: { $in: DUPLICATE_CHECK_STATUSES as TVaccinationStatus[] },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  })
    .select("vaccinationNo status vaccinationDate")
    .lean();

const throwIfDuplicate = async (
  access: TAccess,
  animal: TAnimalRef,
  vaccine: TVaccineRef,
  date: Date,
  excludeId: Types.ObjectId | null,
) => {
  const duplicate = await findDuplicate(access, animal._id, vaccine._id, date, excludeId);
  if (duplicate) {
    throw new AppError(
      status.CONFLICT,
      `${animal.animalCode} already has ${vaccine.vaccineName} on ${dayKey(date)} (${duplicate.vaccinationNo}, ${duplicate.status}). Complete or edit that record instead.`,
    );
  }
};

//Completed doses of the same vaccine before `before` (decides primary / booster / repeat)
const countPriorCompleted = (
  access: TAccess,
  animalId: Types.ObjectId,
  vaccineId: Types.ObjectId,
  before: Date,
  excludeId: Types.ObjectId | null,
) =>
  VaccinationModel.countDocuments({
    farmId: access.farmObjectId,
    animalId,
    vaccineId,
    status: VaccinationStatuses.COMPLETED,
    vaccinationDate: { $lt: before },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  });

/** Non-blocking clinical warnings: minimum age, health status, open schedule. */
const eligibilityWarnings = async (
  access: TAccess,
  animal: TAnimalRef,
  vaccine: TVaccineRef,
  date: Date,
  excludeId: Types.ObjectId | null,
) => {
  const warnings: string[] = [];
  const ageMonths = ageInMonths(animal.birthDate, date);
  if (vaccine.minimumAge !== undefined && vaccine.minimumAge !== null) {
    if (ageMonths === null) {
      warnings.push(`${animal.animalCode} has no birth date — minimum age (${vaccine.minimumAge} months) could not be checked.`);
    } else if (ageMonths < vaccine.minimumAge) {
      warnings.push(
        `${animal.animalCode} is ${ageMonths} month(s) old on ${dayKey(date)}; ${vaccine.vaccineName} is recommended from ${vaccine.minimumAge} months.`,
      );
    }
  }
  if (VACCINATION_WARNING_HEALTH_STATUSES.includes(animal.healthStatus)) {
    warnings.push(`${animal.animalCode} is currently ${animal.healthStatus} — confirm with the veterinarian before vaccinating.`);
  }
  const openSchedule = await VaccinationModel.findOne({
    farmId: access.farmObjectId,
    animalId: animal._id,
    vaccineId: vaccine._id,
    status: VaccinationStatuses.SCHEDULED,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  })
    .select("vaccinationNo vaccinationDate")
    .lean();
  if (openSchedule) {
    warnings.push(
      `${openSchedule.vaccinationNo} already plans ${vaccine.vaccineName} for ${animal.animalCode} on ${dayKey(openSchedule.vaccinationDate)}.`,
    );
  }
  return { warnings, ageMonths };
};

/* -------------------------------------------------------------------------- */
/*                             Inventory integration                          */
/* -------------------------------------------------------------------------- */

type TDosePlan = {
  //false => the farm does not stock this vaccine in Inventory; nothing is deducted
  tracked: boolean;
  inventoryId: Types.ObjectId | null;
  inventoryCode: string | null;
  itemName: string;
  unit: string | null;
  quantity: number;
  stockBefore: number | null;
  expiryDate: Date | null;
};

type TMovement = {
  transactionNo: string;
  transactionType: string;
  inventoryCode: string | null;
  itemName: string;
  quantity: number;
  unit: string | null;
  stockBefore: number;
  stockAfter: number;
};

/**
 * Picks the farm's Vaccine stock row for one dose (FEFO: the usable row expiring first
 * that still holds enough stock). Expired / Inactive / insufficient stock is a blocker
 * (spec §47–48); a vaccine the farm does not stock at all only warns.
 */
const planDose = async (
  access: TAccess,
  vaccine: TVaccineRef,
  quantityOverride: number | null,
  warnings: string[],
  blockers: string[],
  session: ClientSession | null = null,
  //stock already held by this record (a correction re-deducts after returning it)
  creditByInventory: Map<string, number> = new Map(),
): Promise<TDosePlan> => {
  const rows = await InventoryModel.find({
    farmId: access.farmObjectId,
    itemType: InventoryItemTypes.VACCINE,
    referenceId: vaccine._id,
  })
    .select("inventoryCode itemName currentStock unit status expiryDate")
    .session(session)
    .lean();

  if (!rows.length) {
    warnings.push(`${vaccine.vaccineName} is not tracked in this farm's inventory — no stock was deducted.`);
    return {
      tracked: false,
      inventoryId: null,
      inventoryCode: null,
      itemName: vaccine.vaccineName,
      unit: null,
      quantity: quantityOverride ?? 1,
      stockBefore: null,
      expiryDate: null,
    };
  }

  const usable = rows
    .filter((row) => !isUnusableInventory(row))
    .sort((a, b) => {
      const ae = a.expiryDate ? new Date(a.expiryDate).getTime() : Number.MAX_SAFE_INTEGER;
      const be = b.expiryDate ? new Date(b.expiryDate).getTime() : Number.MAX_SAFE_INTEGER;
      return ae - be;
    });
  if (!usable.length) {
    blockers.push(`All ${vaccine.vaccineName} stock in this farm is expired or inactive.`);
    const row = rows[0]!;
    return {
      tracked: true,
      inventoryId: row._id as Types.ObjectId,
      inventoryCode: row.inventoryCode,
      itemName: row.itemName,
      unit: row.unit,
      quantity: quantityOverride ?? defaultDoseQuantity(vaccine, row.unit),
      stockBefore: row.currentStock,
      expiryDate: row.expiryDate ?? null,
    };
  }

  const available = (row: (typeof usable)[number]) =>
    round4(row.currentStock + (creditByInventory.get(String(row._id)) ?? 0));
  const quantityFor = (row: (typeof usable)[number]) => quantityOverride ?? defaultDoseQuantity(vaccine, row.unit);
  const pick = usable.find((row) => available(row) >= quantityFor(row)) ?? usable[0]!;
  const quantity = quantityFor(pick);
  if (available(pick) < quantity) {
    blockers.push(
      `Insufficient ${vaccine.vaccineName} stock: ${available(pick)} ${pick.unit} on hand, ${quantity} ${pick.unit} needed.`,
    );
  }
  return {
    tracked: true,
    inventoryId: pick._id as Types.ObjectId,
    inventoryCode: pick.inventoryCode,
    itemName: pick.itemName,
    unit: pick.unit,
    quantity,
    stockBefore: pick.currentStock,
    expiryDate: pick.expiryDate ?? null,
  };
};

/** Deducts one dose and writes a "Vaccination Usage" ledger row (referenceType Vaccination). */
const consumeDose = async (
  access: TAccess,
  recordId: Types.ObjectId,
  plan: TDosePlan,
  options: { session: ClientSession | null; undo: TUndo; memberId: Types.ObjectId; remarks: string },
): Promise<TMovement | null> => {
  if (!plan.tracked || !plan.inventoryId || plan.quantity <= 0) return null;
  const change = await applyStockChange(plan.inventoryId, -plan.quantity, {
    session: options.session,
    updatedBy: options.memberId,
  });
  if (!change) {
    throw new AppError(
      status.CONFLICT,
      `Stock of ${plan.itemName} changed while saving and is no longer sufficient (or it expired). Reload and try again.`,
    );
  }
  const inventoryId = plan.inventoryId;
  options.undo.push(() => applyStockChange(inventoryId, change.applied, { session: null, capAtZero: true }));

  const transactionNo = await generateTransactionNo();
  const [trx] = await InventoryTransactionModel.create(
    [
      {
        transactionNo,
        farmId: access.farmObjectId,
        inventoryId,
        transactionType: InventoryTransactionTypes.VACCINATION_USAGE,
        transactionDate: new Date(),
        quantity: change.applied,
        ...(plan.unit ? { unit: plan.unit as TInventoryUnit } : {}),
        referenceType: InventoryReferenceTypes.VACCINATION,
        referenceId: recordId,
        remarks: options.remarks,
        performedBy: options.memberId,
      },
    ],
    sessionOpts(options.session),
  );
  if (trx) options.undo.push(() => InventoryTransactionModel.deleteOne({ _id: trx._id }));
  return {
    transactionNo,
    transactionType: InventoryTransactionTypes.VACCINATION_USAGE,
    inventoryCode: plan.inventoryCode,
    itemName: plan.itemName,
    quantity: change.applied,
    unit: plan.unit,
    stockBefore: change.before,
    stockAfter: change.after,
  };
};

type TLedgerNet = { inventoryId: Types.ObjectId; inventoryCode: string | null; itemName: string; unit: string | null; net: number };

/** Net stock currently held by a record: Vaccination Usage minus Return, per inventory row. */
const loadLedgerNet = async (access: TAccess, recordId: Types.ObjectId, session: ClientSession | null = null) => {
  const rows = await InventoryTransactionModel.find({
    farmId: access.farmObjectId,
    referenceType: InventoryReferenceTypes.VACCINATION,
    referenceId: recordId,
  })
    .select("inventoryId transactionType quantity unit")
    .populate("inventoryId", "inventoryCode itemName unit")
    .session(session)
    .lean();
  const net = new Map<string, TLedgerNet>();
  for (const row of rows) {
    const inv = row.inventoryId as unknown as { _id: Types.ObjectId; inventoryCode?: string; itemName?: string; unit?: string } | null;
    if (!inv?._id) continue;
    const key = String(inv._id);
    const entry = net.get(key) ?? {
      inventoryId: inv._id,
      inventoryCode: inv.inventoryCode ?? null,
      itemName: inv.itemName ?? "Vaccine stock",
      unit: inv.unit ?? row.unit ?? null,
      net: 0,
    };
    const sign = row.transactionType === InventoryTransactionTypes.RETURN ? -1 : 1;
    entry.net = round4(entry.net + sign * row.quantity);
    net.set(key, entry);
  }
  return { hasLedger: rows.length > 0, lines: [...net.values()].filter((l) => l.net > 0) };
};

/** Returns every dose still held by the record to stock ("Return" rows). */
const restoreDoses = async (
  access: TAccess,
  recordId: Types.ObjectId,
  lines: TLedgerNet[],
  options: { session: ClientSession | null; undo: TUndo; memberId: Types.ObjectId; remarks: string },
): Promise<TMovement[]> => {
  const movements: TMovement[] = [];
  for (const line of lines) {
    const change = await applyStockChange(line.inventoryId, line.net, {
      session: options.session,
      updatedBy: options.memberId,
    });
    if (!change || change.applied === 0) continue;
    const inventoryId = line.inventoryId;
    const applied = change.applied;
    options.undo.push(() => applyStockChange(inventoryId, -applied, { session: null, capAtZero: true }));
    const transactionNo = await generateTransactionNo();
    const [trx] = await InventoryTransactionModel.create(
      [
        {
          transactionNo,
          farmId: access.farmObjectId,
          inventoryId,
          transactionType: InventoryTransactionTypes.RETURN,
          transactionDate: new Date(),
          quantity: applied,
          ...(line.unit ? { unit: line.unit as TInventoryUnit } : {}),
          referenceType: InventoryReferenceTypes.VACCINATION,
          referenceId: recordId,
          remarks: options.remarks,
          performedBy: options.memberId,
        },
      ],
      sessionOpts(options.session),
    );
    if (trx) options.undo.push(() => InventoryTransactionModel.deleteOne({ _id: trx._id }));
    movements.push({
      transactionNo,
      transactionType: InventoryTransactionTypes.RETURN,
      inventoryCode: line.inventoryCode,
      itemName: line.itemName,
      quantity: applied,
      unit: line.unit,
      stockBefore: change.before,
      stockAfter: change.after,
    });
  }
  return movements;
};

/* -------------------------------------------------------------------------- */
/*                                Read helpers                                */
/* -------------------------------------------------------------------------- */

const MEMBER_POPULATE = { select: "role userId", populate: { path: "userId", select: "userId fullName" } };

const populateRecord = <T>(query: T, detail = false): T => {
  const q = query as unknown as mongoose.Query<unknown, unknown>;
  return q
    .populate(
      "animalId",
      detail ? "animalCode name gender lifeStatus healthStatus birthDate profilePhoto" : "animalCode name lifeStatus",
    )
    .populate(
      "vaccineId",
      detail
        ? `${VACCINE_FIELDS} manufacturer category storageTemperature targetDiseaseIds`
        : "vaccineCode vaccineName shortCode isMandatory boosterRequired",
    )
    .populate({ path: "administeredBy", ...MEMBER_POPULATE })
    .populate({ path: "createdBy", ...MEMBER_POPULATE }) as unknown as T;
};

//record reference: Mongo _id or VACLOG-YYYY-NNNNNN, always farm-scoped
const findRecord = async (access: TAccess, ref: string): Promise<TVaccinationDoc> => {
  const value = String(ref ?? "").trim();
  let filter: Record<string, unknown>;
  if (isValidObjectId(value)) filter = { _id: new Types.ObjectId(value) };
  else if (VACCINATION_NO_PATTERN.test(value)) filter = { vaccinationNo: value.toUpperCase() };
  else throw new AppError(status.BAD_REQUEST, "Use a vaccination id or a VACLOG-YYYY-NNNNNN number!");
  const doc = await VaccinationModel.findOne({ ...filter, farmId: access.farmObjectId }).lean();
  if (!doc) throw new AppError(status.NOT_FOUND, "Vaccination record not found in this farm!");
  return doc as unknown as TVaccinationDoc;
};

const ledgerRows = (farmObjectId: Types.ObjectId, recordId: Types.ObjectId) =>
  InventoryTransactionModel.find({
    farmId: farmObjectId,
    referenceType: InventoryReferenceTypes.VACCINATION,
    referenceId: recordId,
  })
    .sort({ createdAt: 1 })
    .select("transactionNo transactionType transactionDate quantity unit remarks inventoryId performedBy createdAt")
    .populate("inventoryId", "inventoryCode itemName unit currentStock status expiryDate")
    .populate({ path: "performedBy", ...MEMBER_POPULATE })
    .lean();

/** Derived scheduling flags (overdue is never stored — spec §52–53). */
const derive = (record: { status: string; vaccinationDate: Date; nextDueDate?: Date | null }) => {
  const today = startOfTodayUtc();
  const dueDate =
    record.status === VaccinationStatuses.SCHEDULED
      ? new Date(record.vaccinationDate)
      : record.status === VaccinationStatuses.COMPLETED && record.nextDueDate
        ? new Date(record.nextDueDate)
        : null;
  const dueInDays = dueDate ? Math.round((dueDate.getTime() - today.getTime()) / DAY_MS) : null;
  return {
    dueDate,
    dueInDays,
    isOverdue: record.status === VaccinationStatuses.SCHEDULED && dueInDays !== null && dueInDays < 0,
  };
};

const loadDetail = async (access: TAccess, id: Types.ObjectId) => {
  const [record, inventoryTransactions] = await Promise.all([
    populateRecord(VaccinationModel.findById(id).select("-__v"), true).lean(),
    ledgerRows(access.farmObjectId, id),
  ]);
  const r = record as unknown as TVaccinationDoc;
  //batch recall helper: how many other animals of this farm got the same lot
  const batchSiblings = r.batchNumber
    ? await VaccinationModel.countDocuments({
        farmId: access.farmObjectId,
        batchNumber: r.batchNumber,
        status: VaccinationStatuses.COMPLETED,
        _id: { $ne: r._id },
      })
    : 0;
  return { ...(record as Record<string, unknown>), ...derive(r), batchSiblings, inventoryTransactions };
};

const auditSnapshot = (record: Partial<TVaccination>) => ({
  vaccinationNo: record.vaccinationNo,
  animalId: record.animalId,
  vaccineId: record.vaccineId,
  vaccinationDate: record.vaccinationDate,
  nextDueDate: record.nextDueDate ?? null,
  administeredBy: record.administeredBy ?? null,
  batchNumber: record.batchNumber ?? null,
  status: record.status,
  remarks: record.remarks ?? null,
});

const audit = (
  context: TAuditContext,
  farmId: Types.ObjectId,
  entityId: Types.ObjectId,
  action: TAuditAction,
  event: string,
  oldData: Record<string, unknown> | null,
  newData: Record<string, unknown> | null,
  changedFields: string[] = [],
) =>
  recordAuditLog({
    context,
    farmId,
    entityType: AuditEntityTypes.VACCINATION,
    entityId,
    action,
    module: AuditModules.HEALTH,
    event,
    oldData,
    newData,
    changedFields,
  });

/** Audit trace of an attempt, for the Rolled Back row. */
const traceOf = (
  context: TAuditContext | undefined,
  farmId: Types.ObjectId,
  entityId: Types.ObjectId | null,
  action: TAuditAction,
  event: string,
) => ({ context, farmId, entityType: AuditEntityTypes.VACCINATION, entityId, action, module: AuditModules.HEALTH, event });

const throwIfBlocked = (blockers: string[]) => {
  if (blockers.length) {
    throw new AppError(status.UNPROCESSABLE_ENTITY, `Vaccination cannot be completed: ${blockers.join(" ")}`);
  }
};

/* -------------------------------------------------------------------------- */
/*                                Draft (create)                              */
/* -------------------------------------------------------------------------- */

type TDraft = {
  animal: TAnimalRef;
  vaccine: TVaccineRef;
  status: TVaccinationStatus;
  vaccinationDate: Date;
  administeredBy: Types.ObjectId | null;
  batchNumber: string | null;
  remarks: string | undefined;
  nextDueDate: Date | null;
  doseStage: string | null;
  nextDoseType: string | null;
  ageMonths: number | null;
  dose: TDosePlan | null;
  warnings: string[];
  blockers: string[];
};

/** Validates a create/preview body. Nothing is written. */
const buildDraft = async (access: TAccess, body: TPayload): Promise<TDraft> => {
  const statusValue = isBlank(body.status) ? VaccinationStatuses.SCHEDULED : String(body.status);
  if (statusValue !== VaccinationStatuses.SCHEDULED && statusValue !== VaccinationStatuses.COMPLETED) {
    throw new AppError(status.BAD_REQUEST, "A new vaccination must be Scheduled or Completed!");
  }
  const completed = statusValue === VaccinationStatuses.COMPLETED;

  const animal = await findAnimal(access, body.animalId);
  requireActiveAnimal(animal);
  const vaccine = await findVaccine(body.vaccineId);
  requireActiveVaccine(vaccine);

  const vaccinationDate = parseVaccinationDate(
    "vaccinationDate",
    body.vaccinationDate,
    completed ? "administered" : "planned",
    animal.birthDate,
  );
  if (!completed && vaccinationDate < startOfTodayUtc()) {
    throw new AppError(
      status.BAD_REQUEST,
      "A Scheduled vaccination cannot be planned in the past — record it as Completed (if it was given) instead.",
    );
  }
  await throwIfDuplicate(access, animal, vaccine, vaccinationDate, null);

  const remarks = parseText("remarks", body.remarks);
  const { warnings, ageMonths } = await eligibilityWarnings(access, animal, vaccine, vaccinationDate, null);
  const blockers: string[] = [];

  if (!completed) {
    if (!isBlank(body.administeredBy) || !isBlank(body.batchNumber) || !isBlank(body.quantityUsed)) {
      throw new AppError(
        status.BAD_REQUEST,
        "administeredBy, batchNumber and quantityUsed are recorded when the dose is completed, not when it is scheduled.",
      );
    }
    return {
      animal,
      vaccine,
      status: VaccinationStatuses.SCHEDULED,
      vaccinationDate,
      administeredBy: null,
      batchNumber: null,
      remarks,
      nextDueDate: null,
      doseStage: null,
      nextDoseType: null,
      ageMonths,
      dose: null,
      warnings,
      blockers,
    };
  }

  const administeredBy = await resolveAdministrator(access, body.administeredBy);
  const batchNumber = parseBatch(body.batchNumber);
  if (!batchNumber) throw new AppError(status.BAD_REQUEST, "batchNumber is required for a Completed vaccination!");
  const prior = await countPriorCompleted(access, animal._id, vaccine._id, vaccinationDate, null);
  const schedule = computeNextDue(vaccine, vaccinationDate, prior);
  const dose = await planDose(access, vaccine, parseQuantityUsed(body.quantityUsed), warnings, blockers);

  return {
    animal,
    vaccine,
    status: VaccinationStatuses.COMPLETED,
    vaccinationDate,
    administeredBy,
    batchNumber,
    remarks,
    nextDueDate: schedule.nextDueDate,
    doseStage: schedule.stage,
    nextDoseType: schedule.nextDoseType,
    ageMonths,
    dose,
    warnings,
    blockers,
  };
};

const draftView = (draft: TDraft) => ({
  animal: {
    _id: draft.animal._id,
    animalCode: draft.animal.animalCode,
    name: draft.animal.name ?? null,
    lifeStatus: draft.animal.lifeStatus,
    healthStatus: draft.animal.healthStatus,
    ageMonths: draft.ageMonths,
  },
  vaccine: {
    _id: draft.vaccine._id,
    vaccineCode: draft.vaccine.vaccineCode,
    vaccineName: draft.vaccine.vaccineName,
    dosage: draft.vaccine.dosage,
    dosageUnit: draft.vaccine.dosageUnit,
    administrationRoute: draft.vaccine.administrationRoute,
    minimumAge: draft.vaccine.minimumAge ?? null,
    isMandatory: draft.vaccine.isMandatory,
  },
  status: draft.status,
  vaccinationDate: draft.vaccinationDate,
  nextDueDate: draft.nextDueDate,
  doseStage: draft.doseStage,
  nextDoseType: draft.nextDoseType,
  administeredBy: draft.administeredBy,
  batchNumber: draft.batchNumber,
  remarks: draft.remarks ?? null,
  stock: draft.dose,
});

/* -------------------------------------------------------------------------- */
/*                                   Writes                                   */
/* -------------------------------------------------------------------------- */

/** POST /preview — eligibility, duplicate, due date and stock check. Nothing is written. */
const previewVaccination = async (farmId: string, requesterUserId: string, payload: TPayload) => {
  const body = payload ?? {};
  rejectServerFields(body);
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, VaccinationPermissions.CREATE, "record vaccinations");
  const draft = await buildDraft(access, body);
  return {
    ...draftView(draft),
    warnings: draft.warnings,
    blockers: draft.blockers,
    canSave: draft.blockers.length === 0 && access.farmStatus === FarmStatuses.ACTIVE,
    isPreview: true,
  };
};

/**
 * POST / — schedules a dose (no stock) or records an already-administered one.
 * A Completed create runs in ONE transaction: insert the record, deduct one dose from
 * the farm's vaccine stock and write the "Vaccination Usage" ledger row.
 */
const createVaccination = async (
  farmId: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  rejectServerFields(body);
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, VaccinationPermissions.CREATE, "record vaccinations");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);

  const draft = await buildDraft(access, body);
  throwIfBlocked(draft.blockers);

  const vaccinationNo = await generateVaccinationNo();
  const data: TVaccination = {
    vaccinationNo,
    farmId: access.farmObjectId,
    animalId: draft.animal._id,
    vaccineId: draft.vaccine._id,
    vaccinationDate: draft.vaccinationDate,
    nextDueDate: draft.nextDueDate,
    administeredBy: draft.administeredBy,
    batchNumber: draft.batchNumber,
    status: draft.status,
    ...(draft.remarks ? { remarks: draft.remarks } : {}),
    createdBy: memberId,
  };

  const completed = draft.status === VaccinationStatuses.COMPLETED;
  const { record, movement } = await executeAtomically(async (session, undo) => {
    const [doc] = await VaccinationModel.create([data], sessionOpts(session));
    if (!doc) throw new AppError(status.INTERNAL_SERVER_ERROR, "Failed to save the vaccination!");
    undo.push(() => VaccinationModel.deleteOne({ _id: doc._id }));
    const moved = draft.dose
      ? await consumeDose(access, doc._id, draft.dose, {
          session,
          undo,
          memberId,
          remarks: `${vaccinationNo} — ${draft.vaccine.vaccineName} for ${draft.animal.animalCode}`,
        })
      : null;
    return { record: doc, movement: moved };
  }, {
    trace: traceOf(context, access.farmObjectId, null, AuditActions.CREATE, "Vaccination"),
    log: async ({ record, movement }) => {
      await audit(
        context,
        access.farmObjectId,
        record._id,
        AuditActions.CREATE,
        completed ? "Vaccination Completed" : "Vaccination Scheduled",
        null,
        { ...auditSnapshot(data), inventory: movement },
      );
    },
  });

  return {
    vaccination: await loadDetail(access, record._id),
    doseStage: draft.doseStage,
    nextDoseType: draft.nextDoseType,
    stockMovement: movement,
    warnings: draft.warnings,
  };
};

/**
 * PATCH /:id/complete — Scheduled → Completed. Records the actual date, administrator
 * and batch, derives nextDueDate and deducts one dose, all in one transaction. The
 * status guard in the update filter stops two people completing the same dose.
 */
const completeVaccination = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  rejectServerFields(body);
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, VaccinationPermissions.COMPLETE, "complete vaccinations");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);

  const doc = await findRecord(access, id);
  if (doc.status !== VaccinationStatuses.SCHEDULED) {
    throw new AppError(
      status.CONFLICT,
      `Only a Scheduled vaccination can be completed (this one is ${doc.status}). Create a new record instead.`,
    );
  }

  const animal = await findAnimal(access, String(doc.animalId));
  requireActiveAnimal(animal);
  const vaccine = await findVaccine(String(doc.vaccineId));
  requireActiveVaccine(vaccine);

  const vaccinationDate = isBlank(body.vaccinationDate)
    ? startOfTodayUtc()
    : parseVaccinationDate("vaccinationDate", body.vaccinationDate, "administered", animal.birthDate);
  if (vaccinationDate.getTime() > Date.now() + FUTURE_TOLERANCE_HOURS * 60 * 60 * 1000) {
    throw new AppError(status.BAD_REQUEST, "vaccinationDate cannot be in the future for a Completed vaccination!");
  }
  await throwIfDuplicate(access, animal, vaccine, vaccinationDate, doc._id);

  const administeredBy = await resolveAdministrator(access, body.administeredBy);
  const batchNumber = parseBatch(body.batchNumber);
  if (!batchNumber) throw new AppError(status.BAD_REQUEST, "batchNumber is required to complete a vaccination!");
  const remarks = parseText("remarks", body.remarks);

  const { warnings } = await eligibilityWarnings(access, animal, vaccine, vaccinationDate, doc._id);
  const blockers: string[] = [];
  const prior = await countPriorCompleted(access, animal._id, vaccine._id, vaccinationDate, doc._id);
  const schedule = computeNextDue(vaccine, vaccinationDate, prior);
  const dose = await planDose(access, vaccine, parseQuantityUsed(body.quantityUsed), warnings, blockers);
  throwIfBlocked(blockers);

  const update = {
    status: VaccinationStatuses.COMPLETED,
    vaccinationDate,
    administeredBy,
    batchNumber,
    nextDueDate: schedule.nextDueDate,
    ...(remarks ? { remarks } : {}),
  };

  const movement = await executeAtomically(async (session, undo) => {
    const updated = await VaccinationModel.findOneAndUpdate(
      { _id: doc._id, status: VaccinationStatuses.SCHEDULED },
      { $set: update },
      { returnDocument: "after", ...sessionOpts(session) },
    );
    if (!updated) throw new AppError(status.CONFLICT, "This vaccination was changed by someone else. Reload and try again.");
    undo.push(() =>
      VaccinationModel.updateOne(
        { _id: doc._id },
        {
          $set: {
            status: doc.status,
            vaccinationDate: doc.vaccinationDate,
            administeredBy: doc.administeredBy ?? null,
            batchNumber: doc.batchNumber ?? null,
            nextDueDate: doc.nextDueDate ?? null,
            ...(doc.remarks !== undefined ? { remarks: doc.remarks } : {}),
          },
        },
      ),
    );
    return consumeDose(access, doc._id, dose, {
      session,
      undo,
      memberId,
      remarks: `${doc.vaccinationNo} — ${vaccine.vaccineName} for ${animal.animalCode}`,
    });
  }, {
    trace: traceOf(context, access.farmObjectId, doc._id, AuditActions.UPDATE, "Vaccination Completed"),
    log: async (movement) => {
      await audit(
        context,
        access.farmObjectId,
        doc._id,
        AuditActions.UPDATE,
        "Vaccination Completed",
        auditSnapshot(doc),
        { ...auditSnapshot({ ...doc, ...update }), inventory: movement },
        ["status", "vaccinationDate", "administeredBy", "batchNumber", "nextDueDate", ...(remarks ? ["remarks"] : [])],
      );
    },
  });

  return {
    vaccination: await loadDetail(access, doc._id),
    doseStage: schedule.stage,
    nextDoseType: schedule.nextDoseType,
    stockMovement: movement,
    warnings,
  };
};

/**
 * PATCH /:id/status — Scheduled → Missed | Cancelled (reason stored in remarks), never
 * touching stock. Optional `reschedule` creates a NEW Scheduled record so the missed
 * event stays in history (spec §75).
 * Completed → Cancelled is the formal reversal of a wrongly recorded dose (Owner /
 * Manager only): the dose is returned to stock and the reversal is audited.
 */
const changeStatus = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, VaccinationPermissions.CHANGE_STATUS, "change vaccination status");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);

  const target = String(body.status ?? "");
  if (!(MANUAL_STATUS_TARGETS as readonly string[]).includes(target)) {
    throw new AppError(status.BAD_REQUEST, `status must be one of: ${MANUAL_STATUS_TARGETS.join(", ")}!`);
  }
  const reason = parseText("remarks", body.remarks);
  if (!reason || reason.length < 3) {
    throw new AppError(status.BAD_REQUEST, "remarks (the reason) is required to mark a vaccination Missed or Cancelled!");
  }

  const doc = await findRecord(access, id);
  const reversing = doc.status === VaccinationStatuses.COMPLETED && target === VaccinationStatuses.CANCELLED;

  if (doc.status !== VaccinationStatuses.SCHEDULED && !reversing) {
    throw new AppError(status.CONFLICT, `A ${doc.status} vaccination cannot be marked ${target}!`);
  }
  if (reversing) {
    requireRole(access, VaccinationPermissions.REVERSE_COMPLETED, "reverse a completed vaccination");
    if (body.reschedule) throw new AppError(status.BAD_REQUEST, "A reversed dose cannot be rescheduled here — create a new vaccination instead.");
  }
  if (target === VaccinationStatuses.MISSED && new Date(doc.vaccinationDate) > startOfTodayUtc()) {
    throw new AppError(
      status.BAD_REQUEST,
      `This dose is planned for ${dayKey(doc.vaccinationDate)} — it can only be marked Missed once that date has passed. Cancel it instead.`,
    );
  }

  //validate the follow-up before writing anything
  let followUp: TVaccination | null = null;
  let followUpWarnings: string[] = [];
  if (body.reschedule) {
    const re = body.reschedule as TPayload;
    const animal = await findAnimal(access, String(doc.animalId));
    requireActiveAnimal(animal);
    const vaccine = await findVaccine(String(doc.vaccineId));
    requireActiveVaccine(vaccine);
    const date = parseVaccinationDate("reschedule.vaccinationDate", re.vaccinationDate, "rescheduled", animal.birthDate);
    await throwIfDuplicate(access, animal, vaccine, date, doc._id);
    followUpWarnings = (await eligibilityWarnings(access, animal, vaccine, date, doc._id)).warnings;
    const note = parseText("reschedule.remarks", re.remarks);
    followUp = {
      vaccinationNo: await generateVaccinationNo(),
      farmId: access.farmObjectId,
      animalId: doc.animalId,
      vaccineId: doc.vaccineId,
      vaccinationDate: date,
      nextDueDate: null,
      administeredBy: null,
      batchNumber: null,
      status: VaccinationStatuses.SCHEDULED,
      remarks: (note ? `${note} — ` : "") + `Rescheduled from ${doc.vaccinationNo} (${target}).`,
      createdBy: memberId,
    };
  }

  const remarks = (doc.remarks && reversing ? `${doc.remarks} | ` : "") + `${target}: ${reason}`;
  const { created, movements } = await executeAtomically(async (session, undo) => {
    const updated = await VaccinationModel.findOneAndUpdate(
      { _id: doc._id, status: doc.status },
      { $set: { status: target, remarks, ...(reversing ? { nextDueDate: null } : {}) } },
      { returnDocument: "after", ...sessionOpts(session) },
    );
    if (!updated) throw new AppError(status.CONFLICT, "This vaccination was changed by someone else. Reload and try again.");
    undo.push(() =>
      VaccinationModel.updateOne(
        { _id: doc._id },
        { $set: { status: doc.status, nextDueDate: doc.nextDueDate ?? null, ...(doc.remarks !== undefined ? { remarks: doc.remarks } : {}) } },
      ),
    );

    let moved: TMovement[] = [];
    if (reversing) {
      const ledger = await loadLedgerNet(access, doc._id, session);
      moved = await restoreDoses(access, doc._id, ledger.lines, {
        session,
        undo,
        memberId,
        remarks: `${doc.vaccinationNo} reversed — ${reason}`,
      });
    }

    let next: { _id: Types.ObjectId } | null = null;
    if (followUp) {
      const [row] = await VaccinationModel.create([followUp], sessionOpts(session));
      if (row) {
        next = { _id: row._id };
        undo.push(() => VaccinationModel.deleteOne({ _id: row._id }));
      }
    }
    return { created: next, movements: moved };
  }, {
    trace: traceOf(context, access.farmObjectId, doc._id, AuditActions.UPDATE, `Vaccination ${target}`),
    log: async ({ created, movements }) => {
      const event = reversing ? "Vaccination Reversed" : target === VaccinationStatuses.MISSED ? "Vaccination Missed" : "Vaccination Cancelled";
      await audit(
        context,
        access.farmObjectId,
        doc._id,
        AuditActions.UPDATE,
        event,
        auditSnapshot(doc),
        { ...auditSnapshot({ ...doc, status: target as TVaccinationStatus, remarks }), inventory: movements },
        ["status", "remarks", ...(reversing ? ["nextDueDate"] : [])],
      );
      if (!created || !followUp) return;
      await audit(context, access.farmObjectId, created._id, AuditActions.CREATE, "Vaccination Scheduled", null, {
        ...auditSnapshot(followUp),
        rescheduledFrom: doc.vaccinationNo,
      });
    },
  });

  return {
    vaccination: await loadDetail(access, doc._id),
    rescheduled: created ? await loadDetail(access, created._id) : null,
    stockMovements: movements,
    warnings: followUpWarnings,
  };
};

/**
 * PUT /:id — controlled correction (Owner / Manager / Vet) with AuditLog old/new data.
 *  - Scheduled: vaccine, planned date, batch, remarks
 *  - Completed: batch, remarks, nextDueDate, administeredBy, actual date, vaccine,
 *    quantityUsed (a `reason` is required). A changed vaccine or dose quantity returns
 *    the held stock and deducts the corrected dose in the same transaction.
 *  - Missed / Cancelled: remarks only
 * The animal never changes (reverse the dose and record it again instead).
 */
const updateVaccination = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  rejectServerFields(body);
  for (const field of ["animalId", "status"]) {
    if (field in body) {
      throw new AppError(
        status.BAD_REQUEST,
        field === "status"
          ? "status changes go through PATCH /:id/complete or PATCH /:id/status."
          : "animalId cannot be changed — reverse this dose and record it for the right animal.",
      );
    }
  }
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, VaccinationPermissions.UPDATE, "correct vaccinations");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);

  const doc = await findRecord(access, id);
  const isCompleted = doc.status === VaccinationStatuses.COMPLETED;
  const isScheduled = doc.status === VaccinationStatuses.SCHEDULED;

  const allowed = isCompleted
    ? ["vaccineId", "vaccinationDate", "nextDueDate", "administeredBy", "batchNumber", "remarks", "quantityUsed", "reason"]
    : isScheduled
      ? ["vaccineId", "vaccinationDate", "batchNumber", "remarks", "reason"]
      : ["remarks", "reason"];
  const refused = Object.keys(body).filter((key) => !allowed.includes(key));
  if (refused.length) {
    throw new AppError(status.BAD_REQUEST, `${refused.join(", ")} cannot be changed on a ${doc.status} vaccination!`);
  }

  const reason = parseText("reason", body.reason);
  if (isCompleted && !reason) {
    throw new AppError(status.BAD_REQUEST, "reason is required to correct a Completed vaccination!");
  }

  const animal = await findAnimal(access, String(doc.animalId));
  const set: Record<string, unknown> = {};
  const warnings: string[] = [];

  //vaccine
  let vaccine = await findVaccine(String(doc.vaccineId));
  if (!isBlank(body.vaccineId)) {
    const next = await findVaccine(body.vaccineId);
    if (String(next._id) !== String(doc.vaccineId)) {
      requireActiveVaccine(next);
      vaccine = next;
      set.vaccineId = next._id;
    }
  }

  //date
  let vaccinationDate = new Date(doc.vaccinationDate);
  if (!isBlank(body.vaccinationDate)) {
    const date = parseVaccinationDate(
      "vaccinationDate",
      body.vaccinationDate,
      isCompleted ? "administered" : "planned",
      animal.birthDate,
    );
    if (isScheduled && date < startOfTodayUtc()) {
      throw new AppError(status.BAD_REQUEST, "A Scheduled vaccination cannot be moved into the past!");
    }
    if (date.getTime() !== vaccinationDate.getTime()) {
      vaccinationDate = date;
      set.vaccinationDate = date;
    }
  }
  if (set.vaccineId || set.vaccinationDate) {
    await throwIfDuplicate(access, animal, vaccine, vaccinationDate, doc._id);
    warnings.push(...(await eligibilityWarnings(access, animal, vaccine, vaccinationDate, doc._id)).warnings);
  }

  if ("batchNumber" in body) {
    const batch = body.batchNumber === null ? null : (parseBatch(body.batchNumber) ?? null);
    if (isCompleted && !batch) throw new AppError(status.BAD_REQUEST, "A Completed vaccination must keep a batchNumber!");
    if (batch !== (doc.batchNumber ?? null)) set.batchNumber = batch;
  }
  if ("remarks" in body) {
    const remarks = parseText("remarks", body.remarks) ?? "";
    if (remarks !== (doc.remarks ?? "")) set.remarks = remarks;
  }
  if (isCompleted && !isBlank(body.administeredBy)) {
    const admin = await resolveAdministrator(access, body.administeredBy);
    if (String(admin) !== String(doc.administeredBy ?? "")) set.administeredBy = admin;
  }

  //nextDueDate: explicit value wins, otherwise re-derived when vaccine/date changed
  if (isCompleted) {
    if ("nextDueDate" in body) {
      const due = body.nextDueDate === null ? null : parseCalendarDate("nextDueDate", body.nextDueDate);
      if (due && due <= vaccinationDate) throw new AppError(status.BAD_REQUEST, "nextDueDate must be after the vaccination date!");
      if ((due?.getTime() ?? null) !== (doc.nextDueDate ? new Date(doc.nextDueDate).getTime() : null)) set.nextDueDate = due;
    } else if (set.vaccineId || set.vaccinationDate) {
      const prior = await countPriorCompleted(access, animal._id, vaccine._id, vaccinationDate, doc._id);
      const due = computeNextDue(vaccine, vaccinationDate, prior).nextDueDate;
      if ((due?.getTime() ?? null) !== (doc.nextDueDate ? new Date(doc.nextDueDate).getTime() : null)) set.nextDueDate = due;
    }
  }

  //inventory reconciliation (Completed only): vaccine changed or a new dose quantity sent
  const quantityUsed = isCompleted ? parseQuantityUsed(body.quantityUsed) : null;
  const ledger = isCompleted ? await loadLedgerNet(access, doc._id) : { hasLedger: false, lines: [] as TLedgerNet[] };
  const heldTotal = round4(ledger.lines.reduce((sum, l) => sum + l.net, 0));
  const reconcile =
    isCompleted && (!!set.vaccineId || (quantityUsed !== null && quantityUsed !== heldTotal));
  let dose: TDosePlan | null = null;
  if (reconcile) {
    const blockers: string[] = [];
    //stock this record already holds counts as available when re-deducting the same row
    const credit = new Map(ledger.lines.map((l) => [String(l.inventoryId), l.net]));
    dose = await planDose(access, vaccine, quantityUsed, warnings, blockers, null, set.vaccineId ? new Map() : credit);
    throwIfBlocked(blockers);
  }

  const changedFields = Object.keys(set);
  if (!changedFields.length && !reconcile) {
    return { mode: "unchanged" as const, vaccination: await loadDetail(access, doc._id), stockMovements: [], warnings };
  }

  const movements = await executeAtomically(async (session, undo) => {
    const updated = await VaccinationModel.findOneAndUpdate(
      { _id: doc._id, status: doc.status, updatedAt: doc.updatedAt },
      { $set: set },
      { returnDocument: "after", ...sessionOpts(session) },
    );
    if (!updated) throw new AppError(status.CONFLICT, "This vaccination was changed by someone else. Reload and try again.");
    const restoreSet: Record<string, unknown> = {};
    for (const key of changedFields) restoreSet[key] = (doc as unknown as Record<string, unknown>)[key] ?? null;
    undo.push(() => VaccinationModel.updateOne({ _id: doc._id }, { $set: restoreSet }));

    const moved: TMovement[] = [];
    if (reconcile && dose) {
      moved.push(
        ...(await restoreDoses(access, doc._id, ledger.lines, {
          session,
          undo,
          memberId,
          remarks: `${doc.vaccinationNo} corrected — ${reason}`,
        })),
      );
      const used = await consumeDose(access, doc._id, dose, {
        session,
        undo,
        memberId,
        remarks: `${doc.vaccinationNo} corrected — ${vaccine.vaccineName} for ${animal.animalCode}`,
      });
      if (used) moved.push(used);
    }
    return moved;
  }, {
    trace: traceOf(context, access.farmObjectId, doc._id, AuditActions.UPDATE, "Vaccination Updated"),
    log: async (movements) => {
      const oldData: Record<string, unknown> = {};
      const newData: Record<string, unknown> = {};
      for (const key of changedFields) {
        oldData[key] = (doc as unknown as Record<string, unknown>)[key] ?? null;
        newData[key] = set[key];
      }
      if (reason) newData.reason = reason;
      if (movements.length) newData.inventory = movements;
      let event = "Vaccination Updated";
      if (changedFields.length === 1) {
        event =
          {
            batchNumber: "Batch Changed",
            administeredBy: "Administrator Changed",
            vaccinationDate: "Vaccination Date Changed",
            nextDueDate: "Next Due Date Changed",
            vaccineId: "Vaccine Changed",
          }[changedFields[0] as string] ?? event;
      }
      await audit(context, access.farmObjectId, doc._id, AuditActions.UPDATE, event, oldData, newData, [
        ...changedFields,
        ...(movements.length ? ["inventory"] : []),
      ]);
    },
  });

  return { mode: "corrected" as const, vaccination: await loadDetail(access, doc._id), stockMovements: movements, warnings };
};

/**
 * DELETE /:id — Owner only. Completed / Missed records are history and are never
 * deleted; a Cancelled record that once consumed stock (a reversed dose) keeps its
 * ledger trail and cannot be deleted either. Only unexecuted drafts go.
 */
const deleteVaccination = async (farmId: string, id: string, requesterUserId: string, context: TAuditContext) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, VaccinationPermissions.DELETE, "delete vaccinations");
  requireWritableFarm(access);

  const doc = await findRecord(access, id);
  if (!DELETABLE_STATUSES.includes(doc.status)) {
    throw new AppError(
      status.CONFLICT,
      doc.status === VaccinationStatuses.COMPLETED
        ? "A Completed vaccination already affected stock and the health timeline — it cannot be deleted. Use a correction or reverse it (status Cancelled)."
        : `A ${doc.status} vaccination is kept as schedule history and cannot be deleted.`,
    );
  }
  const ledger = await loadLedgerNet(access, doc._id);
  if (ledger.hasLedger) {
    throw new AppError(status.CONFLICT, "This record has stock movements (a reversed dose) and is kept for traceability.");
  }

  await executeAtomically(async (session, undo) => {
    const removed = await VaccinationModel.deleteOne({ _id: doc._id, status: doc.status }, sessionOpts(session));
    if (!removed.deletedCount) throw new AppError(status.CONFLICT, "This vaccination was changed by someone else. Reload and try again.");
    undo.push(() => VaccinationModel.create([doc]));
  }, {
    trace: traceOf(context, access.farmObjectId, doc._id, AuditActions.DELETE, "Vaccination Deleted"),
    log: async () => {
      await audit(context, access.farmObjectId, doc._id, AuditActions.DELETE, "Vaccination Deleted", auditSnapshot(doc), null);
    },
  });
  return { _id: doc._id, vaccinationNo: doc.vaccinationNo, deleted: true };
};

/* -------------------------------------------------------------------------- */
/*                                   Reads                                    */
/* -------------------------------------------------------------------------- */

type TDueDose = {
  recordId: Types.ObjectId;
  animalId: Types.ObjectId;
  vaccineId: Types.ObjectId;
  lastVaccinationDate: Date;
  nextDueDate: Date;
};

/**
 * Booster / repeat doses that are due: the LATEST Completed dose per animal + vaccine
 * whose nextDueDate is set, with no open Scheduled record for that pair (a planned
 * follow-up is tracked by its own vaccinationDate instead). Active animals only.
 */
const findDueDoses = async (
  access: TAccess,
  options: { animalId?: Types.ObjectId; dueBefore?: Date; dueFrom?: Date } = {},
): Promise<TDueDose[]> => {
  const match: Record<string, unknown> = { farmId: access.farmObjectId, status: VaccinationStatuses.COMPLETED };
  if (options.animalId) match.animalId = options.animalId;
  const latest = await VaccinationModel.aggregate<TDueDose & { _id: unknown }>([
    { $match: match },
    { $sort: { vaccinationDate: -1, createdAt: -1 } },
    {
      $group: {
        _id: { animalId: "$animalId", vaccineId: "$vaccineId" },
        recordId: { $first: "$_id" },
        lastVaccinationDate: { $first: "$vaccinationDate" },
        nextDueDate: { $first: "$nextDueDate" },
      },
    },
    { $match: { nextDueDate: { $ne: null } } },
    ...(options.dueBefore || options.dueFrom
      ? [
          {
            $match: {
              nextDueDate: {
                ...(options.dueFrom ? { $gte: options.dueFrom } : {}),
                ...(options.dueBefore ? { $lt: options.dueBefore } : {}),
              },
            },
          },
        ]
      : []),
    { $project: { _id: 0, recordId: 1, lastVaccinationDate: 1, nextDueDate: 1, animalId: "$_id.animalId", vaccineId: "$_id.vaccineId" } },
  ]);
  if (!latest.length) return [];

  const [openSchedules, activeAnimals] = await Promise.all([
    VaccinationModel.find({
      farmId: access.farmObjectId,
      status: VaccinationStatuses.SCHEDULED,
      ...(options.animalId ? { animalId: options.animalId } : {}),
    })
      .select("animalId vaccineId")
      .lean(),
    AnimalModel.find({
      farmId: access.farmObjectId,
      lifeStatus: AnimalLifeStatuses.ACTIVE,
      _id: { $in: [...new Set(latest.map((l) => String(l.animalId)))].map((v) => new Types.ObjectId(v)) },
    })
      .select("_id")
      .lean(),
  ]);
  const planned = new Set(openSchedules.map((s) => `${s.animalId}:${s.vaccineId}`));
  const active = new Set(activeAnimals.map((a) => String(a._id)));
  return latest.filter((l) => active.has(String(l.animalId)) && !planned.has(`${l.animalId}:${l.vaccineId}`));
};

const LIST_SORT_FIELDS = new Set(["vaccinationDate", "nextDueDate", "createdAt", "updatedAt", "status", "vaccinationNo"]);

const parseSort = (value: unknown): Record<string, 1 | -1> => {
  const raw = isBlank(value) ? "-vaccinationDate" : String(value);
  const sort: Record<string, 1 | -1> = {};
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const desc = part.startsWith("-");
    const field = desc ? part.slice(1) : part;
    if (!LIST_SORT_FIELDS.has(field)) {
      throw new AppError(status.BAD_REQUEST, `sort must use: ${[...LIST_SORT_FIELDS].join(", ")}!`);
    }
    sort[field] = desc ? -1 : 1;
  }
  sort._id = -1;
  return sort;
};

const parseWindowDays = (value: unknown) =>
  isBlank(value)
    ? DEFAULT_UPCOMING_DAYS
    : Math.floor(parseNumber("upcomingDays", value, { min: 1, max: MAX_UPCOMING_DAYS }));

/** GET / — farm-wide vaccinations with filters + pagination. */
const getFarmVaccinations = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const filter: Record<string, unknown> = { farmId: access.farmObjectId };
  const and: Record<string, unknown>[] = [];

  if (!isBlank(query.animalId)) filter.animalId = (await findAnimal(access, query.animalId))._id;
  if (!isBlank(query.vaccineId)) filter.vaccineId = (await findVaccine(query.vaccineId))._id;
  if (!isBlank(query.status)) filter.status = { $in: parseEnumList("status", query.status, STATUSES) };
  if (!isBlank(query.batchNumber)) {
    //exact lot (batch recall) — stored uppercase
    filter.batchNumber = String(query.batchNumber).trim().toUpperCase();
  }
  if (!isBlank(query.administeredBy)) {
    if (!isValidObjectId(String(query.administeredBy))) throw new AppError(status.BAD_REQUEST, "administeredBy must be a member id!");
    filter.administeredBy = new Types.ObjectId(String(query.administeredBy));
  }
  Object.assign(filter, parseDateRange(query, "vaccinationDate"));
  if (!isBlank(query.searchTerm)) {
    const rx = { $regex: escapeRegex(String(query.searchTerm).trim()), $options: "i" };
    and.push({ $or: [{ vaccinationNo: rx }, { batchNumber: rx }, { remarks: rx }] });
  }

  const today = startOfTodayUtc();
  const dueScope = async (range: { $gte?: Date; $lt?: Date }) => {
    const due = await findDueDoses(access, {
      ...(filter.animalId ? { animalId: filter.animalId as Types.ObjectId } : {}),
      ...(range.$gte ? { dueFrom: range.$gte } : {}),
      ...(range.$lt ? { dueBefore: range.$lt } : {}),
    });
    return due.map((d) => d.recordId);
  };
  //overdue: planned dose in the past, or a booster/repeat due date passed with no follow-up
  if (query.overdue === "true") {
    and.push({
      $or: [
        { status: VaccinationStatuses.SCHEDULED, vaccinationDate: { $lt: today } },
        { _id: { $in: await dueScope({ $lt: today }) } },
      ],
    });
  }
  //upcomingDays=N: planned within N days, or a booster/repeat falling due within N days
  if (!isBlank(query.upcomingDays)) {
    const until = addDays(today, parseWindowDays(query.upcomingDays) + 1);
    and.push({
      $or: [
        { status: VaccinationStatuses.SCHEDULED, vaccinationDate: { $gte: today, $lt: until } },
        { _id: { $in: await dueScope({ $gte: today, $lt: until }) } },
      ],
    });
  }
  if (and.length) filter.$and = and;

  const { page, limit, skip } = parsePaging(query, MAX_LIST_LIMIT);
  const [total, rows] = await Promise.all([
    VaccinationModel.countDocuments(filter),
    populateRecord(VaccinationModel.find(filter).sort(parseSort(query.sort)).skip(skip).limit(limit).select("-__v")).lean(),
  ]);
  const data = (rows as unknown as TVaccinationDoc[]).map((row) => ({ ...row, ...derive(row) }));
  return { meta: pageMeta(page, limit, total), data };
};

/** GET /animals/:animalId/vaccinations — chronological history, due boosters, upcoming plans. */
const getAnimalVaccinations = async (farmId: string, animalRef: string, requesterUserId: string) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const animal = await findAnimal(access, animalRef);
  const today = startOfTodayUtc();

  const [rows, mandatory] = await Promise.all([
    populateRecord(
      VaccinationModel.find({ farmId: access.farmObjectId, animalId: animal._id })
        .sort({ vaccinationDate: 1, createdAt: 1 })
        .limit(MAX_ANIMAL_HISTORY)
        .select("-__v"),
    ).lean(),
    VaccineModel.find({ isMandatory: true, isActive: true }).select("vaccineCode vaccineName shortCode minimumAge").lean(),
  ]);
  const history = (rows as unknown as (TVaccinationDoc & { vaccineId: TVaccineRef | null })[]).map((row) => ({
    ...row,
    ...derive(row),
  }));

  //per-vaccine protection summary
  type TSummary = {
    vaccine: unknown;
    completedDoses: number;
    lastCompletedDate: Date | null;
    lastBatchNumber: string | null;
    nextDueDate: Date | null;
    nextScheduledDate: Date | null;
    state: "Overdue" | "Due Soon" | "Scheduled" | "Up to date" | "Course complete" | "Not given";
  };
  const byVaccine = new Map<string, TSummary>();
  for (const row of history) {
    const v = row.vaccineId;
    const key = String((v as { _id?: unknown } | null)?._id ?? row.vaccineId);
    const entry =
      byVaccine.get(key) ??
      ({
        vaccine: v,
        completedDoses: 0,
        lastCompletedDate: null,
        lastBatchNumber: null,
        nextDueDate: null,
        nextScheduledDate: null,
        state: "Not given",
      } as TSummary);
    if (row.status === VaccinationStatuses.COMPLETED) {
      entry.completedDoses += 1;
      entry.lastCompletedDate = row.vaccinationDate;
      entry.lastBatchNumber = row.batchNumber ?? null;
      entry.nextDueDate = row.nextDueDate ?? null;
    }
    if (row.status === VaccinationStatuses.SCHEDULED) {
      const d = new Date(row.vaccinationDate);
      if (!entry.nextScheduledDate || d < entry.nextScheduledDate) entry.nextScheduledDate = d;
    }
    byVaccine.set(key, entry);
  }
  const soon = addDays(today, DEFAULT_UPCOMING_DAYS + 1);
  for (const entry of byVaccine.values()) {
    if (entry.nextScheduledDate) entry.state = entry.nextScheduledDate < today ? "Overdue" : "Scheduled";
    else if (entry.nextDueDate) {
      const due = new Date(entry.nextDueDate);
      entry.state = due < today ? "Overdue" : due < soon ? "Due Soon" : "Up to date";
    } else if (entry.completedDoses > 0) entry.state = "Course complete";
  }

  const ageNow = ageInMonths(animal.birthDate, today);
  const completedVaccineIds = new Set(
    history.filter((h) => h.status === VaccinationStatuses.COMPLETED).map((h) => String((h.vaccineId as { _id?: unknown } | null)?._id ?? "")),
  );
  const plannedVaccineIds = new Set(
    history.filter((h) => h.status === VaccinationStatuses.SCHEDULED).map((h) => String((h.vaccineId as { _id?: unknown } | null)?._id ?? "")),
  );
  const missingMandatory = mandatory
    .filter((v) => !completedVaccineIds.has(String(v._id)))
    .map((v) => ({
      ...v,
      planned: plannedVaccineIds.has(String(v._id)),
      eligibleByAge: v.minimumAge === undefined || v.minimumAge === null || ageNow === null || ageNow >= v.minimumAge,
    }));

  type TDueItem = { _id: unknown; vaccinationNo: string | null; vaccine: unknown; dueDate: Date; dueInDays: number | null; type: string };
  const upcoming: TDueItem[] = history
    .filter((h) => h.status === VaccinationStatuses.SCHEDULED && !h.isOverdue)
    .map((h) => ({ _id: h._id, vaccinationNo: h.vaccinationNo, vaccine: h.vaccineId, dueDate: h.vaccinationDate, dueInDays: h.dueInDays, type: "Scheduled" }));
  const overdue: TDueItem[] = history
    .filter((h) => h.isOverdue)
    .map((h) => ({ _id: h._id, vaccinationNo: h.vaccinationNo, vaccine: h.vaccineId, dueDate: h.vaccinationDate, dueInDays: h.dueInDays, type: "Scheduled" }));
  //booster/repeat due dates without a planned follow-up
  for (const entry of byVaccine.values()) {
    if (entry.nextScheduledDate || !entry.nextDueDate || animal.lifeStatus !== AnimalLifeStatuses.ACTIVE) continue;
    const due = new Date(entry.nextDueDate);
    const item = {
      _id: null,
      vaccinationNo: null,
      vaccine: entry.vaccine,
      dueDate: due,
      dueInDays: Math.round((due.getTime() - today.getTime()) / DAY_MS),
      type: "Booster / Repeat due",
    };
    (due < today ? overdue : upcoming).push(item);
  }
  upcoming.sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
  overdue.sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

  const counts = Object.fromEntries(STATUSES.map((s) => [s, history.filter((h) => h.status === s).length]));
  return {
    animal: { ...animal, ageMonths: ageNow },
    counts,
    history,
    vaccines: [...byVaccine.values()],
    upcoming,
    overdue,
    missingMandatory,
  };
};

/**
 * GET /compliance — mandatory-vaccine coverage per vaccine + farm totals.
 * Eligible = Active animals old enough for the vaccine (no birth date → eligible).
 * Covered = latest Completed dose still current (no nextDueDate, or not yet passed).
 */
const getCompliance = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const today = startOfTodayUtc();
  const windowDays = parseWindowDays(query.upcomingDays);
  const until = addDays(today, windowDays + 1);

  const [animals, mandatory, statusCounts, overdueScheduled, upcomingScheduled, dueDoses] = await Promise.all([
    AnimalModel.find({ farmId: access.farmObjectId, lifeStatus: AnimalLifeStatuses.ACTIVE }).select("animalCode name birthDate").lean(),
    VaccineModel.find({ isMandatory: true, isActive: true }).select("vaccineCode vaccineName shortCode minimumAge boosterRequired repeatIntervalDays").lean(),
    VaccinationModel.aggregate<{ _id: string; count: number }>([
      { $match: { farmId: access.farmObjectId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    VaccinationModel.countDocuments({ farmId: access.farmObjectId, status: VaccinationStatuses.SCHEDULED, vaccinationDate: { $lt: today } }),
    populateRecord(
      VaccinationModel.find({
        farmId: access.farmObjectId,
        status: VaccinationStatuses.SCHEDULED,
        vaccinationDate: { $gte: today, $lt: until },
      })
        .sort({ vaccinationDate: 1 })
        .limit(50)
        .select("vaccinationNo animalId vaccineId vaccinationDate status"),
    ).lean(),
    findDueDoses(access),
  ]);

  //latest Completed dose per animal + mandatory vaccine
  const mandatoryIds = mandatory.map((v) => v._id);
  const latest = mandatoryIds.length
    ? await VaccinationModel.aggregate<{ _id: { animalId: Types.ObjectId; vaccineId: Types.ObjectId }; nextDueDate: Date | null }>([
        { $match: { farmId: access.farmObjectId, status: VaccinationStatuses.COMPLETED, vaccineId: { $in: mandatoryIds } } },
        { $sort: { vaccinationDate: -1 } },
        { $group: { _id: { animalId: "$animalId", vaccineId: "$vaccineId" }, nextDueDate: { $first: "$nextDueDate" } } },
      ])
    : [];
  const latestOf = new Map(latest.map((l) => [`${l._id.animalId}:${l._id.vaccineId}`, l.nextDueDate]));
  const scheduledPairs = mandatoryIds.length
    ? await VaccinationModel.find({ farmId: access.farmObjectId, status: VaccinationStatuses.SCHEDULED, vaccineId: { $in: mandatoryIds } })
        .select("animalId vaccineId")
        .lean()
    : [];
  const plannedPairs = new Set(scheduledPairs.map((s) => `${s.animalId}:${s.vaccineId}`));

  let totalEligible = 0;
  let totalCovered = 0;
  const vaccines = mandatory.map((v) => {
    let eligible = 0;
    let covered = 0;
    let lapsed = 0;
    let planned = 0;
    let never = 0;
    const uncovered: { _id: unknown; animalCode: string; name?: string; reason: string }[] = [];
    for (const a of animals) {
      const age = ageInMonths(a.birthDate, today);
      if (v.minimumAge !== undefined && v.minimumAge !== null && age !== null && age < v.minimumAge) continue;
      eligible += 1;
      const key = `${a._id}:${v._id}`;
      const hasDose = latestOf.has(key);
      const due = latestOf.get(key) ?? null;
      if (hasDose && (!due || new Date(due) >= today)) {
        covered += 1;
        continue;
      }
      if (plannedPairs.has(key)) planned += 1;
      if (hasDose) lapsed += 1;
      else never += 1;
      if (uncovered.length < 25) {
        uncovered.push({
          _id: a._id,
          animalCode: a.animalCode,
          ...(a.name ? { name: a.name } : {}),
          reason: hasDose ? "Booster / repeat overdue" : plannedPairs.has(key) ? "Scheduled, not yet given" : "Never vaccinated",
        });
      }
    }
    totalEligible += eligible;
    totalCovered += covered;
    return {
      vaccine: v,
      eligibleAnimals: eligible,
      covered,
      lapsed,
      neverVaccinated: never,
      scheduled: planned,
      coveragePercent: eligible ? Math.round((covered / eligible) * 1000) / 10 : null,
      uncoveredAnimals: uncovered,
    };
  });

  const counts = Object.fromEntries(STATUSES.map((s) => [s, statusCounts.find((c) => c._id === s)?.count ?? 0]));
  const decided = counts[VaccinationStatuses.COMPLETED]! + counts[VaccinationStatuses.MISSED]! + counts[VaccinationStatuses.CANCELLED]!;

  //booster/repeat reminders (no planned follow-up yet)
  const dueRecords = dueDoses.length
    ? await populateRecord(
        VaccinationModel.find({ _id: { $in: dueDoses.map((d) => d.recordId) } }).select("vaccinationNo animalId vaccineId vaccinationDate nextDueDate status"),
      ).lean()
    : [];
  const dueRows = (dueRecords as unknown as TVaccinationDoc[]).map((r) => {
    const due = new Date(r.nextDueDate as Date);
    return { ...r, dueInDays: Math.round((due.getTime() - today.getTime()) / DAY_MS) };
  });

  return {
    asOf: today,
    upcomingWindowDays: windowDays,
    totals: {
      activeAnimals: animals.length,
      byStatus: counts,
      overdueScheduled,
      overdueBoosters: dueRows.filter((r) => r.dueInDays < 0).length,
      upcomingScheduled: upcomingScheduled.length,
      upcomingBoosters: dueRows.filter((r) => r.dueInDays >= 0 && r.dueInDays <= windowDays).length,
      completionRatePercent: decided ? Math.round((counts[VaccinationStatuses.COMPLETED]! / decided) * 1000) / 10 : null,
      mandatoryVaccines: mandatory.length,
      mandatoryCoveragePercent: totalEligible ? Math.round((totalCovered / totalEligible) * 1000) / 10 : null,
    },
    mandatory: vaccines,
    upcoming: (upcomingScheduled as unknown as TVaccinationDoc[]).map((r) => ({ ...r, ...derive(r) })),
    boosterReminders: dueRows
      .filter((r) => r.dueInDays <= windowDays)
      .sort((a, b) => a.dueInDays - b.dueInDays)
      .slice(0, 50),
  };
};

/** GET /:id — one vaccination (by _id or VACLOG number) with vaccine, animal and stock trail. */
const getVaccination = async (farmId: string, id: string, requesterUserId: string) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const doc = await findRecord(access, id);
  return loadDetail(access, doc._id);
};

/** GET /meta — enums, permissions and limits for forms and filters. */
const getMeta = () => ({
  statuses: STATUSES,
  createStatuses: [VaccinationStatuses.SCHEDULED, VaccinationStatuses.COMPLETED],
  manualStatusTargets: MANUAL_STATUS_TARGETS,
  permissions: VaccinationPermissions,
  sortFields: [...LIST_SORT_FIELDS],
  limits: {
    maxTextLength: MAX_TEXT_LENGTH,
    maxBatchLength: MAX_BATCH_LENGTH,
    maxBackdateDays: MAX_BACKDATE_DAYS,
    maxScheduleAheadDays: MAX_SCHEDULE_AHEAD_DAYS,
    defaultUpcomingDays: DEFAULT_UPCOMING_DAYS,
    maxUpcomingDays: MAX_UPCOMING_DAYS,
    maxQuantityUsed: MAX_QUANTITY_USED,
  },
});

/**
 * GET /administrators — active members selectable as administeredBy. Only name, code and
 * farm role are returned (no phone / NID / salary), so every member may call it.
 */
const getAdministrators = async (farmId: string, requesterUserId: string) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const rows = await FarmMemberModel.find({ farmId: access.farmObjectId, isActive: true })
    .select("role userId")
    .populate("userId", "userId fullName")
    .sort({ role: 1 })
    .lean();
  return {
    me: access.memberObjectId,
    myRole: access.role,
    members: rows.map((row) => {
      const user = row.userId as unknown as { userId?: string; fullName?: string } | null;
      return { _id: row._id, role: row.role, userId: user?.userId ?? null, fullName: user?.fullName ?? null };
    }),
  };
};

/** GET /:id/audit-logs — Owner / Manager / Vet: who scheduled, completed, corrected the record. */
const getAuditLogs = async (farmId: string, id: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, VaccinationPermissions.AUDIT, "view vaccination history");
  const doc = await findRecord(access, id);
  const { page, limit, skip } = parsePaging(query, MAX_LIST_LIMIT);
  const filter = { entityType: AuditEntityTypes.VACCINATION, entityId: doc._id, farmId: access.farmObjectId };
  const [total, data] = await Promise.all([
    AuditLogModel.countDocuments(filter),
    AuditLogModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      //never expose IP / user agent to farm users
      .select("logNo action event oldData newData changedFields status createdAt userId")
      .populate("userId", "userId fullName")
      .lean(),
  ]);
  return { meta: pageMeta(page, limit, total), data };
};

export const VaccinationServices = {
  previewVaccination,
  createVaccination,
  completeVaccination,
  changeStatus,
  updateVaccination,
  deleteVaccination,
  getFarmVaccinations,
  getAnimalVaccinations,
  getCompliance,
  getVaccination,
  getMeta,
  getAdministrators,
  getAuditLogs,
};
