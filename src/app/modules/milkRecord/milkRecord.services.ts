import status from "http-status";
import mongoose, { isValidObjectId, Types } from "mongoose";
import AppError from "../../errors/AppError.js";
import { AnimalModel } from "../animal/animal.model.js";
import { AnimalGenders, AnimalLifeStatuses } from "../animal/animal.constants.js";
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
  COMPOSITION_LIMITS,
  DEFAULT_SUMMARY_DAYS,
  FUTURE_TOLERANCE_HOURS,
  LACTATING_STATUS,
  MAX_BACKDATE_DAYS,
  MAX_BULK_ENTRIES,
  MAX_LIST_LIMIT,
  MAX_SESSION_LITERS,
  MAX_SUMMARY_DAYS,
  MAX_TEXT_LENGTH,
  MILK_UNIT_TO_LITERS,
  MILKING_SESSION_ORDER,
  MilkDeleteModes,
  MilkingMethods,
  MilkingSessions,
  MilkQualities,
  MilkRecordPermissions,
  MilkUnits,
  NON_MILKING_REPRODUCTIVE_STATUSES,
  PRODUCTION_DROP_PERCENT,
  SERVER_CALCULATED_FIELDS,
  SummaryPeriods,
  TOP_PRODUCERS_LIMIT,
} from "./milkRecord.constants.js";
import type {
  TMilkingMethod,
  TMilkingSession,
  TMilkQuality,
  TMilkRecord,
  TMilkUnit,
  TMilkWithdrawalDetail,
} from "./milkRecord.interface.js";
import { MilkRecordModel } from "./milkRecord.model.js";
import {
  DAY_MS,
  dayKey,
  escapeRegex,
  findActiveWithdrawals,
  isBlank,
  pageMeta,
  parseBoolean,
  parseCalendarDate,
  parseDateRange,
  parseEnum,
  parseEnumList,
  parseNumber,
  parseObjectId,
  parsePaging,
  parseText,
  round,
  toLiters,
  withdrawalWarning,
} from "./milkRecord.utils.js";
import type { TPayload } from "./milkRecord.utils.js";

const SESSIONS = Object.values(MilkingSessions) as string[];
const UNITS = Object.values(MilkUnits) as string[];
const QUALITIES = Object.values(MilkQualities) as string[];
const METHODS = Object.values(MilkingMethods) as string[];
type TCompositionField = "fatPercentage" | "proteinPercentage" | "snfPercentage";
const round3 = (value: number) => round(value, 3);

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

/** Setup / Suspended / Inactive farms cannot log milk (records stay readable). */
const requireWritableFarm = (access: TAccess) => {
  if (access.farmStatus !== FarmStatuses.ACTIVE) {
    throw new AppError(
      status.FORBIDDEN,
      `This farm is ${access.farmStatus} — milk records can only be written on an Active farm!`,
    );
  }
};

const requireMemberRow = (access: TAccess): Types.ObjectId => {
  if (!access.memberObjectId) {
    throw new AppError(status.FORBIDDEN, "An active farm membership is required to write milk records!");
  }
  return access.memberObjectId;
};

const rejectServerFields = (body: TPayload) => {
  const sent = SERVER_CALCULATED_FIELDS.filter((field) => field in body);
  if (sent.length) {
    throw new AppError(status.BAD_REQUEST, `${sent.join(", ")} cannot be sent — the server derives these values.`);
  }
};

//`qualityStatus` (DO.md wording) is accepted as an alias of the schema field `quality`
const normalizeAliases = (body: TPayload): TPayload => {
  if ("qualityStatus" in body && !("quality" in body)) {
    const { qualityStatus, ...rest } = body;
    return { ...rest, quality: qualityStatus };
  }
  return body;
};

/* -------------------------------------------------------------------------- */
/*                             Draft construction                             */
/* -------------------------------------------------------------------------- */

type TAnimalLite = {
  _id: Types.ObjectId;
  animalCode: string;
  name?: string;
  gender: string;
  lifeStatus: string;
  healthStatus: string;
  reproductiveStatus: string;
  isActive: boolean;
  birthDate?: Date;
};

const ANIMAL_FIELDS = "animalCode name gender lifeStatus healthStatus reproductiveStatus isActive birthDate";

//animal reference: Mongo _id or the farm's animalCode (AN-000001), always farm-scoped
const findAnimal = async (access: TAccess, ref: unknown): Promise<TAnimalLite> => {
  const value = String(ref ?? "").trim();
  if (!value) throw new AppError(status.BAD_REQUEST, "animalId is required!");
  const animal = await AnimalModel.findOne(
    isValidObjectId(value)
      ? { _id: new Types.ObjectId(value), farmId: access.farmObjectId }
      : { animalCode: value.toUpperCase(), farmId: access.farmObjectId },
  )
    .select(ANIMAL_FIELDS)
    .lean();
  //an animal of another farm is reported as missing (farm isolation, spec §7.4)
  if (!animal) throw new AppError(status.NOT_FOUND, "Animal not found in this farm!");
  return animal as unknown as TAnimalLite;
};

const animalView = (animal: TAnimalLite) => ({
  _id: animal._id,
  animalCode: animal.animalCode,
  name: animal.name ?? null,
  gender: animal.gender,
  lifeStatus: animal.lifeStatus,
  healthStatus: animal.healthStatus,
  reproductiveStatus: animal.reproductiveStatus,
});

/**
 * Biological / lifecycle eligibility (spec §31–32, §53, §79):
 *  - new logs are blocked for Male animals, Calves and animals that left active
 *    management (Sold / Dead / Transferred / Archived);
 *  - non-lactating females (Dry, Pregnant, Heifer, Open) are allowed with a warning;
 *  - corrections of historical rows only warn.
 */
const checkEligibility = (animal: TAnimalLite, isCorrection: boolean, warnings: string[], blockers: string[]) => {
  const inactive = animal.lifeStatus !== AnimalLifeStatuses.ACTIVE || !animal.isActive;
  if (inactive) {
    const message = `Animal ${animal.animalCode} is ${animal.lifeStatus} — milk can only be logged for active animals.`;
    if (isCorrection) warnings.push(`Animal ${animal.animalCode} is ${animal.lifeStatus}; this is a historical correction.`);
    else blockers.push(message);
  }
  if (animal.gender === AnimalGenders.MALE) {
    if (isCorrection) warnings.push(`Animal ${animal.animalCode} is male.`);
    else blockers.push(`Animal ${animal.animalCode} is male and cannot have milk records.`);
  } else if (NON_MILKING_REPRODUCTIVE_STATUSES.includes(animal.reproductiveStatus)) {
    if (isCorrection) warnings.push(`Animal ${animal.animalCode} is a ${animal.reproductiveStatus}.`);
    else blockers.push(`Animal ${animal.animalCode} is a ${animal.reproductiveStatus} and does not produce milk.`);
  } else if (animal.reproductiveStatus !== LACTATING_STATUS) {
    warnings.push(
      `Animal ${animal.animalCode} is marked ${animal.reproductiveStatus}, not Lactating. Check the record or update the animal's reproductive status.`,
    );
  }
  if (animal.healthStatus && animal.healthStatus !== "Healthy") {
    warnings.push(`Animal is ${animal.healthStatus}; check the milk before mixing it with the bulk tank.`);
  }
};

const parseRecordDate = (value: unknown, birthDate?: Date | null): Date => {
  const date = parseCalendarDate("recordDate", value);
  const now = Date.now();
  //spec §52: milk records are actual events — no future dates
  if (date.getTime() > now + FUTURE_TOLERANCE_HOURS * 60 * 60 * 1000) {
    throw new AppError(status.BAD_REQUEST, "recordDate cannot be in the future!");
  }
  if (date.getTime() < now - MAX_BACKDATE_DAYS * DAY_MS) {
    throw new AppError(status.BAD_REQUEST, `recordDate cannot be more than ${MAX_BACKDATE_DAYS} days in the past!`);
  }
  if (birthDate && date.getTime() < new Date(dayKey(birthDate)).getTime()) {
    throw new AppError(status.BAD_REQUEST, "recordDate cannot be before the animal's birth date!");
  }
  return date;
};

//null / "" clears a measurement; a missing key keeps the stored value (null on create)
const parseComposition = (body: TPayload, field: TCompositionField, current: number | null): number | null => {
  if (!(field in body)) return current;
  if (isBlank(body[field])) return null;
  const { min, max } = COMPOSITION_LIMITS[field];
  return round(parseNumber(field, body[field], { min, max }), 2);
};

const parseNullableEnum = <T extends string>(
  body: TPayload,
  field: string,
  allowed: readonly string[],
  current: T | null,
): T | null => {
  if (!(field in body)) return current;
  if (isBlank(body[field])) return null;
  return parseEnum(field, body[field], allowed) as T;
};

type TDraft = {
  animal: TAnimalLite;
  recordDate: Date;
  milkingSession: TMilkingSession;
  quantity: number;
  unit: TMilkUnit;
  quantityInLiters: number;
  fatPercentage: number | null;
  proteinPercentage: number | null;
  snfPercentage: number | null;
  quality: TMilkQuality | null;
  milkingMethod: TMilkingMethod | null;
  recordedBy: Types.ObjectId;
  remarks: string | undefined;
  withdrawalFlag: boolean;
  withdrawalDetails: TMilkWithdrawalDetail[];
  duplicateOf: Types.ObjectId | null;
  warnings: string[];
  blockers: string[];
};

type TStored = TMilkRecord & { _id: Types.ObjectId; updatedAt: Date };

/** Average liters of this animal's recent sessions — baseline for the drop warning (spec §61). */
const recentSessionBaseline = async (
  access: TAccess,
  animalId: Types.ObjectId,
  session: string,
  before: Date,
  excludeId: Types.ObjectId | null,
) => {
  const rows = await MilkRecordModel.aggregate<{ avg: number; n: number }>([
    {
      $match: {
        farmId: access.farmObjectId,
        animalId,
        milkingSession: session,
        isVoided: false,
        recordDate: { $lt: before, $gte: new Date(before.getTime() - 14 * DAY_MS) },
        ...(excludeId ? { _id: { $ne: excludeId } } : {}),
      },
    },
    { $group: { _id: null, avg: { $avg: "$quantityInLiters" }, n: { $sum: 1 } } },
  ]);
  const row = rows[0];
  return row && row.n >= 3 ? row.avg : null;
};

/**
 * Validates a create body (existing = null) or a correction body (existing = the
 * stored record; omitted fields keep their stored values). Never writes.
 */
const buildDraft = async (access: TAccess, rawBody: TPayload, existing: TStored | null): Promise<TDraft> => {
  const body = normalizeAliases(rawBody);
  const warnings: string[] = [];
  const blockers: string[] = [];

  //--- animal (immutable on corrections)
  if (existing && "animalId" in body && !isBlank(body.animalId)) {
    const sent = String(body.animalId).trim();
    if (sent !== String(existing.animalId)) {
      const sameByCode = await AnimalModel.exists({ _id: existing.animalId, animalCode: sent.toUpperCase() });
      if (!sameByCode) {
        throw new AppError(
          status.BAD_REQUEST,
          "animalId cannot be changed. Delete (void) this record and log the milk for the right animal.",
        );
      }
    }
  }
  const animal = await findAnimal(access, existing ? String(existing.animalId) : body.animalId);
  checkEligibility(animal, Boolean(existing), warnings, blockers);

  //--- date + session
  let recordDate: Date;
  if (isBlank(body.recordDate)) {
    if (!existing) throw new AppError(status.BAD_REQUEST, "recordDate is required!");
    recordDate = existing.recordDate;
  } else {
    recordDate = parseRecordDate(body.recordDate, animal.birthDate ?? null);
  }
  const milkingSession = (
    isBlank(body.milkingSession) && existing
      ? existing.milkingSession
      : parseEnum("milkingSession", body.milkingSession, SESSIONS)
  ) as TMilkingSession;

  //--- quantity + unit (user value kept, liters derived)
  const unit = (
    isBlank(body.unit) ? existing?.unit ?? MilkUnits.LITER : parseEnum("unit", body.unit, UNITS)
  ) as TMilkUnit;
  let quantity: number;
  if (isBlank(body.quantity)) {
    if (!existing) throw new AppError(status.BAD_REQUEST, "quantity is required!");
    quantity = existing.quantity;
  } else {
    const maxInUnit = MAX_SESSION_LITERS / (MILK_UNIT_TO_LITERS[unit] ?? 1);
    quantity = round(parseNumber("quantity", body.quantity, { min: 0, max: maxInUnit }), 3);
  }
  const quantityInLiters = toLiters(quantity, unit);
  if (quantityInLiters === 0) {
    //spec §11, §72: 0 is a deliberate "produced nothing", not a missing record
    warnings.push("Quantity is 0 — this records that the animal produced no milk in this session.");
  }

  //--- composition (null = not measured, never defaulted to 0)
  const fatPercentage = parseComposition(body, "fatPercentage", existing?.fatPercentage ?? null);
  const proteinPercentage = parseComposition(body, "proteinPercentage", existing?.proteinPercentage ?? null);
  const snfPercentage = parseComposition(body, "snfPercentage", existing?.snfPercentage ?? null);
  if (snfPercentage !== null && proteinPercentage !== null && snfPercentage < proteinPercentage) {
    warnings.push("SNF is lower than protein, but protein is part of SNF — please re-check the lab values.");
  }

  const quality = parseNullableEnum<TMilkQuality>(body, "quality", QUALITIES, existing?.quality ?? null);
  const milkingMethod = parseNullableEnum<TMilkingMethod>(
    body,
    "milkingMethod",
    METHODS,
    existing?.milkingMethod ?? null,
  );

  //--- recordedBy: an active member of THIS farm; defaults to the caller
  let recordedBy: Types.ObjectId;
  if (isBlank(body.recordedBy)) {
    recordedBy = existing?.recordedBy ?? requireMemberRow(access);
  } else {
    recordedBy = parseObjectId("recordedBy", body.recordedBy);
    const unchanged = existing && String(existing.recordedBy) === String(recordedBy);
    if (!unchanged) {
      const member = await FarmMemberModel.exists({ _id: recordedBy, farmId: access.farmObjectId, isActive: true });
      if (!member) throw new AppError(status.BAD_REQUEST, "recordedBy must be an active member of this farm!");
    }
  }

  const remarks = "remarks" in body ? parseText("remarks", body.remarks) : existing?.remarks;

  //--- medicine withdrawal (safety) check for the production day
  const withdrawalDetails = await findActiveWithdrawals(access.farmObjectId, animal._id, recordDate);
  const withdrawalFlag = withdrawalDetails.length > 0;
  const withdrawalMessage = withdrawalWarning(withdrawalDetails);
  if (withdrawalMessage) {
    warnings.unshift(withdrawalMessage);
    if (quality !== MilkQualities.REJECTED) {
      warnings.push('Recommended: set quality to "Rejected" for milk collected during a withdrawal period.');
    }
  }

  //--- one official record per animal / day / session (spec §9, §49)
  const duplicate = await MilkRecordModel.findOne({
    farmId: access.farmObjectId,
    animalId: animal._id,
    recordDate,
    milkingSession,
    isVoided: false,
    ...(existing ? { _id: { $ne: existing._id } } : {}),
  })
    .select("_id")
    .lean();
  if (duplicate) {
    blockers.push(
      `A ${milkingSession} milk record already exists for ${animal.animalCode} on ${dayKey(recordDate)} — edit that record instead of adding a duplicate.`,
    );
  }

  //--- sudden-drop hint (analytics, never blocks)
  if (quantityInLiters > 0) {
    const baseline = await recentSessionBaseline(access, animal._id, milkingSession, recordDate, existing?._id ?? null);
    if (baseline && quantityInLiters < baseline * (1 - PRODUCTION_DROP_PERCENT / 100)) {
      warnings.push(
        `Yield is ${round(((baseline - quantityInLiters) / baseline) * 100, 0)}% below this animal's recent ${milkingSession} average (${round(baseline, 2)} L).`,
      );
    }
  }

  return {
    animal,
    recordDate,
    milkingSession,
    quantity,
    unit,
    quantityInLiters,
    fatPercentage,
    proteinPercentage,
    snfPercentage,
    quality,
    milkingMethod,
    recordedBy,
    remarks,
    withdrawalFlag,
    withdrawalDetails,
    duplicateOf: (duplicate?._id as Types.ObjectId | undefined) ?? null,
    warnings,
    blockers,
  };
};

const draftToData = (access: TAccess, draft: TDraft): TMilkRecord => ({
  farmId: access.farmObjectId,
  animalId: draft.animal._id,
  recordDate: draft.recordDate,
  milkingSession: draft.milkingSession,
  quantity: draft.quantity,
  unit: draft.unit,
  quantityInLiters: draft.quantityInLiters,
  fatPercentage: draft.fatPercentage,
  proteinPercentage: draft.proteinPercentage,
  snfPercentage: draft.snfPercentage,
  quality: draft.quality,
  milkingMethod: draft.milkingMethod,
  recordedBy: draft.recordedBy,
  ...(draft.remarks ? { remarks: draft.remarks } : {}),
  withdrawalFlag: draft.withdrawalFlag,
  withdrawalDetails: draft.withdrawalDetails,
  isVoided: false,
});

const throwIfBlocked = (draft: TDraft) => {
  if (!draft.blockers.length) return;
  //a duplicate session is a conflict; every other blocker is an unprocessable request
  const code = draft.duplicateOf && draft.blockers.length === 1 ? status.CONFLICT : status.UNPROCESSABLE_ENTITY;
  throw new AppError(code, `Milk record cannot be saved: ${draft.blockers.join(" ")}`);
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
      detail
        ? "animalCode name gender lifeStatus healthStatus reproductiveStatus profilePhoto breedId"
        : "animalCode name reproductiveStatus",
    )
    .populate({ path: "recordedBy", ...MEMBER_POPULATE })
    .populate({ path: "voidedBy", ...MEMBER_POPULATE }) as unknown as T;
};

//sale eligibility is derived, never stored: produced ≠ sold (spec §44–45)
const withDerived = <T extends Record<string, unknown>>(record: T) => ({
  ...record,
  isSaleEligible: !record.isVoided && record.quality !== MilkQualities.REJECTED && !record.withdrawalFlag,
});

const findRecord = async (access: TAccess, ref: string): Promise<TStored> => {
  const value = String(ref ?? "").trim();
  if (!isValidObjectId(value)) throw new AppError(status.BAD_REQUEST, "Invalid milk record id!");
  const doc = await MilkRecordModel.findOne({ _id: new Types.ObjectId(value), farmId: access.farmObjectId }).lean();
  if (!doc) throw new AppError(status.NOT_FOUND, "Milk record not found!");
  return doc as unknown as TStored;
};

const loadDetail = async (id: Types.ObjectId) => {
  const record = await populateRecord(MilkRecordModel.findById(id).select("-__v"), true).lean();
  return record ? withDerived(record as Record<string, unknown>) : null;
};

const AUDITED_FIELDS = [
  "recordDate",
  "milkingSession",
  "quantity",
  "unit",
  "quantityInLiters",
  "fatPercentage",
  "proteinPercentage",
  "snfPercentage",
  "quality",
  "milkingMethod",
  "recordedBy",
  "remarks",
  "withdrawalFlag",
] as const;

const auditSnapshot = (record: Partial<TMilkRecord>) => ({
  animalId: record.animalId,
  recordDate: record.recordDate,
  milkingSession: record.milkingSession,
  quantity: record.quantity,
  unit: record.unit,
  quantityInLiters: record.quantityInLiters,
  fatPercentage: record.fatPercentage ?? null,
  proteinPercentage: record.proteinPercentage ?? null,
  snfPercentage: record.snfPercentage ?? null,
  quality: record.quality ?? null,
  milkingMethod: record.milkingMethod ?? null,
  recordedBy: record.recordedBy,
  remarks: record.remarks ?? null,
  withdrawalFlag: record.withdrawalFlag ?? false,
  isVoided: record.isVoided ?? false,
});

const sameValue = (a: unknown, b: unknown) => {
  if (a instanceof Date || b instanceof Date) {
    return a && b ? new Date(a as Date).getTime() === new Date(b as Date).getTime() : a === b;
  }
  return String(a ?? "") === String(b ?? "");
};

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
    entityType: AuditEntityTypes.MILK_RECORD,
    entityId,
    action,
    //AuditLog (Model 24) has no Production module; milk production is an animal record
    module: AuditModules.ANIMAL,
    event,
    oldData,
    newData,
    changedFields,
  });

const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;

/* -------------------------------------------------------------------------- */
/*                                   Writes                                   */
/* -------------------------------------------------------------------------- */

/**
 * GET /check — dry-run eligibility for a form: animal status, lactation, withdrawal,
 * and whether the session is already logged. Nothing is written.
 */
const checkEligibilityForForm = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const animal = await findAnimal(access, query.animalId);
  const warnings: string[] = [];
  const blockers: string[] = [];
  checkEligibility(animal, false, warnings, blockers);
  const recordDate = isBlank(query.recordDate) ? new Date(dayKey(new Date())) : parseRecordDate(query.recordDate);
  const withdrawalDetails = await findActiveWithdrawals(access.farmObjectId, animal._id, recordDate);
  const message = withdrawalWarning(withdrawalDetails);
  if (message) warnings.unshift(message);

  let existingRecord = null;
  if (!isBlank(query.milkingSession)) {
    const milkingSession = parseEnum("milkingSession", query.milkingSession, SESSIONS) as TMilkingSession;
    existingRecord = await MilkRecordModel.findOne({
      farmId: access.farmObjectId,
      animalId: animal._id,
      recordDate,
      milkingSession,
      isVoided: false,
    })
      .select("quantity unit quantityInLiters quality milkingSession recordDate")
      .lean();
    if (existingRecord) blockers.push(`${milkingSession} on ${dayKey(recordDate)} is already logged for ${animal.animalCode}.`);
  }
  return {
    animal: animalView(animal),
    recordDate,
    withdrawal: { active: withdrawalDetails.length > 0, details: withdrawalDetails },
    existingRecord,
    warnings,
    blockers,
    canLog: blockers.length === 0 && access.farmStatus === FarmStatuses.ACTIVE && can(access, MilkRecordPermissions.CREATE),
  };
};

/** POST / — logs one milking session for one animal (Owner / Manager / Worker). */
const createMilkRecord = async (farmId: string, requesterUserId: string, payload: TPayload, context: TAuditContext) => {
  const body = payload ?? {};
  rejectServerFields(body);
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, MilkRecordPermissions.CREATE, "log milk");
  requireWritableFarm(access);
  requireMemberRow(access);

  const draft = await buildDraft(access, body, null);
  throwIfBlocked(draft);
  const data = draftToData(access, draft);

  let doc;
  try {
    doc = await MilkRecordModel.create(data);
  } catch (error) {
    //two clients saved the same session at the same moment — the unique index wins
    if (isDuplicateKey(error)) {
      throw new AppError(status.CONFLICT, `This ${draft.milkingSession} session is already logged for ${draft.animal.animalCode}.`);
    }
    throw error;
  }

  await audit(context, access.farmObjectId, doc._id, AuditActions.CREATE, "MilkRecord Created", null, auditSnapshot(data));

  return {
    milkRecord: await loadDetail(doc._id),
    withdrawal: { active: draft.withdrawalFlag, details: draft.withdrawalDetails },
    warnings: draft.warnings,
  };
};

/**
 * POST /bulk — one milking session for many animals (the usual herd round).
 * Shared fields (recordDate, milkingSession, milkingMethod, unit, recordedBy) apply to
 * every entry unless the entry overrides them. Each entry is validated on its own:
 * valid entries are saved, invalid ones are returned with the reason (nothing is
 * silently dropped). Send `dryRun: true` to validate without saving.
 */
const bulkCreateMilkRecords = async (
  farmId: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, MilkRecordPermissions.CREATE, "log milk");
  requireWritableFarm(access);
  const dryRun = parseBoolean(body.dryRun);
  //a dry run writes nothing, so it does not need a signing membership row
  if (!dryRun) requireMemberRow(access);

  const entries = body.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new AppError(status.BAD_REQUEST, "entries must contain at least one animal!");
  }
  if (entries.length > MAX_BULK_ENTRIES) {
    throw new AppError(status.BAD_REQUEST, `A bulk entry can contain at most ${MAX_BULK_ENTRIES} animals!`);
  }
  const shared: TPayload = {};
  for (const key of ["recordDate", "milkingSession", "milkingMethod", "unit", "recordedBy"]) {
    if (key in body) shared[key] = body[key];
  }

  const seen = new Set<string>();
  const created: Record<string, unknown>[] = [];
  const failed: { index: number; animalId: unknown; error: string }[] = [];

  for (const [index, raw] of entries.entries()) {
    const entry = (raw && typeof raw === "object" ? raw : {}) as TPayload;
    try {
      rejectServerFields(entry);
      const draft = await buildDraft(access, { ...shared, ...entry }, null);
      const key = `${String(draft.animal._id)}|${dayKey(draft.recordDate)}|${draft.milkingSession}`;
      if (seen.has(key)) throw new AppError(status.CONFLICT, `${draft.animal.animalCode} appears twice in this batch.`);
      seen.add(key);
      throwIfBlocked(draft);

      if (dryRun) {
        created.push({ index, animal: animalView(draft.animal), quantityInLiters: draft.quantityInLiters, warnings: draft.warnings });
        continue;
      }
      const data = draftToData(access, draft);
      const doc = await MilkRecordModel.create(data);
      await audit(context, access.farmObjectId, doc._id, AuditActions.CREATE, "MilkRecord Created (bulk)", null, auditSnapshot(data));
      created.push({
        index,
        _id: doc._id,
        animal: animalView(draft.animal),
        quantity: draft.quantity,
        unit: draft.unit,
        quantityInLiters: draft.quantityInLiters,
        withdrawalFlag: draft.withdrawalFlag,
        warnings: draft.warnings,
      });
    } catch (error) {
      const message = isDuplicateKey(error)
        ? "This session is already logged for the animal."
        : error instanceof Error
          ? error.message
          : "Invalid entry";
      failed.push({ index, animalId: entry.animalId ?? null, error: message });
    }
  }

  return {
    dryRun,
    saved: dryRun ? 0 : created.length,
    failedCount: failed.length,
    totalLiters: round3(created.reduce((s, c) => s + Number(c.quantityInLiters ?? 0), 0)),
    created,
    failed,
  };
};

/**
 * PUT /:id — controlled correction (Owner / Manager). Every field except the animal
 * may change; liters and the withdrawal check are recalculated by the server, and
 * the change is audited with oldData / newData / changedFields (spec §50, §73).
 */
const updateMilkRecord = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  rejectServerFields(body);
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, MilkRecordPermissions.UPDATE, "correct milk records");
  requireWritableFarm(access);
  const reason = parseText("reason", body.reason);

  const doc = await findRecord(access, id);
  if (doc.isVoided) throw new AppError(status.CONFLICT, "This milk record was voided and can no longer be corrected!");

  const draft = await buildDraft(access, body, doc);
  throwIfBlocked(draft);
  const next = draftToData(access, draft);

  const changedFields = AUDITED_FIELDS.filter((field) => !sameValue(next[field as keyof TMilkRecord], doc[field]));
  const withdrawalChanged = JSON.stringify(next.withdrawalDetails) !== JSON.stringify(doc.withdrawalDetails ?? []);
  if (changedFields.length === 0 && !withdrawalChanged) {
    return { mode: "unchanged", milkRecord: await loadDetail(doc._id), warnings: draft.warnings };
  }

  //farmId / animalId / isVoided never change through a correction
  const set: Record<string, unknown> = {};
  for (const field of AUDITED_FIELDS) {
    if (field !== "remarks") set[field] = next[field as keyof TMilkRecord];
  }
  set.withdrawalDetails = next.withdrawalDetails;
  const update = next.remarks ? { $set: { ...set, remarks: next.remarks } } : { $set: set, $unset: { remarks: 1 } };
  try {
    //optimistic guard: nobody else corrected / voided it since it was read
    const result = await MilkRecordModel.updateOne({ _id: doc._id, updatedAt: doc.updatedAt, isVoided: false }, update);
    if (result.modifiedCount !== 1) {
      throw new AppError(status.CONFLICT, "The milk record was changed by someone else; reload and try again.");
    }
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError(status.CONFLICT, "Another record already exists for that animal, date and session.");
    }
    throw error;
  }

  await audit(
    context,
    access.farmObjectId,
    doc._id,
    AuditActions.UPDATE,
    "MilkRecord Corrected",
    auditSnapshot(doc),
    { ...auditSnapshot(next), ...(reason ? { reason } : {}) },
    changedFields,
  );

  return { mode: "updated", changedFields, milkRecord: await loadDetail(doc._id), warnings: draft.warnings };
};

/**
 * PATCH /:id/quality — Owner / Manager quick grade change, e.g. mark spoiled or
 * mastitis milk as "Rejected" (the policy-preferred alternative to deleting it).
 */
const updateMilkQuality = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = normalizeAliases(payload ?? {});
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, MilkRecordPermissions.GRADE, "change milk quality");
  requireWritableFarm(access);
  const quality = isBlank(body.quality) ? null : (parseEnum("quality", body.quality, QUALITIES) as TMilkQuality);
  const reason = parseText("reason", body.reason);

  const doc = await findRecord(access, id);
  if (doc.isVoided) throw new AppError(status.CONFLICT, "This milk record was voided!");
  if ((doc.quality ?? null) === quality) {
    return { mode: "unchanged", milkRecord: await loadDetail(doc._id) };
  }
  const result = await MilkRecordModel.updateOne(
    { _id: doc._id, updatedAt: doc.updatedAt, isVoided: false },
    { $set: { quality } },
  );
  if (result.modifiedCount !== 1) {
    throw new AppError(status.CONFLICT, "The milk record was changed by someone else; reload and try again.");
  }
  await audit(
    context,
    access.farmObjectId,
    doc._id,
    AuditActions.UPDATE,
    quality === MilkQualities.REJECTED ? "MilkRecord Rejected" : "MilkRecord Quality Changed",
    { quality: doc.quality ?? null },
    { quality, ...(reason ? { reason } : {}) },
    ["quality"],
  );
  return { mode: "updated", milkRecord: await loadDetail(doc._id) };
};

//true when a (future) Income row references this milk record — financial history wins
const isReferencedByIncome = async (farmObjectId: Types.ObjectId, recordId: Types.ObjectId) => {
  const db = mongoose.connection.db;
  if (!db) return false;
  const names = (await db.listCollections({ name: "incomes" }, { nameOnly: true }).toArray()).length;
  if (!names) return false;
  return Boolean(
    await db.collection("incomes").findOne({ farmId: farmObjectId, referenceType: "MilkRecord", referenceId: recordId }),
  );
};

/**
 * DELETE /:id — Owner only.
 *  - mode "void" (default): the record stays as history (isVoided) and leaves every
 *    total. Spoiled / contaminated milk should instead be marked quality "Rejected".
 *  - mode "hard": permanent removal, only for duplicate / accidental entries. A reason
 *    is required, it is refused when an Income references the record, and the full
 *    oldData is kept in the AuditLog.
 */
const deleteMilkRecord = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, MilkRecordPermissions.DELETE, "delete milk records");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);
  const mode = isBlank(body.mode) ? MilkDeleteModes.VOID : parseEnum("mode", body.mode, Object.values(MilkDeleteModes));
  const reason = parseText("reason", body.reason);

  const doc = await findRecord(access, id);
  const hint =
    doc.quality === MilkQualities.REJECTED
      ? null
      : 'If the milk was produced but spoiled or contaminated, keep the record and set quality to "Rejected" instead.';

  if (mode === MilkDeleteModes.HARD) {
    if (!reason) {
      throw new AppError(status.BAD_REQUEST, "A reason is required to permanently delete a milk record (duplicate / accidental entry).");
    }
    if (await isReferencedByIncome(access.farmObjectId, doc._id)) {
      throw new AppError(status.CONFLICT, "This milk record is referenced by an Income entry and cannot be deleted. Void it instead.");
    }
    await MilkRecordModel.deleteOne({ _id: doc._id, farmId: access.farmObjectId });
    await audit(
      context,
      access.farmObjectId,
      doc._id,
      AuditActions.DELETE,
      "MilkRecord Deleted (duplicate / accidental)",
      auditSnapshot(doc),
      { reason },
      [],
    );
    return { _id: doc._id, mode, deleted: true, hint };
  }

  if (doc.isVoided) throw new AppError(status.CONFLICT, "This milk record is already voided!");
  const voidedAt = new Date();
  const result = await MilkRecordModel.updateOne(
    { _id: doc._id, updatedAt: doc.updatedAt, isVoided: false },
    { $set: { isVoided: true, voidedAt, voidedBy: memberId, ...(reason ? { voidReason: reason } : {}) } },
  );
  if (result.modifiedCount !== 1) {
    throw new AppError(status.CONFLICT, "The milk record was changed by someone else; reload and try again.");
  }
  await audit(
    context,
    access.farmObjectId,
    doc._id,
    AuditActions.DELETE,
    "MilkRecord Voided",
    auditSnapshot(doc),
    { isVoided: true, voidedAt, ...(reason ? { voidReason: reason } : {}) },
    ["isVoided", "voidedAt", "voidedBy", ...(reason ? ["voidReason"] : [])],
  );
  return { _id: doc._id, mode, isVoided: true, voidedAt, hint };
};

/* -------------------------------------------------------------------------- */
/*                                    Reads                                   */
/* -------------------------------------------------------------------------- */

const LIST_SORT_FIELDS = new Set(["recordDate", "createdAt", "quantityInLiters", "milkingSession", "fatPercentage"]);

const parseSort = (value: unknown): Record<string, 1 | -1> => {
  if (isBlank(value)) return { recordDate: -1, createdAt: -1, _id: -1 };
  const sort: Record<string, 1 | -1> = {};
  for (const raw of String(value).split(",")) {
    const key = raw.trim();
    const field = key.replace(/^-/, "");
    if (!LIST_SORT_FIELDS.has(field)) throw new AppError(status.BAD_REQUEST, `Cannot sort by "${field}"!`);
    sort[field] = key.startsWith("-") ? -1 : 1;
  }
  sort._id = -1;
  return sort;
};

//voided rows are hidden unless an Owner / Manager asks for them
const voidFilter = (access: TAccess, query: TPayload) => {
  const mode = String(query.voided ?? (parseBoolean(query.includeVoided) ? "include" : "exclude"));
  if (mode === "exclude" || !can(access, MilkRecordPermissions.AUDIT)) return { isVoided: false };
  if (mode === "only") return { isVoided: true };
  return {};
};

const qualityFilter = (value: unknown) => {
  const parts = String(value).split(",").map((v) => v.trim()).filter(Boolean);
  const wantsUngraded = parts.includes("none");
  const graded = parseEnumList("quality", parts.filter((p) => p !== "none").join(","), QUALITIES);
  const values: (string | null)[] = [...graded, ...(wantsUngraded ? [null] : [])];
  return values.length === 1 ? values[0] : { $in: values };
};

const buildListFilter = async (access: TAccess, rawQuery: TPayload) => {
  const query = normalizeAliases(rawQuery);
  const filter: Record<string, unknown> = { farmId: access.farmObjectId, ...voidFilter(access, query) };
  if (!isBlank(query.animalId)) filter.animalId = (await findAnimal(access, query.animalId))._id;
  if (!isBlank(query.milkingSession)) {
    const values = parseEnumList("milkingSession", query.milkingSession, SESSIONS);
    filter.milkingSession = values.length === 1 ? values[0] : { $in: values };
  }
  if (!isBlank(query.milkingMethod)) {
    const values = parseEnumList("milkingMethod", query.milkingMethod, METHODS);
    filter.milkingMethod = values.length === 1 ? values[0] : { $in: values };
  }
  if (!isBlank(query.quality)) filter.quality = qualityFilter(query.quality);
  if (!isBlank(query.recordedBy)) filter.recordedBy = parseObjectId("recordedBy", query.recordedBy);
  if (!isBlank(query.withdrawal)) filter.withdrawalFlag = parseBoolean(query.withdrawal);
  Object.assign(filter, parseDateRange(query, "recordDate"));
  if (!isBlank(query.searchTerm)) {
    filter.remarks = { $regex: escapeRegex(String(query.searchTerm).trim().slice(0, 100)), $options: "i" };
  }
  return filter;
};

const totalsGroup = {
  _id: null,
  records: { $sum: 1 },
  totalLiters: { $sum: "$quantityInLiters" },
  rejectedLiters: {
    $sum: { $cond: [{ $eq: ["$quality", MilkQualities.REJECTED] }, "$quantityInLiters", 0] },
  },
  withdrawalLiters: { $sum: { $cond: ["$withdrawalFlag", "$quantityInLiters", 0] } },
  saleableLiters: {
    $sum: {
      $cond: [
        { $and: [{ $ne: ["$quality", MilkQualities.REJECTED] }, { $ne: ["$withdrawalFlag", true] }] },
        "$quantityInLiters",
        0,
      ],
    },
  },
  //$avg ignores nulls, so unmeasured samples never drag averages to 0 (spec §71)
  avgFat: { $avg: "$fatPercentage" },
  avgProtein: { $avg: "$proteinPercentage" },
  avgSnf: { $avg: "$snfPercentage" },
  animals: { $addToSet: "$animalId" },
  days: { $addToSet: "$recordDate" },
};

type TTotalsRow = {
  records: number;
  totalLiters: number;
  rejectedLiters: number;
  withdrawalLiters: number;
  saleableLiters: number;
  avgFat: number | null;
  avgProtein: number | null;
  avgSnf: number | null;
  animals: unknown[];
  days: unknown[];
};

const totalsView = (row: TTotalsRow | undefined) => {
  const days = row?.days?.length ?? 0;
  const total = row?.totalLiters ?? 0;
  return {
    records: row?.records ?? 0,
    animalsMilked: row?.animals?.length ?? 0,
    productionDays: days,
    totalLiters: round3(total),
    saleableLiters: round3(row?.saleableLiters ?? 0),
    rejectedLiters: round3(row?.rejectedLiters ?? 0),
    withdrawalLiters: round3(row?.withdrawalLiters ?? 0),
    //per day WITH recorded production (spec §40 — the basis is stated in the response)
    avgDailyLiters: days ? round3(total / days) : 0,
    avgSessionYield: row?.records ? round3(total / row.records) : 0,
    composition: {
      avgFatPercentage: row?.avgFat == null ? null : round(row.avgFat, 2),
      avgProteinPercentage: row?.avgProtein == null ? null : round(row.avgProtein, 2),
      avgSnfPercentage: row?.avgSnf == null ? null : round(row.avgSnf, 2),
    },
  };
};

/** GET / — farm-wide milk records with filters + pagination + filtered totals. */
const getFarmMilkRecords = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const filter = await buildListFilter(access, query);
  const { page, limit, skip } = parsePaging(query, MAX_LIST_LIMIT);
  const [total, data, totals] = await Promise.all([
    MilkRecordModel.countDocuments(filter),
    populateRecord(MilkRecordModel.find(filter).sort(parseSort(query.sort)).skip(skip).limit(limit).select("-__v")).lean(),
    MilkRecordModel.aggregate<TTotalsRow>([{ $match: filter }, { $group: totalsGroup }]),
  ]);
  return {
    meta: pageMeta(page, limit, total),
    data: {
      records: (data as Record<string, unknown>[]).map(withDerived),
      //totals of the whole filtered set (not only this page), in liters
      summary: totalsView(totals[0]),
    },
  };
};

//a date window (default: the last DEFAULT_SUMMARY_DAYS days, capped at MAX_SUMMARY_DAYS)
const summaryWindow = (query: TPayload, defaultDays = DEFAULT_SUMMARY_DAYS) => {
  const range = parseDateRange(query, "recordDate").recordDate as { $gte?: Date; $lte?: Date } | undefined;
  const to = range?.$lte ?? new Date(new Date(dayKey(new Date())).getTime() + DAY_MS - 1);
  const from = range?.$gte ?? new Date(to.getTime() - defaultDays * DAY_MS + 1);
  if (to.getTime() - from.getTime() > MAX_SUMMARY_DAYS * DAY_MS) {
    throw new AppError(status.BAD_REQUEST, `The date range cannot exceed ${MAX_SUMMARY_DAYS} days!`);
  }
  return { from, to };
};

const BUCKET_FORMAT: Record<string, string> = {
  [SummaryPeriods.DAILY]: "%Y-%m-%d",
  //ISO week: 2026-W33
  [SummaryPeriods.WEEKLY]: "%G-W%V",
  [SummaryPeriods.MONTHLY]: "%Y-%m",
};

const trendPipeline = (
  match: Record<string, unknown>,
  period: string,
  extraGroup: Record<string, unknown> = {},
  order: 1 | -1 = 1,
) => [
  { $match: match },
  {
    $group: {
      ...extraGroup,
      _id: { $dateToString: { format: BUCKET_FORMAT[period] ?? "%Y-%m-%d", date: "$recordDate", timezone: "UTC" } },
      records: { $sum: 1 },
      liters: { $sum: "$quantityInLiters" },
      days: { $addToSet: "$recordDate" },
      avgFat: { $avg: "$fatPercentage" },
      avgProtein: { $avg: "$proteinPercentage" },
      avgSnf: { $avg: "$snfPercentage" },
      rejectedLiters: { $sum: { $cond: [{ $eq: ["$quality", MilkQualities.REJECTED] }, "$quantityInLiters", 0] } },
    },
  },
  { $sort: { _id: order } },
];

type TTrendRow = {
  _id: string;
  records: number;
  liters: number;
  days: unknown[];
  avgFat: number | null;
  avgProtein: number | null;
  avgSnf: number | null;
  rejectedLiters: number;
};

const trendView = (rows: TTrendRow[]) =>
  rows.map((r) => ({
    period: r._id,
    records: r.records,
    liters: round3(r.liters),
    productionDays: r.days.length,
    avgDailyLiters: r.days.length ? round3(r.liters / r.days.length) : 0,
    rejectedLiters: round3(r.rejectedLiters),
    avgFatPercentage: r.avgFat == null ? null : round(r.avgFat, 2),
    avgProteinPercentage: r.avgProtein == null ? null : round(r.avgProtein, 2),
    avgSnfPercentage: r.avgSnf == null ? null : round(r.avgSnf, 2),
  }));

const groupedPipeline = (match: Record<string, unknown>, field: string) => [
  { $match: match },
  { $group: { _id: `$${field}`, records: { $sum: 1 }, liters: { $sum: "$quantityInLiters" } } },
];

type TGroupRow = { _id: string | null; records: number; liters: number };

const breakdown = (rows: TGroupRow[], keys: string[], totalLiters: number, nullLabel: string) =>
  Object.fromEntries(
    [...keys, nullLabel].map((key) => {
      const row = rows.find((r) => (r._id ?? nullLabel) === key);
      const liters = row?.liters ?? 0;
      return [
        key,
        {
          records: row?.records ?? 0,
          liters: round3(liters),
          avgYield: row?.records ? round3(liters / row.records) : 0,
          percent: totalLiters > 0 ? round((liters / totalLiters) * 100, 1) : 0,
        },
      ];
    }),
  );

/**
 * GET /summary — dashboard aggregation (spec §63–68): totals, daily / weekly / monthly
 * trend with composition curves, session & method breakdown, quality breakdown, top
 * producers and today's figures. With ?animalId it is the animal dashboard and also
 * returns the milkYield input used by the FeedRecommendation engine.
 */
const getSummary = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const period = isBlank(query.period)
    ? SummaryPeriods.DAILY
    : parseEnum("period", query.period, Object.values(SummaryPeriods));
  const { from, to } = summaryWindow(query, period === SummaryPeriods.MONTHLY ? 180 : DEFAULT_SUMMARY_DAYS);
  const animal = isBlank(query.animalId) ? null : await findAnimal(access, query.animalId);
  const scope = { farmId: access.farmObjectId, isVoided: false, ...(animal ? { animalId: animal._id } : {}) };
  const match = { ...scope, recordDate: { $gte: from, $lte: to } };
  const today = new Date(dayKey(new Date()));
  const last7From = new Date(today.getTime() - 6 * DAY_MS);

  const [totals, trend, bySession, byMethod, byQuality, top, todayRows, last7] = await Promise.all([
    MilkRecordModel.aggregate<TTotalsRow>([{ $match: match }, { $group: totalsGroup }]),
    MilkRecordModel.aggregate<TTrendRow>(trendPipeline(match, period)),
    MilkRecordModel.aggregate<TGroupRow>(groupedPipeline(match, "milkingSession")),
    MilkRecordModel.aggregate<TGroupRow>(groupedPipeline(match, "milkingMethod")),
    MilkRecordModel.aggregate<TGroupRow>(groupedPipeline(match, "quality")),
    animal
      ? Promise.resolve([])
      : MilkRecordModel.aggregate<{ _id: Types.ObjectId; liters: number; records: number; days: unknown[]; animal: TAnimalLite[] }>([
          { $match: match },
          { $group: { _id: "$animalId", liters: { $sum: "$quantityInLiters" }, records: { $sum: 1 }, days: { $addToSet: "$recordDate" } } },
          { $sort: { liters: -1 } },
          { $limit: TOP_PRODUCERS_LIMIT },
          { $lookup: { from: "animals", localField: "_id", foreignField: "_id", as: "animal" } },
        ]),
    MilkRecordModel.aggregate<TTotalsRow>([{ $match: { ...scope, recordDate: today } }, { $group: totalsGroup }]),
    MilkRecordModel.aggregate<TTotalsRow>([
      { $match: { ...scope, recordDate: { $gte: last7From, $lte: new Date(today.getTime() + DAY_MS - 1) } } },
      { $group: totalsGroup },
    ]),
  ]);

  const totalView = totalsView(totals[0]);
  const calendarDays = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS));
  const last7View = totalsView(last7[0]);

  return {
    window: { from, to, period, calendarDays },
    basis: {
      unit: "liter",
      avgDailyLiters: "total liters ÷ days that have at least one record",
      avgPerCalendarDay: "total liters ÷ calendar days in the window",
      saleableLiters: 'excludes quality "Rejected" and milk inside a medicine withdrawal period',
    },
    animal: animal ? animalView(animal) : null,
    totals: { ...totalView, avgPerCalendarDay: round3(totalView.totalLiters / calendarDays) },
    today: totalsView(todayRows[0]),
    trend: trendView(trend),
    bySession: breakdown(bySession, SESSIONS, totalView.totalLiters, "Unknown"),
    byMethod: breakdown(byMethod, METHODS, totalView.totalLiters, "Not recorded"),
    qualityBreakdown: breakdown(byQuality, QUALITIES, totalView.totalLiters, "Not graded"),
    topProducers: top.map((t) => ({
      animalId: t._id,
      animalCode: t.animal[0]?.animalCode ?? null,
      name: t.animal[0]?.name ?? null,
      liters: round3(t.liters),
      records: t.records,
      avgDailyLiters: t.days.length ? round3(t.liters / t.days.length) : 0,
    })),
    //input for FeedRecommendation (milkYield, L/day) — only meaningful per animal
    feedPlanningInput: animal
      ? { milkYield: last7View.avgDailyLiters, basis: "average liters per recorded day, last 7 days", days: last7View.productionDays }
      : null,
  };
};

/**
 * GET /animals/:animalId/milk-records — chronological history of one animal: paginated
 * records, daily totals, session averages, quality (fat / protein / snf) trend and
 * the current withdrawal status.
 */
const getAnimalMilkRecords = async (farmId: string, animalRef: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const animal = await findAnimal(access, animalRef);
  const { from, to } = summaryWindow(query);
  const base = { farmId: access.farmObjectId, animalId: animal._id, isVoided: false };
  const windowMatch = { ...base, recordDate: { $gte: from, $lte: to } };

  const listFilter: Record<string, unknown> = { ...windowMatch };
  if (!isBlank(query.milkingSession)) {
    listFilter.milkingSession = { $in: parseEnumList("milkingSession", query.milkingSession, SESSIONS) };
  }
  const normalized = normalizeAliases(query);
  if (!isBlank(normalized.quality)) listFilter.quality = qualityFilter(normalized.quality);
  const { page, limit, skip } = parsePaging(query, MAX_LIST_LIMIT, 20);
  const today = new Date(dayKey(new Date()));

  const [total, records, totals, daily, bySession, lastRecord, withdrawals] = await Promise.all([
    MilkRecordModel.countDocuments(listFilter),
    populateRecord(MilkRecordModel.find(listFilter).sort(parseSort(query.sort)).skip(skip).limit(limit).select("-__v")).lean(),
    MilkRecordModel.aggregate<TTotalsRow>([{ $match: windowMatch }, { $group: totalsGroup }]),
    MilkRecordModel.aggregate<TTrendRow & { sessions: string[] }>(
      trendPipeline(windowMatch, SummaryPeriods.DAILY, { sessions: { $push: "$milkingSession" } }, -1),
    ),
    MilkRecordModel.aggregate<TGroupRow & { avgFat: number | null }>([
      { $match: windowMatch },
      {
        $group: {
          _id: "$milkingSession",
          records: { $sum: 1 },
          liters: { $sum: "$quantityInLiters" },
          avgFat: { $avg: "$fatPercentage" },
        },
      },
    ]),
    MilkRecordModel.findOne(base)
      .sort({ recordDate: -1, createdAt: -1 })
      .select("recordDate milkingSession quantity unit quantityInLiters quality")
      .lean(),
    findActiveWithdrawals(access.farmObjectId, animal._id, today),
  ]);

  const totalsSummary = totalsView(totals[0]);
  return {
    meta: pageMeta(page, limit, total),
    data: {
      animal: animalView(animal),
      window: { from, to },
      summary: { ...totalsSummary, lastRecord: lastRecord ?? null },
      withdrawal: { active: withdrawals.length > 0, details: withdrawals },
      dailyTotals: daily.map((d) => ({
        date: d._id,
        records: d.records,
        sessions: [...d.sessions].sort((a, b) => (MILKING_SESSION_ORDER[a] ?? 9) - (MILKING_SESSION_ORDER[b] ?? 9)),
        liters: round3(d.liters),
        rejectedLiters: round3(d.rejectedLiters),
        avgFatPercentage: d.avgFat == null ? null : round(d.avgFat, 2),
        avgProteinPercentage: d.avgProtein == null ? null : round(d.avgProtein, 2),
        avgSnfPercentage: d.avgSnf == null ? null : round(d.avgSnf, 2),
      })),
      sessionAverages: SESSIONS.map((session) => {
        const row = bySession.find((s) => s._id === session);
        return {
          milkingSession: session,
          records: row?.records ?? 0,
          liters: round3(row?.liters ?? 0),
          avgYield: row?.records ? round3(row.liters / row.records) : 0,
          avgFatPercentage: row?.avgFat == null ? null : round(row.avgFat, 2),
        };
      }),
      records: (records as Record<string, unknown>[]).map(withDerived),
    },
  };
};

/** GET /:id — one milking record with animal profile and recorder attribution. */
const getMilkRecord = async (farmId: string, id: string, requesterUserId: string) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const doc = await findRecord(access, id);
  //voided rows are visible only to Owner / Manager
  if (doc.isVoided && !can(access, MilkRecordPermissions.AUDIT)) {
    throw new AppError(status.NOT_FOUND, "Milk record not found!");
  }
  return loadDetail(doc._id);
};

/** GET /meta — enums, limits and permissions for forms and filters. */
const getMeta = () => ({
  milkingSessions: SESSIONS,
  units: UNITS,
  qualities: QUALITIES,
  milkingMethods: METHODS,
  summaryPeriods: Object.values(SummaryPeriods),
  deleteModes: Object.values(MilkDeleteModes),
  permissions: MilkRecordPermissions,
  compositionLimits: COMPOSITION_LIMITS,
  limits: {
    maxSessionLiters: MAX_SESSION_LITERS,
    maxBackdateDays: MAX_BACKDATE_DAYS,
    maxTextLength: MAX_TEXT_LENGTH,
    maxSummaryDays: MAX_SUMMARY_DAYS,
    maxBulkEntries: MAX_BULK_ENTRIES,
  },
  productionDropPercent: PRODUCTION_DROP_PERCENT,
  totalsUnit: "liter",
});

/**
 * GET /recorders — active members who can be picked as recordedBy. Only name, code and
 * farm role are returned (no phone / NID / salary), so every member may call it.
 */
const getRecorders = async (farmId: string, requesterUserId: string) => {
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

/** GET /:id/audit-logs — Owner / Manager: who created, corrected, graded or voided it. */
const getAuditLogs = async (farmId: string, id: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, MilkRecordPermissions.AUDIT, "view milk record history");
  const value = String(id ?? "").trim();
  if (!isValidObjectId(value)) throw new AppError(status.BAD_REQUEST, "Invalid milk record id!");
  //hard-deleted records keep their audit trail, so the record itself is not required
  const { page, limit, skip } = parsePaging(query, MAX_LIST_LIMIT);
  const filter = {
    entityType: AuditEntityTypes.MILK_RECORD,
    entityId: new Types.ObjectId(value),
    farmId: access.farmObjectId,
  };
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

export const MilkRecordServices = {
  checkEligibilityForForm,
  createMilkRecord,
  bulkCreateMilkRecords,
  updateMilkRecord,
  updateMilkQuality,
  deleteMilkRecord,
  getFarmMilkRecords,
  getAnimalMilkRecords,
  getSummary,
  getMilkRecord,
  getMeta,
  getRecorders,
  getAuditLogs,
};
