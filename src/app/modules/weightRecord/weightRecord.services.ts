import status from "http-status";
import mongoose, { isValidObjectId, Types } from "mongoose";
import AppError from "../../errors/AppError.js";
import { AnimalModel } from "../animal/animal.model.js";
import {
  AnimalHealthStatuses,
  AnimalLifeStatuses,
} from "../animal/animal.constants.js";
import { AuditLogModel } from "../auditLog/auditLog.model.js";
import { AuditActions, AuditEntityTypes, AuditModules } from "../auditLog/auditLog.constants.js";
import type { TAuditAction } from "../auditLog/auditLog.interface.js";
import { recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext } from "../auditLog/auditLog.utils.js";
import { BreedModel } from "../breed/breed.model.js";
import { FarmModel } from "../farm/farm.model.js";
import { FarmStatuses } from "../farm/farm.constants.js";
import { FarmMemberModel } from "../farmMember/farmMember.model.js";
import type { TFarmMemberRole } from "../farmMember/farmMember.interface.js";
import { FarmMemberServices } from "../farmMember/farmMember.service.js";
import { FeedRecommendationModel } from "../feedRecommendation/feedRecommendation.model.js";
import { ACTIVE_RECOMMENDATION_STATUSES } from "../feedRecommendation/feedRecommendation.constants.js";
import {
  ABNORMAL_CHANGE_PERCENT,
  DEFAULT_LIST_LIMIT,
  DEFAULT_STALE_DAYS,
  DEFAULT_SUMMARY_DAYS,
  FUTURE_TOLERANCE_HOURS,
  MAX_BACKDATE_DAYS,
  MAX_LIST_LIMIT,
  MAX_STALE_DAYS,
  MAX_SUMMARY_ANIMALS,
  MAX_SUMMARY_DAYS,
  MAX_TEXT_LENGTH,
  MAX_WEIGHT_KG,
  MAX_WEIGHT_LB,
  MeasurementMethods,
  OVERDUE_LIST_LIMIT,
  SERVER_CALCULATED_FIELDS,
  WeightDeleteModes,
  WeightRecordPermissions,
  WeightUnits,
} from "./weightRecord.constants.js";
import type { TMeasurementMethod, TWeightRecord, TWeightUnit } from "./weightRecord.interface.js";
import { WeightRecordModel } from "./weightRecord.model.js";
import {
  calculateAdg,
  DAY_MS,
  dayKey,
  daysBetween,
  escapeRegex,
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
  percentChange,
  round,
  toKg,
} from "./weightRecord.utils.js";
import type { TPayload } from "./weightRecord.utils.js";

const UNITS = Object.values(WeightUnits) as string[];
const METHODS = Object.values(MeasurementMethods) as string[];
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

/** Setup / Suspended / Inactive farms cannot log weights (records stay readable). */
const requireWritableFarm = (access: TAccess) => {
  if (access.farmStatus !== FarmStatuses.ACTIVE) {
    throw new AppError(
      status.FORBIDDEN,
      `This farm is ${access.farmStatus} — weight records can only be written on an Active farm!`,
    );
  }
};

const requireMemberRow = (access: TAccess): Types.ObjectId => {
  if (!access.memberObjectId) {
    throw new AppError(status.FORBIDDEN, "An active farm membership is required to write weight records!");
  }
  return access.memberObjectId;
};

const rejectServerFields = (body: TPayload) => {
  const sent = SERVER_CALCULATED_FIELDS.filter((field) => field in body);
  if (sent.length) {
    throw new AppError(status.BAD_REQUEST, `${sent.join(", ")} cannot be sent — the server derives these values.`);
  }
};

/* -------------------------------------------------------------------------- */
/*                             Animal + eligibility                           */
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
  breedId?: Types.ObjectId;
  currentWeight?: number;
  purpose: string;
};

const ANIMAL_FIELDS =
  "animalCode name gender lifeStatus healthStatus reproductiveStatus isActive birthDate breedId currentWeight purpose";

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
  //an animal of another farm is reported as missing (farm isolation)
  if (!animal) throw new AppError(status.NOT_FOUND, "Animal not found in this farm!");
  return animal as unknown as TAnimalLite;
};

const animalView = (animal: TAnimalLite) => ({
  _id: animal._id,
  animalCode: animal.animalCode,
  name: animal.name ?? null,
  gender: animal.gender,
  purpose: animal.purpose,
  lifeStatus: animal.lifeStatus,
  healthStatus: animal.healthStatus,
  reproductiveStatus: animal.reproductiveStatus,
  birthDate: animal.birthDate ?? null,
  breedId: animal.breedId ?? null,
  currentWeight: animal.currentWeight ?? null,
});

/**
 * Weight can be measured for any species / sex / age — but not for an animal that
 * left active management (Sold / Dead / Transferred / Archived, spec §55).
 * Corrections of historical rows only warn.
 */
const checkEligibility = (animal: TAnimalLite, isCorrection: boolean, warnings: string[], blockers: string[]) => {
  const inactive = animal.lifeStatus !== AnimalLifeStatuses.ACTIVE || !animal.isActive;
  if (inactive) {
    const message = `Animal ${animal.animalCode} is ${animal.lifeStatus} — weight can only be logged for active animals.`;
    if (isCorrection) warnings.push(`Animal ${animal.animalCode} is ${animal.lifeStatus}; this is a historical correction.`);
    else blockers.push(message);
  }
  if (animal.healthStatus && animal.healthStatus !== AnimalHealthStatuses.HEALTHY) {
    warnings.push(
      `Animal is ${animal.healthStatus}; a weight change may reflect the health condition rather than growth.`,
    );
  }
};

const parseRecordedDate = (value: unknown, birthDate?: Date | null): Date => {
  const date = parseCalendarDate("recordedDate", value);
  const now = Date.now();
  //a weight is a measurement that already happened — no future dates
  if (date.getTime() > now + FUTURE_TOLERANCE_HOURS * 60 * 60 * 1000) {
    throw new AppError(status.BAD_REQUEST, "recordedDate cannot be in the future!");
  }
  if (date.getTime() < now - MAX_BACKDATE_DAYS * DAY_MS) {
    throw new AppError(status.BAD_REQUEST, `recordedDate cannot be more than ${MAX_BACKDATE_DAYS} days in the past!`);
  }
  if (birthDate && date.getTime() < new Date(dayKey(birthDate)).getTime()) {
    throw new AppError(status.BAD_REQUEST, "recordedDate cannot be before the animal's birth date!");
  }
  return date;
};

/* -------------------------------------------------------------------------- */
/*                             Draft construction                             */
/* -------------------------------------------------------------------------- */

type TPreviousRecord = {
  _id: Types.ObjectId;
  recordedDate: Date;
  weight: number;
  weightUnit: string;
  weightInKg: number;
  averageDailyGain: number | null;
};

type TStored = TWeightRecord & { _id: Types.ObjectId; updatedAt: Date };

type TDraft = {
  animal: TAnimalLite;
  recordedDate: Date;
  weight: number;
  weightUnit: TWeightUnit;
  weightInKg: number;
  measurementMethod: TMeasurementMethod;
  measuredBy: Types.ObjectId;
  remarks: string | undefined;
  previousRecord: TPreviousRecord | null;
  predictedAdg: number | null;
  intervalDays: number | null;
  duplicateOf: Types.ObjectId | null;
  warnings: string[];
  blockers: string[];
};

const findPreviousRecord = async (
  access: TAccess,
  animalId: Types.ObjectId,
  before: Date,
  excludeId: Types.ObjectId | null,
): Promise<TPreviousRecord | null> => {
  const row = await WeightRecordModel.findOne({
    farmId: access.farmObjectId,
    animalId,
    isVoided: false,
    recordedDate: { $lt: before },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  })
    .sort({ recordedDate: -1, createdAt: -1, _id: -1 })
    .select("recordedDate weight weightUnit weightInKg averageDailyGain")
    .lean();
  return (row as unknown as TPreviousRecord | null) ?? null;
};

/**
 * Validates a create body (existing = null) or a correction body (existing = the
 * stored record; omitted fields keep their stored values). Never writes.
 */
const buildDraft = async (access: TAccess, rawBody: TPayload, existing: TStored | null): Promise<TDraft> => {
  const body = rawBody;
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
          "animalId cannot be changed. Void this record and log the weight for the right animal.",
        );
      }
    }
  }
  const animal = await findAnimal(access, existing ? String(existing.animalId) : body.animalId);
  checkEligibility(animal, Boolean(existing), warnings, blockers);

  //--- date
  let recordedDate: Date;
  if (isBlank(body.recordedDate)) {
    if (!existing) throw new AppError(status.BAD_REQUEST, "recordedDate is required!");
    recordedDate = existing.recordedDate;
  } else {
    recordedDate = parseRecordedDate(body.recordedDate, animal.birthDate ?? null);
  }

  //--- weight + unit (user value kept, kg derived, spec §11)
  const weightUnit = (
    isBlank(body.weightUnit) ? existing?.weightUnit ?? WeightUnits.KG : parseEnum("weightUnit", body.weightUnit, UNITS)
  ) as TWeightUnit;
  const maxInUnit = weightUnit === WeightUnits.LB ? MAX_WEIGHT_LB : MAX_WEIGHT_KG;
  let weight: number;
  if (isBlank(body.weight)) {
    if (!existing) throw new AppError(status.BAD_REQUEST, "weight is required!");
    weight = existing.weight;
  } else {
    weight = round(parseNumber("weight", body.weight, { min: 0, max: maxInUnit, exclusiveMin: true }), 3);
  }
  const weightInKg = toKg(weight, weightUnit);

  //--- measurement provenance (required)
  const measurementMethod = (
    isBlank(body.measurementMethod) && existing
      ? existing.measurementMethod
      : parseEnum("measurementMethod", body.measurementMethod, METHODS)
  ) as TMeasurementMethod;
  if (measurementMethod === MeasurementMethods.ESTIMATED) {
    warnings.push(
      "This weight is Estimated, not measured — it is stored with its provenance and should not be treated as equally reliable for feed planning.",
    );
  }

  //--- measuredBy: an active member of THIS farm; defaults to the caller
  let measuredBy: Types.ObjectId;
  if (isBlank(body.measuredBy)) {
    measuredBy = existing?.measuredBy ?? requireMemberRow(access);
  } else {
    measuredBy = parseObjectId("measuredBy", body.measuredBy);
    const unchanged = existing && String(existing.measuredBy) === String(measuredBy);
    if (!unchanged) {
      const member = await FarmMemberModel.exists({ _id: measuredBy, farmId: access.farmObjectId, isActive: true });
      if (!member) throw new AppError(status.BAD_REQUEST, "measuredBy must be an active member of this farm!");
    }
  }

  const remarks = "remarks" in body ? parseText("remarks", body.remarks) : existing?.remarks;

  //--- previous measurement drives ADG (spec §22–26)
  const previousRecord = await findPreviousRecord(access, animal._id, recordedDate, existing?._id ?? null);
  const intervalDays = previousRecord ? daysBetween(recordedDate, previousRecord.recordedDate) : null;
  const predictedAdg =
    previousRecord && intervalDays !== null ? calculateAdg(weightInKg, previousRecord.weightInKg, intervalDays) : null;

  if (previousRecord && predictedAdg === null) {
    warnings.push("Another measurement exists on the same day; ADG needs at least one full day between measurements.");
  }
  if (predictedAdg !== null && predictedAdg < 0) {
    warnings.push(
      `Weight loss: ${round(Math.abs(weightInKg - previousRecord!.weightInKg), 2)} kg since ${dayKey(previousRecord!.recordedDate)} (ADG ${predictedAdg} kg/day). Weight loss is recorded, not rejected — check health, feed and pregnancy status.`,
    );
  }
  const changePercent =
    previousRecord && previousRecord.weightInKg > 0 ? percentChange(weightInKg, previousRecord.weightInKg) : null;
  if (changePercent !== null && Math.abs(changePercent) >= ABNORMAL_CHANGE_PERCENT) {
    warnings.push(
      `Large weight change: ${changePercent > 0 ? "+" : ""}${changePercent}% since ${dayKey(previousRecord!.recordedDate)} (${previousRecord!.weightInKg} kg → ${weightInKg} kg). Confirm the scale reading and unit before saving.`,
    );
  }

  //--- same-day repeat (allowed by policy, spec §50, but flagged)
  const sameDay = await WeightRecordModel.findOne({
    farmId: access.farmObjectId,
    animalId: animal._id,
    recordedDate,
    isVoided: false,
    ...(existing ? { _id: { $ne: existing._id } } : {}),
  })
    .select("_id weight weightUnit weightInKg")
    .lean();
  if (sameDay) {
    warnings.push(
      `${animal.animalCode} already has a weight of ${sameDay.weight} ${sameDay.weightUnit} on ${dayKey(recordedDate)}. Multiple measurements per day are allowed — this one becomes the latest for that day.`,
    );
  }

  return {
    animal,
    recordedDate,
    weight,
    weightUnit,
    weightInKg,
    measurementMethod,
    measuredBy,
    remarks,
    previousRecord,
    predictedAdg,
    intervalDays,
    duplicateOf: (sameDay?._id as Types.ObjectId | undefined) ?? null,
    warnings,
    blockers,
  };
};

const draftToData = (access: TAccess, draft: TDraft): TWeightRecord => ({
  farmId: access.farmObjectId,
  animalId: draft.animal._id,
  recordedDate: draft.recordedDate,
  weight: draft.weight,
  weightUnit: draft.weightUnit,
  weightInKg: draft.weightInKg,
  measurementMethod: draft.measurementMethod,
  averageDailyGain: null,
  measuredBy: draft.measuredBy,
  ...(draft.remarks ? { remarks: draft.remarks } : {}),
  isVoided: false,
});

const throwIfBlocked = (draft: TDraft) => {
  if (!draft.blockers.length) return;
  throw new AppError(status.UNPROCESSABLE_ENTITY, `Weight record cannot be saved: ${draft.blockers.join(" ")}`);
};

/* -------------------------------------------------------------------------- */
/*                     Derived chain + current-weight sync                    */
/* -------------------------------------------------------------------------- */

type TChainRow = {
  _id: Types.ObjectId;
  recordedDate: Date;
  weightInKg: number;
  averageDailyGain: number | null;
};

/**
 * Recalculates averageDailyGain for the WHOLE animal timeline (spec §37, §52–53).
 * This is deliberately not a one-row fix: a backdated insert, a corrected date or a
 * void changes the neighbours of the edited record too, so every ADG is re-derived
 * from the ordered measurements. Returns how many rows changed.
 */
const recalculateAdgChain = async (farmId: Types.ObjectId, animalId: Types.ObjectId): Promise<number> => {
  const rows = (await WeightRecordModel.find({ farmId, animalId, isVoided: false })
    .sort({ recordedDate: 1, createdAt: 1, _id: 1 })
    .select("recordedDate weightInKg averageDailyGain")
    .lean()) as unknown as TChainRow[];

  const operations: Parameters<typeof WeightRecordModel.bulkWrite>[0] = [];
  let previous: TChainRow | null = null;
  for (const row of rows) {
    let adg: number | null = null;
    if (previous) {
      const days = daysBetween(row.recordedDate, previous.recordedDate);
      adg = calculateAdg(row.weightInKg, previous.weightInKg, days);
    }
    const current = row.averageDailyGain ?? null;
    if ((current === null ? null : round(current, 3)) !== adg) {
      operations.push({ updateOne: { filter: { _id: row._id }, update: { $set: { averageDailyGain: adg } } } });
    }
    previous = row;
  }
  if (operations.length) await WeightRecordModel.bulkWrite(operations);
  return operations.length;
};

type TSyncResult = {
  animalId: Types.ObjectId;
  currentWeight: number | null;
  recordedDate: Date | null;
};

/**
 * Animal.currentWeight is only a fast snapshot: it always mirrors the LATEST valid
 * measurement (spec §34–35). A backdated record therefore never overwrites it.
 */
const syncCurrentWeight = async (farmId: Types.ObjectId, animalId: Types.ObjectId): Promise<TSyncResult> => {
  const latest = await WeightRecordModel.findOne({ farmId, animalId, isVoided: false })
    .sort({ recordedDate: -1, createdAt: -1, _id: -1 })
    .select("weightInKg recordedDate")
    .lean();
  if (!latest) {
    //no measurements left: keep whatever snapshot the animal already had
    const animal = await AnimalModel.findById(animalId).select("currentWeight").lean();
    return { animalId, currentWeight: (animal?.currentWeight as number | undefined) ?? null, recordedDate: null };
  }
  const currentWeight = round(latest.weightInKg as number, 2);
  await AnimalModel.updateOne({ _id: animalId, farmId }, { $set: { currentWeight } });
  return { animalId, currentWeight, recordedDate: latest.recordedDate as Date };
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
        ? "animalCode name gender purpose lifeStatus healthStatus reproductiveStatus currentWeight birthDate breedId profilePhoto"
        : "animalCode name gender reproductiveStatus currentWeight",
    )
    .populate({ path: "measuredBy", ...MEMBER_POPULATE })
    .populate({ path: "voidedBy", ...MEMBER_POPULATE }) as unknown as T;
};

//provenance is exposed explicitly so "Estimated" never silently looks like a scale reading
const withDerived = <T extends Record<string, unknown>>(record: T) => ({
  ...record,
  isEstimated: record.measurementMethod === MeasurementMethods.ESTIMATED,
  measurementReliability: record.measurementMethod === MeasurementMethods.ESTIMATED ? "Estimated" : "Direct",
});

const findRecord = async (access: TAccess, ref: string): Promise<TStored> => {
  const value = String(ref ?? "").trim();
  if (!isValidObjectId(value)) throw new AppError(status.BAD_REQUEST, "Invalid weight record id!");
  const doc = await WeightRecordModel.findOne({
    _id: new Types.ObjectId(value),
    farmId: access.farmObjectId,
  }).lean();
  if (!doc) throw new AppError(status.NOT_FOUND, "Weight record not found!");
  return doc as unknown as TStored;
};

const loadDetail = async (id: Types.ObjectId) => {
  const record = await populateRecord(WeightRecordModel.findById(id).select("-__v"), true).lean();
  return record ? withDerived(record as Record<string, unknown>) : null;
};

const AUDITED_FIELDS = [
  "recordedDate",
  "weight",
  "weightUnit",
  "weightInKg",
  "measurementMethod",
  "averageDailyGain",
  "measuredBy",
  "remarks",
] as const;

const auditSnapshot = (record: Partial<TWeightRecord>) => ({
  animalId: record.animalId,
  recordedDate: record.recordedDate,
  weight: record.weight,
  weightUnit: record.weightUnit,
  weightInKg: record.weightInKg,
  measurementMethod: record.measurementMethod,
  averageDailyGain: record.averageDailyGain ?? null,
  measuredBy: record.measuredBy,
  remarks: record.remarks ?? null,
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
    entityType: AuditEntityTypes.WEIGHT_RECORD,
    entityId,
    action,
    //AuditLog (Model 24) has no Production module; weight is an animal record
    module: AuditModules.ANIMAL,
    event,
    oldData,
    newData,
    changedFields,
  });

/* -------------------------------------------------------------------------- */
/*                                   Writes                                   */
/* -------------------------------------------------------------------------- */

/**
 * GET /check — dry-run eligibility for the entry form: animal state, the previous
 * measurement, the ADG this weight would produce and whether currentWeight changes.
 * Nothing is written.
 */
const checkWeightEntry = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const animal = await findAnimal(access, query.animalId);
  const warnings: string[] = [];
  const blockers: string[] = [];
  checkEligibility(animal, false, warnings, blockers);
  const recordedDate = isBlank(query.recordedDate)
    ? new Date(dayKey(new Date()))
    : parseRecordedDate(query.recordedDate, animal.birthDate ?? null);

  const unit = (isBlank(query.weightUnit) ? WeightUnits.KG : parseEnum("weightUnit", query.weightUnit, UNITS)) as TWeightUnit;
  let weightInKg: number | null = null;
  if (!isBlank(query.weight)) {
    const maxInUnit = unit === WeightUnits.LB ? MAX_WEIGHT_LB : MAX_WEIGHT_KG;
    weightInKg = toKg(
      round(parseNumber("weight", query.weight, { min: 0, max: maxInUnit, exclusiveMin: true }), 3),
      unit,
    );
  }

  const previousRecord = await findPreviousRecord(access, animal._id, recordedDate, null);
  const intervalDays = previousRecord ? daysBetween(recordedDate, previousRecord.recordedDate) : null;
  const predictedAdg =
    previousRecord && weightInKg !== null && intervalDays !== null
      ? calculateAdg(weightInKg, previousRecord.weightInKg, intervalDays)
      : null;
  if (previousRecord && weightInKg !== null && intervalDays !== null && predictedAdg === null) {
    warnings.push("Another measurement exists on the same day; ADG needs at least one full day between measurements.");
  }
  const sameDay = await WeightRecordModel.findOne({
    farmId: access.farmObjectId,
    animalId: animal._id,
    recordedDate,
    isVoided: false,
  })
    .select("weight weightUnit weightInKg")
    .lean();
  if (sameDay) {
    warnings.push(`${animal.animalCode} already has a weight of ${sameDay.weight} ${sameDay.weightUnit} on ${dayKey(recordedDate)}.`);
  }

  const latest = await WeightRecordModel.findOne({ farmId: access.farmObjectId, animalId: animal._id, isVoided: false })
    .sort({ recordedDate: -1, createdAt: -1, _id: -1 })
    .select("recordedDate weightInKg")
    .lean();
  const willUpdateCurrentWeight = !latest || recordedDate.getTime() >= new Date(latest.recordedDate as Date).getTime();

  return {
    animal: animalView(animal),
    recordedDate,
    previousRecord: previousRecord
      ? {
          _id: previousRecord._id,
          recordedDate: previousRecord.recordedDate,
          weight: previousRecord.weight,
          weightUnit: previousRecord.weightUnit,
          weightInKg: previousRecord.weightInKg,
        }
      : null,
    intervalDays,
    predicted: {
      weightInKg,
      averageDailyGain: predictedAdg,
      changePercent:
        previousRecord && weightInKg !== null && previousRecord.weightInKg > 0
          ? percentChange(weightInKg, previousRecord.weightInKg)
          : null,
    },
    currentWeight: {
      storedKg: animal.currentWeight ?? null,
      latestRecord: latest ?? null,
      willUpdate: willUpdateCurrentWeight,
    },
    duplicateSameDay: sameDay ?? null,
    warnings,
    blockers,
    canLog: blockers.length === 0 && access.farmStatus === FarmStatuses.ACTIVE && can(access, WeightRecordPermissions.CREATE),
  };
};

/** POST / — logs one weight measurement (Owner / Manager / Worker). */
const createWeightRecord = async (farmId: string, requesterUserId: string, payload: TPayload, context: TAuditContext) => {
  const body = payload ?? {};
  rejectServerFields(body);
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, WeightRecordPermissions.CREATE, "log weight");
  requireWritableFarm(access);
  requireMemberRow(access);

  const draft = await buildDraft(access, body, null);
  throwIfBlocked(draft);
  const data = draftToData(access, draft);

  const doc = await WeightRecordModel.create(data);
  await recalculateAdgChain(access.farmObjectId, draft.animal._id);
  const synced = await syncCurrentWeight(access.farmObjectId, draft.animal._id);

  const stored = (await WeightRecordModel.findById(doc._id).lean()) as unknown as TWeightRecord;
  await audit(context, access.farmObjectId, doc._id, AuditActions.CREATE, "WeightRecord Created", null, auditSnapshot(stored));

  return {
    weightRecord: await loadDetail(doc._id),
    previousRecord: draft.previousRecord,
    adg: {
      averageDailyGain: stored.averageDailyGain ?? null,
      intervalDays: draft.intervalDays,
      previousWeightKg: draft.previousRecord?.weightInKg ?? null,
    },
    currentWeight: synced,
    warnings: draft.warnings,
  };
};

/**
 * PUT /:id — controlled correction (Owner / Manager, spec §52). Any field except the
 * animal may change; kg and the whole ADG chain are recalculated, currentWeight is
 * re-synced and the change is audited with oldData / newData / changedFields.
 */
const updateWeightRecord = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  rejectServerFields(body);
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, WeightRecordPermissions.UPDATE, "correct weight records");
  requireWritableFarm(access);
  const reason = parseText("reason", body.reason);

  const doc = await findRecord(access, id);
  if (doc.isVoided) throw new AppError(status.CONFLICT, "This weight record was voided and can no longer be corrected!");

  const draft = await buildDraft(access, body, doc);
  throwIfBlocked(draft);
  const next = draftToData(access, draft);

  //averageDailyGain is derived by the chain recalculation below, so it never decides whether
  //the user actually corrected anything (an untouched first record may already carry null)
  const CORRECTABLE_FIELDS = AUDITED_FIELDS.filter((field) => field !== "averageDailyGain");
  const changedFields = CORRECTABLE_FIELDS.filter((field) => !sameValue(next[field as keyof TWeightRecord], doc[field]));
  if (changedFields.length === 0) {
    return { mode: "unchanged", weightRecord: await loadDetail(doc._id), warnings: draft.warnings };
  }

  const set: Record<string, unknown> = {};
  for (const field of AUDITED_FIELDS) {
    if (field !== "remarks" && field !== "averageDailyGain") set[field] = next[field as keyof TWeightRecord];
  }
  const update = next.remarks ? { $set: { ...set, remarks: next.remarks } } : { $set: set, $unset: { remarks: 1 } };
  //optimistic guard: nobody else corrected / voided it since it was read
  const result = await WeightRecordModel.updateOne(
    { _id: doc._id, updatedAt: doc.updatedAt, isVoided: false },
    update,
  );
  if (result.modifiedCount !== 1) {
    throw new AppError(status.CONFLICT, "The weight record was changed by someone else; reload and try again.");
  }

  const chainUpdates = await recalculateAdgChain(access.farmObjectId, doc.animalId);
  const synced = await syncCurrentWeight(access.farmObjectId, doc.animalId);
  const stored = (await WeightRecordModel.findById(doc._id).lean()) as unknown as TWeightRecord;

  //the correction may also change this row's derived ADG (or its neighbours' — see adgChainUpdates)
  const derivedChanges = sameValue(stored.averageDailyGain ?? null, doc.averageDailyGain ?? null) ? [] : ["averageDailyGain"];
  const auditedChanges = [...changedFields, ...derivedChanges];

  await audit(
    context,
    access.farmObjectId,
    doc._id,
    AuditActions.UPDATE,
    "WeightRecord Corrected",
    auditSnapshot(doc),
    { ...auditSnapshot(stored), ...(reason ? { reason } : {}) },
    auditedChanges,
  );

  return {
    mode: "updated",
    changedFields: auditedChanges,
    weightRecord: await loadDetail(doc._id),
    adgChainUpdates: chainUpdates,
    currentWeight: synced,
    warnings: draft.warnings,
  };
};

/**
 * DELETE /:id — Owner only (spec §54–55).
 *  - mode "void" (default): the row stays as history and leaves every growth
 *    calculation; the next record's ADG is recalculated and currentWeight re-synced.
 *  - mode "hard": permanent removal, only for duplicate / accidental entries. A reason
 *    is required and the full oldData is kept in the AuditLog.
 */
const deleteWeightRecord = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, WeightRecordPermissions.DELETE, "delete weight records");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);
  const mode = isBlank(body.mode) ? WeightDeleteModes.VOID : parseEnum("mode", body.mode, Object.values(WeightDeleteModes));
  const reason = parseText("reason", body.reason);

  const doc = await findRecord(access, id);
  const hint =
    "If the measurement was wrong, correct the record (PUT) instead of deleting it — history stays auditable.";

  if (mode === WeightDeleteModes.HARD) {
    if (!reason) {
      throw new AppError(
        status.BAD_REQUEST,
        "A reason is required to permanently delete a weight record (duplicate / accidental entry).",
      );
    }
    await WeightRecordModel.deleteOne({ _id: doc._id, farmId: access.farmObjectId });
    const chainUpdates = await recalculateAdgChain(access.farmObjectId, doc.animalId);
    const synced = await syncCurrentWeight(access.farmObjectId, doc.animalId);
    await audit(
      context,
      access.farmObjectId,
      doc._id,
      AuditActions.DELETE,
      "WeightRecord Deleted (duplicate / accidental)",
      auditSnapshot(doc),
      { reason },
      [],
    );
    return { _id: doc._id, mode, deleted: true, adgChainUpdates: chainUpdates, currentWeight: synced, hint };
  }

  if (doc.isVoided) throw new AppError(status.CONFLICT, "This weight record is already voided!");
  const voidedAt = new Date();
  const result = await WeightRecordModel.updateOne(
    { _id: doc._id, updatedAt: doc.updatedAt, isVoided: false },
    { $set: { isVoided: true, voidedAt, voidedBy: memberId, ...(reason ? { voidReason: reason } : {}) } },
  );
  if (result.modifiedCount !== 1) {
    throw new AppError(status.CONFLICT, "The weight record was changed by someone else; reload and try again.");
  }
  const chainUpdates = await recalculateAdgChain(access.farmObjectId, doc.animalId);
  const synced = await syncCurrentWeight(access.farmObjectId, doc.animalId);
  await audit(
    context,
    access.farmObjectId,
    doc._id,
    AuditActions.DELETE,
    "WeightRecord Voided",
    auditSnapshot(doc),
    { isVoided: true, voidedAt, ...(reason ? { voidReason: reason } : {}) },
    ["isVoided", "voidedAt", "voidedBy", ...(reason ? ["voidReason"] : [])],
  );
  return { _id: doc._id, mode, isVoided: true, voidedAt, adgChainUpdates: chainUpdates, currentWeight: synced, hint };
};

/* -------------------------------------------------------------------------- */
/*                                    Reads                                   */
/* -------------------------------------------------------------------------- */

const LIST_SORT_FIELDS = new Set([
  "recordedDate",
  "createdAt",
  "weight",
  "weightInKg",
  "averageDailyGain",
  "measurementMethod",
]);

const parseSort = (value: unknown): Record<string, 1 | -1> => {
  if (isBlank(value)) return { recordedDate: -1, createdAt: -1, _id: -1 };
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
  if (mode === "exclude" || !can(access, WeightRecordPermissions.AUDIT)) return { isVoided: false };
  if (mode === "only") return { isVoided: true };
  return {};
};

/** Latest measurement per animal, used by the stale filter and the dashboard. */
const latestByAnimal = async (farmId: Types.ObjectId, animalIds?: Types.ObjectId[]) => {
  const match: Record<string, unknown> = { farmId, isVoided: false };
  if (animalIds) match.animalId = { $in: animalIds };
  const rows = await WeightRecordModel.aggregate<{
    _id: Types.ObjectId;
    recordId: Types.ObjectId;
    recordedDate: Date;
    weightInKg: number;
  }>([
    { $match: match },
    { $sort: { recordedDate: -1, createdAt: -1, _id: -1 } },
    {
      $group: {
        _id: "$animalId",
        recordId: { $first: "$_id" },
        recordedDate: { $first: "$recordedDate" },
        weightInKg: { $first: "$weightInKg" },
      },
    },
  ]);
  return new Map(rows.map((row) => [String(row._id), row]));
};

const buildListFilter = async (access: TAccess, rawQuery: TPayload) => {
  const query = rawQuery;
  const filter: Record<string, unknown> = { farmId: access.farmObjectId, ...voidFilter(access, query) };
  if (!isBlank(query.animalId)) filter.animalId = (await findAnimal(access, query.animalId))._id;
  if (!isBlank(query.measurementMethod)) {
    const values = parseEnumList("measurementMethod", query.measurementMethod, METHODS);
    filter.measurementMethod = values.length === 1 ? values[0] : { $in: values };
  }
  if (!isBlank(query.measuredBy)) filter.measuredBy = parseObjectId("measuredBy", query.measuredBy);
  Object.assign(filter, parseDateRange(query, "recordedDate"));
  if (!isBlank(query.searchTerm)) {
    filter.remarks = { $regex: escapeRegex(String(query.searchTerm).trim().slice(0, 100)), $options: "i" };
  }

  //stale=true → only the latest measurement of animals whose weight is old
  if (parseBoolean(query.stale)) {
    const staleDays = isBlank(query.staleDays)
      ? DEFAULT_STALE_DAYS
      : Math.min(
          Math.max(Math.floor(parseNumber("staleDays", query.staleDays, { min: 1, max: MAX_STALE_DAYS })), 1),
          MAX_STALE_DAYS,
        );
    const cutoff = new Date(new Date(dayKey(new Date())).getTime() - staleDays * DAY_MS);
    const latest = await latestByAnimal(access.farmObjectId);
    const staleRecordIds = [...latest.values()].filter((row) => new Date(row.recordedDate) < cutoff).map((row) => row.recordId);
    //no stale animal ⇒ an empty page (an empty $in would match everything)
    filter._id = { $in: staleRecordIds.length ? staleRecordIds : [new Types.ObjectId()] };
  }
  return filter;
};

type TTotalsRow = {
  records: number;
  animals: unknown[];
  avgWeightKg: number | null;
  minWeightKg: number | null;
  maxWeightKg: number | null;
  avgAdg: number | null;
  estimatedRecords: number;
};

const totalsGroup = {
  _id: null,
  records: { $sum: 1 },
  animals: { $addToSet: "$animalId" },
  avgWeightKg: { $avg: "$weightInKg" },
  minWeightKg: { $min: "$weightInKg" },
  maxWeightKg: { $max: "$weightInKg" },
  //$avg ignores nulls, so the first record of an animal never drags ADG to 0
  avgAdg: { $avg: "$averageDailyGain" },
  estimatedRecords: { $sum: { $cond: [{ $eq: ["$measurementMethod", MeasurementMethods.ESTIMATED] }, 1, 0] } },
};

const totalsView = (row: TTotalsRow | undefined) => ({
  records: row?.records ?? 0,
  animalsMeasured: row?.animals?.length ?? 0,
  avgWeightKg: row?.avgWeightKg == null ? null : round3(row.avgWeightKg),
  minWeightKg: row?.minWeightKg == null ? null : round3(row.minWeightKg),
  maxWeightKg: row?.maxWeightKg == null ? null : round3(row.maxWeightKg),
  avgDailyGain: row?.avgAdg == null ? null : round(row.avgAdg, 3),
  estimatedRecords: row?.estimatedRecords ?? 0,
});

type TGroupRow = { _id: string | null; records: number };

const methodBreakdown = (rows: TGroupRow[], total: number) =>
  Object.fromEntries(
    [...METHODS, "Unknown"].map((key) => {
      const row = rows.find((r) => (r._id ?? "Unknown") === key);
      return [
        key,
        {
          records: row?.records ?? 0,
          percent: total > 0 ? round(((row?.records ?? 0) / total) * 100, 1) : 0,
        },
      ];
    }),
  );

/** GET / — farm-wide weight logs with filters + pagination + filtered totals. */
const getFarmWeightRecords = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const filter = await buildListFilter(access, query);
  const { page, limit, skip } = parsePaging(query, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);
  const [total, data, totals, byMethod] = await Promise.all([
    WeightRecordModel.countDocuments(filter),
    populateRecord(WeightRecordModel.find(filter).sort(parseSort(query.sort)).skip(skip).limit(limit).select("-__v")).lean(),
    WeightRecordModel.aggregate<TTotalsRow>([{ $match: filter }, { $group: totalsGroup }]),
    WeightRecordModel.aggregate<TGroupRow>([{ $match: filter }, { $group: { _id: "$measurementMethod", records: { $sum: 1 } } }]),
  ]);
  const summary = totalsView(totals[0]);
  return {
    meta: pageMeta(page, limit, total),
    data: {
      records: (data as Record<string, unknown>[]).map(withDerived),
      //totals of the whole filtered set (not only this page)
      summary: { ...summary, byMeasurementMethod: methodBreakdown(byMethod, summary.records) },
    },
  };
};

type TAnimalRecordRow = {
  _id: Types.ObjectId;
  recordedDate: Date;
  weight: number;
  weightUnit: string;
  weightInKg: number;
  measurementMethod: string;
  averageDailyGain: number | null;
  remarks?: string;
  createdAt?: Date;
};

/**
 * GET /animals/:animalId/weight-records — the growth trajectory of one animal:
 * chronological normalized weights (kg), ADG progression and freshness.
 */
const getAnimalWeightRecords = async (farmId: string, animalRef: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const animal = await findAnimal(access, animalRef);

  const base: Record<string, unknown> = { farmId: access.farmObjectId, animalId: animal._id, isVoided: false };
  Object.assign(base, parseDateRange(query, "recordedDate"));

  const [rows, latest] = await Promise.all([
    WeightRecordModel.find(base)
      .sort({ recordedDate: 1, createdAt: 1, _id: 1 })
      .limit(500)
      .select("recordedDate weight weightUnit weightInKg measurementMethod averageDailyGain remarks createdAt")
      .lean(),
    WeightRecordModel.findOne({ farmId: access.farmObjectId, animalId: animal._id, isVoided: false })
      .sort({ recordedDate: -1, createdAt: -1, _id: -1 })
      .select("recordedDate weightInKg")
      .lean(),
  ]);

  const records = rows as unknown as TAnimalRecordRow[];
  const first = records[0] ?? null;
  const last = records[records.length - 1] ?? null;
  const spanDays = first && last ? daysBetween(last.recordedDate, first.recordedDate) : null;
  const totalGainKg = first && last ? round(last.weightInKg - first.weightInKg, 3) : null;
  const observedAdg =
    first && last && spanDays !== null && spanDays > 0 ? round((last.weightInKg - first.weightInKg) / spanDays, 3) : null;
  const intervalAdgValues = records
    .map((row) => row.averageDailyGain)
    .filter((value): value is number => typeof value === "number");
  const staleDays = isBlank(query.staleDays)
    ? DEFAULT_STALE_DAYS
    : parseNumber("staleDays", query.staleDays, { min: 1, max: MAX_STALE_DAYS });
  const latestDate = latest ? new Date(latest.recordedDate as Date) : null;
  const ageDays = latestDate ? daysBetween(new Date(dayKey(new Date())), latestDate) : null;

  return {
    data: {
      animal: animalView(animal),
      window: {
        from: (base.recordedDate as { $gte?: Date } | undefined)?.$gte ?? first?.recordedDate ?? null,
        to: (base.recordedDate as { $lte?: Date } | undefined)?.$lte ?? last?.recordedDate ?? null,
      },
      summary: {
        records: records.length,
        firstWeightKg: first?.weightInKg ?? null,
        lastWeightKg: last?.weightInKg ?? null,
        totalGainKg,
        spanDays,
        observedAdg,
        averageIntervalAdg: intervalAdgValues.length
          ? round(intervalAdgValues.reduce((sum, value) => sum + value, 0) / intervalAdgValues.length, 3)
          : null,
        latestMeasurement: latest
          ? { recordedDate: latestDate, weightInKg: round(latest.weightInKg as number, 3), ageDays }
          : null,
        isStale: latestDate ? (ageDays ?? 0) > staleDays : true,
        staleDays,
        animalCurrentWeightKg: animal.currentWeight ?? null,
      },
      //ascending on purpose: chart-ready growth curve + ADG progression
      records: records.map((row) => ({
        _id: row._id,
        recordedDate: row.recordedDate,
        weight: row.weight,
        weightUnit: row.weightUnit,
        weightInKg: row.weightInKg,
        measurementMethod: row.measurementMethod,
        isEstimated: row.measurementMethod === MeasurementMethods.ESTIMATED,
        averageDailyGain: row.averageDailyGain,
        remarks: row.remarks ?? null,
        createdAt: row.createdAt ?? null,
      })),
    },
  };
};

type TGrowthAnimal = {
  _id: Types.ObjectId;
  animalCode: string;
  name?: string;
  breedId?: Types.ObjectId;
  birthDate?: Date;
  currentWeight?: number;
};

type TGrowthRecord = {
  animalId: Types.ObjectId;
  recordedDate: Date;
  weightInKg: number;
  averageDailyGain: number | null;
  measurementMethod: string;
};

type TPerformanceStatus = "On Target" | "Slightly Below Target" | "Below Target" | "No Target" | "Insufficient Data";

const performanceStatus = (observedAdg: number | null, target: number | null): TPerformanceStatus => {
  if (target === null) return "No Target";
  if (observedAdg === null) return "Insufficient Data";
  if (observedAdg >= target) return "On Target";
  if (observedAdg >= target * 0.9) return "Slightly Below Target";
  return "Below Target";
};

/**
 * GET /growth-summary — farm / breed growth analytics (spec §40–41, §60–61):
 * observed ADG vs the target ADG frozen in the animal's latest confirmed feed
 * recommendation, per-breed performance and animals overdue for weighing.
 */
const getGrowthSummary = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);

  const today = new Date(dayKey(new Date()));
  const range = parseDateRange(query, "recordedDate").recordedDate as { $gte?: Date; $lte?: Date } | undefined;
  const to = range?.$lte ?? new Date(today.getTime() + DAY_MS - 1);
  const from = range?.$gte ?? new Date(to.getTime() - DEFAULT_SUMMARY_DAYS * DAY_MS + 1);
  if (to.getTime() - from.getTime() > MAX_SUMMARY_DAYS * DAY_MS) {
    throw new AppError(status.BAD_REQUEST, `The date range cannot exceed ${MAX_SUMMARY_DAYS} days!`);
  }
  const staleDays = isBlank(query.staleDays)
    ? DEFAULT_STALE_DAYS
    : Math.min(parseNumber("staleDays", query.staleDays, { min: 1, max: MAX_STALE_DAYS }), MAX_STALE_DAYS);
  const requestedTarget = isBlank(query.targetADG)
    ? null
    : parseNumber("targetADG", query.targetADG, { min: 0, max: 10 });

  //--- animal scope: active animals only (Sold / Dead / Transferred are history)
  const animalFilter: Record<string, unknown> = {
    farmId: access.farmObjectId,
    isActive: true,
    lifeStatus: AnimalLifeStatuses.ACTIVE,
  };
  if (!isBlank(query.animalId)) animalFilter._id = (await findAnimal(access, query.animalId))._id;
  if (!isBlank(query.breedId)) animalFilter.breedId = parseObjectId("breedId", query.breedId);

  const animals = (await AnimalModel.find(animalFilter)
    .select("animalCode name breedId birthDate currentWeight")
    .limit(MAX_SUMMARY_ANIMALS)
    .lean()) as unknown as TGrowthAnimal[];
  const animalIds = animals.map((animal) => animal._id);

  const [records, latestMap, recommendationTargets, breeds] = await Promise.all([
    animalIds.length
      ? (WeightRecordModel.find({
          farmId: access.farmObjectId,
          animalId: { $in: animalIds },
          isVoided: false,
          recordedDate: { $gte: from, $lte: to },
        })
          .sort({ recordedDate: 1, createdAt: 1, _id: 1 })
          .select("animalId recordedDate weightInKg averageDailyGain measurementMethod")
          .lean() as unknown as Promise<TGrowthRecord[]>)
      : Promise.resolve([] as TGrowthRecord[]),
    latestByAnimal(access.farmObjectId, animalIds),
    animalIds.length
      ? FeedRecommendationModel.aggregate<{ _id: Types.ObjectId; targetADG: number | null }>([
          {
            $match: {
              farmId: access.farmObjectId,
              animalId: { $in: animalIds },
              status: { $in: ACTIVE_RECOMMENDATION_STATUSES },
            },
          },
          { $sort: { generatedAt: -1 } },
          { $group: { _id: "$animalId", targetADG: { $first: "$inputSnapshot.targetADG" } } },
        ])
      : Promise.resolve([]),
    BreedModel.find({ _id: { $in: animals.map((animal) => animal.breedId).filter(Boolean) } })
      .select("breedName")
      .lean(),
  ]);

  const recordsByAnimal = new Map<string, TGrowthRecord[]>();
  for (const record of records) {
    const key = String(record.animalId);
    const list = recordsByAnimal.get(key);
    if (list) list.push(record);
    else recordsByAnimal.set(key, [record]);
  }
  const targetByAnimal = new Map(recommendationTargets.map((row) => [String(row._id), row.targetADG]));
  const breedNameById = new Map(breeds.map((breed) => [String(breed._id), breed.breedName as string]));

  //farm-level target: explicit request → average of the animals' plan targets
  const planTargets = [...targetByAnimal.values()].filter((value): value is number => typeof value === "number");
  const farmTarget =
    requestedTarget ?? (planTargets.length ? round(planTargets.reduce((sum, value) => sum + value, 0) / planTargets.length, 3) : null);

  const overdue: Record<string, unknown>[] = [];
  const perBreed = new Map<
    string,
    { breedId: string | null; breedName: string; animals: number; measured: number; adgSum: number; adgCount: number; onTarget: number; belowTarget: number }
  >();

  const animalRows = animals.map((animal) => {
    const key = String(animal._id);
    const rows = recordsByAnimal.get(key) ?? [];
    const first = rows[0] ?? null;
    const last = rows[rows.length - 1] ?? null;
    const spanDays = first && last ? daysBetween(last.recordedDate, first.recordedDate) : null;
    const totalGainKg = first && last ? round(last.weightInKg - first.weightInKg, 3) : null;
    const observedAdg =
      first && last && spanDays !== null && spanDays > 0 ? round((last.weightInKg - first.weightInKg) / spanDays, 3) : null;
    const intervalValues = rows.map((row) => row.averageDailyGain).filter((value): value is number => typeof value === "number");
    const latest = latestMap.get(key) ?? null;
    const target = targetByAnimal.get(key) ?? farmTarget;
    const statusOfAnimal = performanceStatus(observedAdg, target);
    const latestDate = latest ? new Date(latest.recordedDate) : null;
    const ageDays = latestDate ? daysBetween(today, latestDate) : null;
    const isOverdue = !latestDate || (ageDays ?? 0) > staleDays;

    if (isOverdue) {
      overdue.push({
        animalId: animal._id,
        animalCode: animal.animalCode,
        name: animal.name ?? null,
        latestWeightKg: latest ? round(latest.weightInKg, 3) : null,
        latestRecordedDate: latestDate,
        daysSinceLastMeasurement: ageDays,
      });
    }

    const breedId = animal.breedId ? String(animal.breedId) : null;
    const breedKey = breedId ?? "unassigned";
    const breedRow =
      perBreed.get(breedKey) ??
      {
        breedId,
        breedName: breedId ? breedNameById.get(breedId) ?? "Unknown breed" : "No breed",
        animals: 0,
        measured: 0,
        adgSum: 0,
        adgCount: 0,
        onTarget: 0,
        belowTarget: 0,
      };
    breedRow.animals += 1;
    if (rows.length) breedRow.measured += 1;
    if (observedAdg !== null) {
      breedRow.adgSum += observedAdg;
      breedRow.adgCount += 1;
    }
    if (statusOfAnimal === "On Target") breedRow.onTarget += 1;
    if (statusOfAnimal === "Below Target" || statusOfAnimal === "Slightly Below Target") breedRow.belowTarget += 1;
    perBreed.set(breedKey, breedRow);

    return {
      animalId: animal._id,
      animalCode: animal.animalCode,
      name: animal.name ?? null,
      breedId: animal.breedId ?? null,
      breedName: breedId ? breedNameById.get(breedId) ?? null : null,
      currentWeightKg: animal.currentWeight ?? null,
      measurements: rows.length,
      firstWeightKg: first?.weightInKg ?? null,
      lastWeightKg: last?.weightInKg ?? null,
      totalGainKg,
      spanDays,
      observedAdg,
      averageIntervalAdg: intervalValues.length
        ? round(intervalValues.reduce((sum, value) => sum + value, 0) / intervalValues.length, 3)
        : null,
      targetAdg: target,
      performanceGap: target !== null && observedAdg !== null ? round(observedAdg - target, 3) : null,
      performanceStatus: statusOfAnimal,
      latestMeasurement: latest ? { recordedDate: latestDate, weightInKg: round(latest.weightInKg, 3), ageDays } : null,
      isOverdue,
    };
  });

  const measuredRows = animalRows.filter((row) => row.measurements > 0);
  const observedValues = measuredRows
    .map((row) => row.observedAdg)
    .filter((value): value is number => typeof value === "number");
  const latestAdgValues = animalRows
    .map((row) => row.averageIntervalAdg)
    .filter((value): value is number => typeof value === "number");
  const weightValues = measuredRows
    .map((row) => row.lastWeightKg)
    .filter((value): value is number => typeof value === "number");

  const countStatus = (value: TPerformanceStatus) => animalRows.filter((row) => row.performanceStatus === value).length;

  //worst performers first (nulls last) so the dashboard leads with problems
  const sortedAnimals = [...animalRows].sort((a, b) => {
    if (a.observedAdg === null && b.observedAdg === null) return a.animalCode.localeCompare(b.animalCode);
    if (a.observedAdg === null) return 1;
    if (b.observedAdg === null) return -1;
    return a.observedAdg - b.observedAdg;
  });

  return {
    window: { from, to, staleDays, calendarDays: Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS)) },
    target: {
      adg: farmTarget,
      source: requestedTarget !== null ? "request" : planTargets.length ? "latest confirmed feed recommendations" : "none",
    },
    basis: {
      observedAdg: "(last weight in window − first weight in window) ÷ days between them",
      averageIntervalAdg: "average of the stored WeightRecord.averageDailyGain values in the window",
      targetAdg: "FeedRecommendation.inputSnapshot.targetADG of each animal's latest confirmed plan",
      stale: `no measurement in the last ${staleDays} days`,
    },
    summary: {
      animalsInScope: animals.length,
      animalsMeasured: measuredRows.length,
      animalsWithTrend: observedValues.length,
      avgObservedAdg: observedValues.length
        ? round(observedValues.reduce((sum, value) => sum + value, 0) / observedValues.length, 3)
        : null,
      avgIntervalAdg: latestAdgValues.length
        ? round(latestAdgValues.reduce((sum, value) => sum + value, 0) / latestAdgValues.length, 3)
        : null,
      avgWeightKg: weightValues.length
        ? round(weightValues.reduce((sum, value) => sum + value, 0) / weightValues.length, 3)
        : null,
      totalGainKg: round(
        measuredRows.reduce((sum, row) => sum + (row.totalGainKg ?? 0), 0),
        3,
      ),
      onTarget: countStatus("On Target"),
      slightlyBelowTarget: countStatus("Slightly Below Target"),
      belowTarget: countStatus("Below Target"),
      noTarget: countStatus("No Target"),
      insufficientData: countStatus("Insufficient Data"),
      animalsOverdue: overdue.length,
    },
    animals: sortedAnimals,
    byBreed: [...perBreed.values()].map((row) => ({
      breedId: row.breedId,
      breedName: row.breedName,
      animals: row.animals,
      animalsMeasured: row.measured,
      avgObservedAdg: row.adgCount ? round(row.adgSum / row.adgCount, 3) : null,
      onTarget: row.onTarget,
      belowTarget: row.belowTarget,
    })),
    overdue: {
      count: overdue.length,
      animals: overdue.slice(0, OVERDUE_LIST_LIMIT),
    },
  };
};

/** GET /:id — one measurement with animal profile, recorder and neighbours. */
const getWeightRecord = async (farmId: string, id: string, requesterUserId: string) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const doc = await findRecord(access, id);
  //voided rows are visible only to Owner / Manager
  if (doc.isVoided && !can(access, WeightRecordPermissions.AUDIT)) {
    throw new AppError(status.NOT_FOUND, "Weight record not found!");
  }

  const [detail, previous, next] = await Promise.all([
    loadDetail(doc._id),
    WeightRecordModel.findOne({
      farmId: access.farmObjectId,
      animalId: doc.animalId,
      isVoided: false,
      recordedDate: { $lt: doc.recordedDate },
      _id: { $ne: doc._id },
    })
      .sort({ recordedDate: -1, createdAt: -1, _id: -1 })
      .select("recordedDate weight weightUnit weightInKg averageDailyGain measurementMethod")
      .lean(),
    WeightRecordModel.findOne({
      farmId: access.farmObjectId,
      animalId: doc.animalId,
      isVoided: false,
      recordedDate: { $gt: doc.recordedDate },
      _id: { $ne: doc._id },
    })
      .sort({ recordedDate: 1, createdAt: 1, _id: 1 })
      .select("recordedDate weight weightUnit weightInKg averageDailyGain measurementMethod")
      .lean(),
  ]);

  return { ...(detail ?? {}), previousRecord: previous ?? null, nextRecord: next ?? null };
};

/** GET /meta — enums, limits and permissions for forms and filters. */
const getMeta = () => ({
  weightUnits: UNITS,
  measurementMethods: METHODS,
  deleteModes: Object.values(WeightDeleteModes),
  permissions: WeightRecordPermissions,
  unitFactors: { kgPerLb: 0.453592, lbPerKg: 1 / 0.453592 },
  limits: {
    maxWeightKg: MAX_WEIGHT_KG,
    maxWeightLb: round(MAX_WEIGHT_LB, 2),
    maxBackdateDays: MAX_BACKDATE_DAYS,
    maxTextLength: MAX_TEXT_LENGTH,
    maxSummaryDays: MAX_SUMMARY_DAYS,
    maxStaleDays: MAX_STALE_DAYS,
  },
  defaults: { weightUnit: WeightUnits.KG, staleDays: DEFAULT_STALE_DAYS },
  abnormalChangePercent: ABNORMAL_CHANGE_PERCENT,
  totalsUnit: "kg",
});

/**
 * GET /recorders — active members who can be picked as measuredBy. Only name, code
 * and farm role are returned (no phone / NID / salary), so every member may call it.
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

/** GET /:id/audit-logs — Owner / Manager: who created, corrected or voided it. */
const getAuditLogs = async (farmId: string, id: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, WeightRecordPermissions.AUDIT, "view weight record history");
  const value = String(id ?? "").trim();
  if (!isValidObjectId(value)) throw new AppError(status.BAD_REQUEST, "Invalid weight record id!");
  //hard-deleted records keep their audit trail, so the record itself is not required
  const { page, limit, skip } = parsePaging(query, MAX_LIST_LIMIT);
  const filter = {
    entityType: AuditEntityTypes.WEIGHT_RECORD,
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

export const WeightRecordServices = {
  checkWeightEntry,
  createWeightRecord,
  updateWeightRecord,
  deleteWeightRecord,
  getFarmWeightRecords,
  getAnimalWeightRecords,
  getGrowthSummary,
  getWeightRecord,
  getMeta,
  getRecorders,
  getAuditLogs,
};
