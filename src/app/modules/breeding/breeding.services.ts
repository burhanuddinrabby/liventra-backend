import status from "http-status";
import mongoose, { isValidObjectId, Types } from "mongoose";
import type { ClientSession } from "mongoose";
import { NotificationProducers } from "../notification/notification.producers.js";
import AppError from "../../errors/AppError.js";
import { AnimalModel } from "../animal/animal.model.js";
import {
  AnimalGenders,
  AnimalHealthStatuses,
  AnimalLifeStatuses,
  AnimalReproductiveStatuses,
} from "../animal/animal.constants.js";
import { AuditLogModel } from "../auditLog/auditLog.model.js";
import { AuditActions, AuditEntityTypes, AuditModules } from "../auditLog/auditLog.constants.js";
import type { TAuditAction } from "../auditLog/auditLog.interface.js";
import { recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext } from "../auditLog/auditLog.utils.js";
import { FarmModel } from "../farm/farm.model.js";
import { FarmStatuses } from "../farm/farm.constants.js";
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
  CATTLE_GESTATION_DAYS,
  MAX_GESTATION_DAYS,
  MIN_GESTATION_DAYS,
  PregnancyStatuses,
} from "../pregnancy/pregnancy.constants.js";
import type { TPregnancy } from "../pregnancy/pregnancy.interface.js";
import { generatePregnancyNo, PregnancyModel } from "../pregnancy/pregnancy.model.js";
import { addDays, DAY_MS, dayKey, daysBetween, startOfTodayUtc } from "../treatment/treatment.utils.js";
import {
  BLOCKED_REPRODUCTIVE_STATUSES,
  BREEDING_NO_PATTERN,
  BreedingMethods,
  BreedingPermissions,
  CAUTION_REPRODUCTIVE_STATUSES,
  DEFAULT_CHECK_WINDOW_DAYS,
  DEFAULT_PREGNANCY_CHECK_DAYS,
  DUPLICATE_WINDOW_DAYS,
  ELIGIBLE_REPRODUCTIVE_STATUSES,
  FUTURE_TOLERANCE_HOURS,
  MAX_ANIMAL_HISTORY,
  MAX_BACKDATE_DAYS,
  MAX_CHECK_WINDOW_DAYS,
  MAX_HEAT_TO_SERVICE_DAYS,
  MAX_LIST_LIMIT,
  MAX_PREGNANCY_CHECK_DAYS,
  MAX_SHORT_TEXT,
  MAX_TEXT_LENGTH,
  MIN_BREEDING_AGE_MONTHS,
  MIN_BULL_AGE_MONTHS,
  MIN_CONFIRM_DAYS,
  MIN_PREGNANCY_CHECK_DAYS,
  PregnancyResults,
  RESULT_TRANSITIONS,
  SERVER_MANAGED_FIELDS,
} from "./breeding.constants.js";
import type { TBreeding, TBreedingMethod, TPregnancyResult } from "./breeding.interface.js";
import { BreedingModel, generateBreedingNo } from "./breeding.model.js";

const METHODS = Object.values(BreedingMethods) as string[];
const RESULTS = Object.values(PregnancyResults) as string[];
const round2 = (value: number) => Math.round(value * 100) / 100;
const sessionOpts = (session: ClientSession | null) => (session ? { session } : {});
const percent = (part: number, whole: number) => (whole > 0 ? round2((part / whole) * 100) : null);

type TBreedingDoc = TBreeding & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };
type TPregnancyDoc = TPregnancy & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

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

const requireRole = (access: TAccess, allowed: readonly string[], action: string) => {
  if (!allowed.includes(access.role)) {
    throw new AppError(status.FORBIDDEN, `Your farm role (${access.role}) is not allowed to ${action}!`);
  }
};

/** Setup / Suspended / Inactive farms cannot write breeding records (history stays readable). */
const requireWritableFarm = (access: TAccess) => {
  if (access.farmStatus !== FarmStatuses.ACTIVE) {
    throw new AppError(
      status.FORBIDDEN,
      `This farm is ${access.farmStatus} — breeding records can only be written on an Active farm!`,
    );
  }
};

//createdBy is signed by a FarmMember row
const requireMemberRow = (access: TAccess): Types.ObjectId => {
  if (!access.memberObjectId) {
    throw new AppError(status.FORBIDDEN, "An active farm membership is required to write breeding records!");
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
  const text = value.trim().replace(/[ \t]+/g, " ");
  if (text.length > max) throw new AppError(status.BAD_REQUEST, `${field} cannot exceed ${max} characters!`);
  return text;
};

const requireReason = (field: string, value: unknown, action: string): string => {
  const text = parseText(field, value);
  if (!text || text.length < 3) {
    throw new AppError(status.BAD_REQUEST, `${field} is required to ${action} (at least 3 characters)!`);
  }
  return text;
};

const parseTechnician = (value: unknown): string => {
  const name = parseText("technicianName", value, MAX_SHORT_TEXT);
  if (!name || name.length < 2) {
    throw new AppError(status.BAD_REQUEST, "technicianName is required — who performed / handled the breeding?");
  }
  return name;
};

//semen batch numbers are compared case-insensitively, so they are stored upper-case
const parseSemenBatch = (value: unknown): string | null => {
  const text = parseText("semenBatchNo", value, MAX_SHORT_TEXT);
  return text ? text.toUpperCase() : null;
};

const FUTURE_MS = FUTURE_TOLERANCE_HOURS * 60 * 60 * 1000;

/** A historical event day: not in the future, not older than MAX_BACKDATE_DAYS, not before birth. */
const parseEventDate = (field: string, value: unknown, birthDate?: Date | null): Date => {
  const date = parseCalendarDate(field, value);
  const now = Date.now();
  if (date.getTime() > now + FUTURE_MS) {
    throw new AppError(status.BAD_REQUEST, `${field} cannot be in the future — log the breeding after it happened.`);
  }
  if (date.getTime() < now - MAX_BACKDATE_DAYS * DAY_MS) {
    throw new AppError(status.BAD_REQUEST, `${field} cannot be more than ${MAX_BACKDATE_DAYS} days in the past!`);
  }
  if (birthDate && date.getTime() < new Date(dayKey(birthDate)).getTime()) {
    throw new AppError(status.BAD_REQUEST, `${field} cannot be before the animal's birth date!`);
  }
  return date;
};

type TDates = { heatDetectedDate: Date; inseminationDate: Date | null; expectedPregnancyCheckDate: Date };

/**
 * Date chain (spec §16/§84): heatDetectedDate ≤ inseminationDate ≤ expectedPregnancyCheckDate.
 * Heat and service are historical (never future); service is at most
 * MAX_HEAT_TO_SERVICE_DAYS after heat; the check is MIN..MAX_PREGNANCY_CHECK_DAYS after
 * the service (or heat) day and defaults to +DEFAULT_PREGNANCY_CHECK_DAYS.
 */
const validateDates = (
  input: { heat: Date; insemination: Date | null; check: Date | null },
  options: { checkWasSent: boolean },
): TDates => {
  const { heat, insemination } = input;
  if (insemination) {
    if (insemination < heat) {
      throw new AppError(status.BAD_REQUEST, "inseminationDate cannot be before heatDetectedDate!");
    }
    if (daysBetween(heat, insemination) > MAX_HEAT_TO_SERVICE_DAYS) {
      throw new AppError(
        status.BAD_REQUEST,
        `inseminationDate is ${daysBetween(heat, insemination)} days after heat — service must be within ${MAX_HEAT_TO_SERVICE_DAYS} days of the detected heat (log a new heat instead).`,
      );
    }
  }
  const base = insemination ?? heat;
  const check = input.check ?? addDays(base, DEFAULT_PREGNANCY_CHECK_DAYS);
  if (options.checkWasSent || input.check) {
    if (check < base) {
      throw new AppError(status.BAD_REQUEST, "expectedPregnancyCheckDate cannot be before the insemination / heat date!");
    }
    const gap = daysBetween(base, check);
    if (gap < MIN_PREGNANCY_CHECK_DAYS || gap > MAX_PREGNANCY_CHECK_DAYS) {
      throw new AppError(
        status.BAD_REQUEST,
        `expectedPregnancyCheckDate must be ${MIN_PREGNANCY_CHECK_DAYS}–${MAX_PREGNANCY_CHECK_DAYS} days after the service date (it is ${gap}).`,
      );
    }
  }
  return { heatDetectedDate: heat, inseminationDate: insemination, expectedPregnancyCheckDate: check };
};

const ageInMonths = (birthDate: Date | null | undefined, at: Date = new Date()) => {
  if (!birthDate) return null;
  const b = new Date(birthDate);
  return (at.getUTCFullYear() - b.getUTCFullYear()) * 12 + (at.getUTCMonth() - b.getUTCMonth()) - (at.getUTCDate() < b.getUTCDate() ? 1 : 0);
};

/* -------------------------------------------------------------------------- */
/*                               Reference lookups                            */
/* -------------------------------------------------------------------------- */

type TAnimalRef = {
  _id: Types.ObjectId;
  animalCode: string;
  name?: string;
  gender: string;
  lifeStatus: string;
  healthStatus: string;
  reproductiveStatus: string;
  birthDate?: Date | null;
  purpose?: string;
  isActive?: boolean;
};

const ANIMAL_FIELDS = "animalCode name gender lifeStatus healthStatus reproductiveStatus birthDate purpose isActive";

//animal reference: Mongo _id or the farm's animalCode (AN-000001), always farm-scoped
const findAnimal = async (access: TAccess, ref: unknown, field = "animalId"): Promise<TAnimalRef> => {
  const value = String(ref ?? "").trim();
  if (!value) throw new AppError(status.BAD_REQUEST, `${field} is required!`);
  const animal = await AnimalModel.findOne(
    isValidObjectId(value)
      ? { _id: new Types.ObjectId(value), farmId: access.farmObjectId }
      : { animalCode: value.toUpperCase(), farmId: access.farmObjectId },
  )
    .select(ANIMAL_FIELDS)
    .lean();
  //an animal of another farm is reported as missing (farm isolation, spec §10 / §124)
  if (!animal) {
    throw new AppError(status.NOT_FOUND, field === "bullId" ? "Bull not found in this farm!" : "Animal not found in this farm!");
  }
  return animal as unknown as TAnimalRef;
};

/**
 * bullId (spec §26/§68/§123–124): an existing MALE Animal of the same farm.
 * Natural Mating needs a physically present (Active) bull; for AI / ET the bull is the
 * genetic sire and may already be sold / dead.
 */
const resolveBull = async (
  access: TAccess,
  ref: unknown,
  method: string,
  femaleId: Types.ObjectId,
  warnings: string[],
): Promise<TAnimalRef | null> => {
  if (isBlank(ref)) {
    if (method === BreedingMethods.NATURAL_MATING) {
      throw new AppError(status.BAD_REQUEST, "Natural Mating requires bullId — the bull of this farm that served the animal.");
    }
    return null;
  }
  const bull = await findAnimal(access, ref, "bullId");
  if (String(bull._id) === String(femaleId)) throw new AppError(status.BAD_REQUEST, "bullId cannot be the animal being bred!");
  if (bull.gender !== AnimalGenders.MALE) {
    throw new AppError(status.BAD_REQUEST, `${bull.animalCode} is ${bull.gender} — bullId must be a Male animal.`);
  }
  if (method === BreedingMethods.NATURAL_MATING && bull.lifeStatus !== AnimalLifeStatuses.ACTIVE) {
    throw new AppError(status.CONFLICT, `${bull.animalCode} is ${bull.lifeStatus} — Natural Mating needs an Active bull of this farm.`);
  }
  const age = ageInMonths(bull.birthDate);
  if (method === BreedingMethods.NATURAL_MATING && age !== null && age < MIN_BULL_AGE_MONTHS) {
    warnings.push(`${bull.animalCode} is only ${age} months old — check that the bull is sexually mature.`);
  }
  return bull;
};

/**
 * Method rules (spec §21–24, §125–126):
 *  - Artificial Insemination: semenBatchNo required (traceability); bullId optional sire
 *  - Natural Mating: bullId required; semenBatchNo is not applicable
 *  - Embryo Transfer: bull / semen optional; embryo details go in remarks
 */
const applyMethodRules = (method: string, semenBatchNo: string | null, options: { semenWasSent: boolean }) => {
  if (method === BreedingMethods.ARTIFICIAL_INSEMINATION && !semenBatchNo) {
    throw new AppError(status.BAD_REQUEST, "Artificial Insemination requires semenBatchNo for semen traceability!");
  }
  if (method === BreedingMethods.NATURAL_MATING && semenBatchNo) {
    if (options.semenWasSent) {
      throw new AppError(status.BAD_REQUEST, "semenBatchNo is not applicable to Natural Mating — remove it.");
    }
    return null;
  }
  return semenBatchNo;
};

/* -------------------------------------------------------------------------- */
/*                         Eligibility / latest event                         */
/* -------------------------------------------------------------------------- */

const activePregnancyFor = (access: TAccess, animalId: Types.ObjectId, session: ClientSession | null = null) =>
  PregnancyModel.findOne({
    farmId: access.farmObjectId,
    animalId,
    pregnancyStatus: PregnancyStatuses.PREGNANT,
  })
    .select("pregnancyNo breedingId conceptionDate expectedCalvingDate pregnancyStatus")
    .session(session)
    .lean();

type TEligibility = {
  eligible: boolean;
  blockers: string[];
  warnings: string[];
  ageMonths: number | null;
  activePregnancy: unknown;
  pendingBreedings: { _id: Types.ObjectId; breedingNo: string; heatDetectedDate: Date; inseminationDate?: Date | null; expectedPregnancyCheckDate: Date }[];
  lastBreeding: unknown;
};

/**
 * Animal eligibility (spec §12–13, §54–58): Female, Active, old enough, not Calf /
 * Pregnant, no active Pregnancy record. Health and Dry are warnings (farm policy).
 */
const checkEligibility = async (access: TAccess, animal: TAnimalRef, excludeId: Types.ObjectId | null = null): Promise<TEligibility> => {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (animal.gender !== AnimalGenders.FEMALE) {
    blockers.push(`${animal.animalCode} is ${animal.gender} — breeding records are only for female animals.`);
  }
  if (animal.lifeStatus !== AnimalLifeStatuses.ACTIVE) {
    blockers.push(`${animal.animalCode} is ${animal.lifeStatus} — only Active animals can be bred.`);
  }
  if (BLOCKED_REPRODUCTIVE_STATUSES.includes(animal.reproductiveStatus)) {
    blockers.push(
      animal.reproductiveStatus === AnimalReproductiveStatuses.PREGNANT
        ? `${animal.animalCode} is already Pregnant — a new breeding cannot be logged.`
        : `${animal.animalCode} is a ${animal.reproductiveStatus} — not yet eligible for breeding.`,
    );
  } else if (CAUTION_REPRODUCTIVE_STATUSES.includes(animal.reproductiveStatus)) {
    warnings.push(`${animal.animalCode} is Dry — dry cows are normally in late pregnancy. Confirm the reproductive status is correct.`);
  } else if (!ELIGIBLE_REPRODUCTIVE_STATUSES.includes(animal.reproductiveStatus)) {
    warnings.push(`Unusual reproductive status "${animal.reproductiveStatus}".`);
  }
  const ageMonths = ageInMonths(animal.birthDate);
  if (ageMonths !== null && ageMonths < MIN_BREEDING_AGE_MONTHS) {
    blockers.push(`${animal.animalCode} is ${ageMonths} months old — the minimum breeding age is ${MIN_BREEDING_AGE_MONTHS} months.`);
  }
  if (animal.healthStatus && animal.healthStatus !== AnimalHealthStatuses.HEALTHY) {
    warnings.push(`${animal.animalCode} is currently ${animal.healthStatus} — check with the veterinarian before breeding.`);
  }

  const [activePregnancy, pending, last] = await Promise.all([
    activePregnancyFor(access, animal._id),
    BreedingModel.find({
      farmId: access.farmObjectId,
      animalId: animal._id,
      pregnancyResult: PregnancyResults.PENDING,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    })
      .sort({ heatDetectedDate: -1 })
      .select("breedingNo heatDetectedDate inseminationDate expectedPregnancyCheckDate")
      .lean(),
    BreedingModel.findOne({ farmId: access.farmObjectId, animalId: animal._id, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })
      .sort({ heatDetectedDate: -1, createdAt: -1 })
      .select("breedingNo heatDetectedDate inseminationDate breedingMethod pregnancyResult")
      .lean(),
  ]);
  if (activePregnancy) {
    blockers.push(`${animal.animalCode} has an active pregnancy (${activePregnancy.pregnancyNo}) — record its outcome before breeding again.`);
  }
  if (pending.length) {
    warnings.push(
      `${pending.map((p) => p.breedingNo).join(", ")} ${pending.length > 1 ? "are" : "is"} still awaiting a pregnancy check — record ${pending.length > 1 ? "their results" : "its result"} (e.g. Failed if she returned to heat).`,
    );
  }
  return {
    eligible: blockers.length === 0,
    blockers,
    warnings,
    ageMonths,
    activePregnancy,
    pendingBreedings: pending as unknown as TEligibility["pendingBreedings"],
    lastBreeding: last,
  };
};

/**
 * "Latest valid reproductive event" (spec §43–44): the animal's most recent breeding by
 * heat date (then creation). Older records never overwrite Animal.reproductiveStatus.
 */
const isLatestBreeding = async (access: TAccess, doc: TBreedingDoc, session: ClientSession | null = null) => {
  const newer = await BreedingModel.exists({
    farmId: access.farmObjectId,
    animalId: doc.animalId,
    _id: { $ne: doc._id },
    $or: [
      { heatDetectedDate: { $gt: doc.heatDetectedDate } },
      { heatDetectedDate: doc.heatDetectedDate, createdAt: { $gt: doc.createdAt } },
    ],
  }).session(session);
  return !newer;
};

type TReproChange = { from: string; to: string } | null;

/**
 * Keeps Animal.reproductiveStatus consistent with the result (spec §43–44, §88–89):
 *  - Confirmed → Pregnant (only when this is the animal's latest breeding)
 *  - Failed    → Open, only if the animal is still marked Pregnant without any other
 *                active Pregnancy (a Confirmed → Failed correction); Heifer / Open /
 *                Lactating / Dry are already non-pregnant states and are kept
 */
const syncAnimalReproductive = async (
  access: TAccess,
  doc: TBreedingDoc,
  outcome: TPregnancyResult,
  session: ClientSession | null,
  undo: TUndo,
  notes: string[],
): Promise<TReproChange> => {
  const animal = await AnimalModel.findOne({ _id: doc.animalId, farmId: access.farmObjectId })
    .select("reproductiveStatus animalCode")
    .session(session)
    .lean();
  if (!animal) return null;
  const current = animal.reproductiveStatus as string;
  const latest = await isLatestBreeding(access, doc, session);

  let target = current;
  if (outcome === PregnancyResults.CONFIRMED) {
    if (!latest) {
      notes.push(`${animal.animalCode} has a newer breeding record, so her reproductive status (${current}) was not changed.`);
      return null;
    }
    target = AnimalReproductiveStatuses.PREGNANT;
  } else if (outcome === PregnancyResults.FAILED) {
    if (current !== AnimalReproductiveStatuses.PREGNANT) return null;
    const other = await activePregnancyFor(access, doc.animalId, session);
    if (other) {
      notes.push(`${animal.animalCode} still has active pregnancy ${other.pregnancyNo}, so she stays Pregnant.`);
      return null;
    }
    if (!latest) {
      notes.push(`${animal.animalCode} has a newer breeding record, so her reproductive status was not changed.`);
      return null;
    }
    target = AnimalReproductiveStatuses.OPEN;
  }
  if (target === current) return null;

  await AnimalModel.updateOne({ _id: doc.animalId }, { $set: { reproductiveStatus: target } }, sessionOpts(session));
  undo.push(() => AnimalModel.updateOne({ _id: doc.animalId }, { $set: { reproductiveStatus: current } }));
  return { from: current, to: target };
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
        ? "animalCode name gender lifeStatus healthStatus reproductiveStatus birthDate profilePhoto purpose breedId"
        : "animalCode name reproductiveStatus lifeStatus",
    )
    .populate("bullId", detail ? "animalCode name gender lifeStatus birthDate profilePhoto breedId" : "animalCode name")
    .populate({ path: "createdBy", ...MEMBER_POPULATE }) as unknown as T;
};

//record reference: Mongo _id or BRD-YYYY-NNNNNN, always farm-scoped
const findRecord = async (access: TAccess, ref: string): Promise<TBreedingDoc> => {
  const value = String(ref ?? "").trim();
  let filter: Record<string, unknown>;
  if (isValidObjectId(value)) filter = { _id: new Types.ObjectId(value) };
  else if (BREEDING_NO_PATTERN.test(value)) filter = { breedingNo: value.toUpperCase() };
  else throw new AppError(status.BAD_REQUEST, "Use a breeding id or a BRD-YYYY-NNNNNN number!");
  const doc = await BreedingModel.findOne({ ...filter, farmId: access.farmObjectId }).lean();
  if (!doc) throw new AppError(status.NOT_FOUND, "Breeding record not found in this farm!");
  return doc as unknown as TBreedingDoc;
};

/** Derived scheduling flags (never stored — Pending is never auto-changed, spec §87). */
const derive = (record: {
  pregnancyResult: string;
  heatDetectedDate: Date;
  inseminationDate?: Date | null;
  expectedPregnancyCheckDate: Date;
}) => {
  const today = startOfTodayUtc();
  const serviceDate = record.inseminationDate ?? null;
  const pending = record.pregnancyResult === PregnancyResults.PENDING;
  const checkDueInDays = daysBetween(today, new Date(record.expectedPregnancyCheckDate));
  let checkState: "Overdue" | "Today" | "Upcoming" | null = null;
  if (pending) checkState = checkDueInDays < 0 ? "Overdue" : checkDueInDays === 0 ? "Today" : "Upcoming";
  return {
    //heat logged but the service (insemination / mating / transfer) date is not recorded yet
    isHeatOnly: !serviceDate,
    daysSinceService: serviceDate ? daysBetween(new Date(serviceDate), today) : null,
    checkDueInDays: pending ? checkDueInDays : null,
    checkState,
    isCheckOverdue: checkState === "Overdue",
    //earliest day a confirmation is accepted (service + MIN_CONFIRM_DAYS)
    earliestConfirmDate: serviceDate ? addDays(new Date(serviceDate), MIN_CONFIRM_DAYS) : null,
  };
};

const loadDetail = async (access: TAccess, id: Types.ObjectId) => {
  const record = await populateRecord(BreedingModel.findById(id).select("-__v"), true).lean();
  if (!record) throw new AppError(status.NOT_FOUND, "Breeding record not found!");
  const r = record as unknown as TBreedingDoc & { animalId: { _id: Types.ObjectId } | Types.ObjectId };
  const animalObjectId = (r.animalId as { _id?: Types.ObjectId })._id ?? (r.animalId as Types.ObjectId);
  const plain = { ...r, animalId: animalObjectId } as unknown as TBreedingDoc;
  const [pregnancy, attemptNumber, latest] = await Promise.all([
    PregnancyModel.findOne({ breedingId: id, farmId: access.farmObjectId })
      .select("-__v")
      .populate({ path: "createdBy", ...MEMBER_POPULATE })
      .lean(),
    BreedingModel.countDocuments({
      farmId: access.farmObjectId,
      animalId: animalObjectId,
      $or: [
        { heatDetectedDate: { $lt: r.heatDetectedDate } },
        { heatDetectedDate: r.heatDetectedDate, createdAt: { $lte: r.createdAt } },
      ],
    }),
    isLatestBreeding(access, plain),
  ]);
  return {
    ...(record as Record<string, unknown>),
    ...derive(r),
    //1-based position in the animal's breeding history
    attemptNumber,
    isLatestForAnimal: latest,
    pregnancy: pregnancy ?? null,
    hasPregnancy: !!pregnancy,
  };
};

const auditSnapshot = (record: Partial<TBreeding>) => ({
  breedingNo: record.breedingNo,
  animalId: record.animalId,
  heatDetectedDate: record.heatDetectedDate,
  inseminationDate: record.inseminationDate ?? null,
  breedingMethod: record.breedingMethod,
  bullId: record.bullId ?? null,
  semenBatchNo: record.semenBatchNo ?? null,
  technicianName: record.technicianName,
  expectedPregnancyCheckDate: record.expectedPregnancyCheckDate,
  pregnancyResult: record.pregnancyResult,
  remarks: record.remarks ?? null,
});

const audit = (
  context: TAuditContext,
  farmId: Types.ObjectId,
  entityType: "Breeding" | "Pregnancy",
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
    entityType: entityType === "Breeding" ? AuditEntityTypes.BREEDING : AuditEntityTypes.PREGNANCY,
    entityId,
    action,
    module: AuditModules.ANIMAL,
    event,
    oldData,
    newData,
    changedFields,
  });

//keeps a short outcome trail in remarks without exceeding the field limit
const appendRemark = (existing: string | undefined, tag: string, note: string | undefined) => {
  if (!note) return existing;
  const entry = `[${tag}] ${note}`;
  const combined = existing ? `${existing}\n${entry}` : entry;
  return combined.length > MAX_TEXT_LENGTH ? entry.slice(0, MAX_TEXT_LENGTH) : combined;
};

/**
 * Possible accidental duplicate (spec §61): same animal with a heat or service date
 * within ±DUPLICATE_WINDOW_DAYS. Repeated attempts are legitimate, so this only blocks
 * until the caller confirms with confirmDuplicate.
 */
const findPossibleDuplicate = (
  access: TAccess,
  animalId: Types.ObjectId,
  dates: { heatDetectedDate: Date; inseminationDate: Date | null },
  excludeId: Types.ObjectId | null = null,
) => {
  const near = (d: Date) => ({ $gte: addDays(d, -DUPLICATE_WINDOW_DAYS), $lte: addDays(d, DUPLICATE_WINDOW_DAYS) });
  const or: Record<string, unknown>[] = [{ heatDetectedDate: near(dates.heatDetectedDate) }];
  if (dates.inseminationDate) or.push({ inseminationDate: near(dates.inseminationDate) });
  return BreedingModel.findOne({
    farmId: access.farmObjectId,
    animalId,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    $or: or,
  })
    .select("breedingNo heatDetectedDate inseminationDate breedingMethod pregnancyResult semenBatchNo")
    .lean();
};

/* -------------------------------------------------------------------------- */
/*                                   Create                                   */
/* -------------------------------------------------------------------------- */

/**
 * POST / — logs a breeding event (spec §50). Validates the farm, the female (Active,
 * Female, old enough, not Calf / Pregnant, no active Pregnancy), the method rules
 * (AI → semen batch; Natural Mating → Active male bull of this farm, no semen batch),
 * the date chain, then generates BRD-YYYY-NNNNNN and saves pregnancyResult "Pending".
 * Animal.reproductiveStatus is not changed here: the schema has no "Inseminated"
 * state, and the animal stays non-pregnant until the check confirms it.
 */
const createBreeding = async (farmId: string, requesterUserId: string, payload: TPayload, context: TAuditContext) => {
  const body = payload ?? {};
  rejectServerFields(body);
  if ("pregnancyResult" in body) {
    throw new AppError(status.BAD_REQUEST, "A new breeding always starts as Pending — record the result with PATCH /:id/pregnancy-result.");
  }
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, BreedingPermissions.CREATE, "log breeding events");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);

  const animal = await findAnimal(access, body.animalId);
  const eligibility = await checkEligibility(access, animal);
  if (!eligibility.eligible) throw new AppError(status.CONFLICT, eligibility.blockers.join(" "));
  const warnings = [...eligibility.warnings];

  const method = String(body.breedingMethod ?? "");
  if (!METHODS.includes(method)) throw new AppError(status.BAD_REQUEST, `breedingMethod must be one of: ${METHODS.join(", ")}!`);

  const heat = parseEventDate("heatDetectedDate", body.heatDetectedDate, animal.birthDate);
  const insemination = isBlank(body.inseminationDate)
    ? null
    : parseEventDate("inseminationDate", body.inseminationDate, animal.birthDate);
  const check = isBlank(body.expectedPregnancyCheckDate)
    ? null
    : parseCalendarDate("expectedPregnancyCheckDate", body.expectedPregnancyCheckDate);
  const dates = validateDates({ heat, insemination, check }, { checkWasSent: !!check });
  if (!insemination) warnings.push("No service date recorded yet — add the insemination / mating date once it is done.");

  const bull = await resolveBull(access, body.bullId, method, animal._id, warnings);
  const semenBatchNo = applyMethodRules(method, parseSemenBatch(body.semenBatchNo), { semenWasSent: !isBlank(body.semenBatchNo) });
  const technicianName = parseTechnician(body.technicianName);
  const remarks = parseText("remarks", body.remarks);
  if (method === BreedingMethods.EMBRYO_TRANSFER && !remarks) {
    warnings.push("Embryo Transfer: record the embryo / donor details in remarks (the schema has no embryo fields).");
  }

  const duplicate = await findPossibleDuplicate(access, animal._id, dates);
  if (duplicate && body.confirmDuplicate !== true) {
    throw new AppError(
      status.CONFLICT,
      `Possible duplicate: ${animal.animalCode} already has ${duplicate.breedingNo} (${duplicate.breedingMethod}, heat ${dayKey(duplicate.heatDetectedDate)}, ${duplicate.pregnancyResult}). Send confirmDuplicate: true if this is a separate attempt.`,
    );
  }
  if (duplicate) warnings.push(`Saved alongside ${duplicate.breedingNo} — confirmed as a separate attempt.`);

  const breedingNo = await generateBreedingNo();
  const data: TBreeding = {
    breedingNo,
    farmId: access.farmObjectId,
    animalId: animal._id,
    heatDetectedDate: dates.heatDetectedDate,
    inseminationDate: dates.inseminationDate,
    breedingMethod: method as TBreedingMethod,
    bullId: bull?._id ?? null,
    semenBatchNo,
    technicianName,
    expectedPregnancyCheckDate: dates.expectedPregnancyCheckDate,
    pregnancyResult: PregnancyResults.PENDING,
    ...(remarks ? { remarks } : {}),
    createdBy: memberId,
  };
  const record = await BreedingModel.create(data);

  await audit(context, access.farmObjectId, "Breeding", record._id, AuditActions.CREATE, "Breeding Created", null, auditSnapshot(data));
  await NotificationProducers.breedingChanged(access.farmObjectId, data.animalId);

  const today = startOfTodayUtc();
  return {
    breeding: await loadDetail(access, record._id),
    //also surfaced on /pregnancy-checks; the reminder itself is a notification
    pregnancyCheckReminder: {
      expectedPregnancyCheckDate: dates.expectedPregnancyCheckDate,
      dueInDays: daysBetween(today, dates.expectedPregnancyCheckDate),
    },
    warnings,
  };
};

/* -------------------------------------------------------------------------- */
/*                         Pregnancy-check result                             */
/* -------------------------------------------------------------------------- */

/**
 * PATCH /:id/pregnancy-result — records the check outcome (spec §51, §85–90, §114–116).
 *
 * Confirmed (one atomic unit): service date must be recorded and ≥ MIN_CONFIRM_DAYS ago;
 * before expectedPregnancyCheckDate it needs `earlyCheck: true` (externally verified);
 * no other active Pregnancy for the animal; then Breeding → Confirmed, a Pregnancy is
 * created (or the one closed by an earlier correction is re-opened — never a second one),
 * Animal → Pregnant when this is her latest breeding, AuditLog for both records.
 *
 * Failed: the attempt is kept (never deleted); no Pregnancy; the animal goes back to Open
 * only if she was marked Pregnant by this breeding and nothing newer overrides it.
 *
 * Corrections (reason required): Failed → Confirmed | Pending, Confirmed → Failed (the
 * linked Pregnancy must still be "Pregnant"; it is closed as Failed in the same unit).
 */
const recordPregnancyResult = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, BreedingPermissions.RECORD_RESULT, "record pregnancy-check results");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);

  const target = String(body.pregnancyResult ?? "");
  if (!RESULTS.includes(target)) throw new AppError(status.BAD_REQUEST, `pregnancyResult must be one of: ${RESULTS.join(", ")}!`);
  const doc = await findRecord(access, id);
  if (doc.pregnancyResult === target) throw new AppError(status.CONFLICT, `This breeding is already ${target}!`);
  const allowed = RESULT_TRANSITIONS[doc.pregnancyResult] ?? [];
  if (!allowed.includes(target)) {
    throw new AppError(status.CONFLICT, `A ${doc.pregnancyResult} breeding cannot be changed to ${target}.`);
  }
  const isCorrection = doc.pregnancyResult !== PregnancyResults.PENDING;
  const reason = isCorrection
    ? requireReason("reason", body.reason, `correct a ${doc.pregnancyResult} result`)
    : parseText("reason", body.reason);
  const note = parseText("remarks", body.remarks);
  if (target !== PregnancyResults.CONFIRMED && (!isBlank(body.conceptionDate) || !isBlank(body.expectedCalvingDate))) {
    throw new AppError(status.BAD_REQUEST, "conceptionDate / expectedCalvingDate only apply when confirming a pregnancy.");
  }

  const today = startOfTodayUtc();
  const service = doc.inseminationDate ? new Date(doc.inseminationDate) : null;
  //the day the examination was done (defaults to today; kept in remarks + audit)
  let checkDate = today;
  if (!isBlank(body.checkDate)) {
    checkDate = parseCalendarDate("checkDate", body.checkDate);
    if (checkDate.getTime() > Date.now() + FUTURE_TOLERANCE_HOURS * 3_600_000) {
      throw new AppError(status.BAD_REQUEST, "checkDate cannot be in the future!");
    }
    if (checkDate < new Date(doc.heatDetectedDate)) throw new AppError(status.BAD_REQUEST, "checkDate cannot be before the heat date!");
  }

  const warnings: string[] = [];
  const notes: string[] = [];
  const animal = await findAnimal(access, String(doc.animalId));
  const existingPregnancy = (await PregnancyModel.findOne({ breedingId: doc._id }).lean()) as TPregnancyDoc | null;

  let conceptionDate: Date | null = null;
  let expectedCalvingDate: Date | null = null;

  if (target === PregnancyResults.CONFIRMED) {
    if (!service) {
      throw new AppError(status.CONFLICT, "Record the insemination / mating date (PUT /:id) before confirming a pregnancy.");
    }
    if (checkDate < service) throw new AppError(status.BAD_REQUEST, "checkDate cannot be before the insemination date!");
    const sinceService = daysBetween(service, checkDate);
    if (sinceService < MIN_CONFIRM_DAYS) {
      throw new AppError(
        status.CONFLICT,
        `Only ${sinceService} days since service — a pregnancy cannot be confirmed before day ${MIN_CONFIRM_DAYS} (earliest ${dayKey(addDays(service, MIN_CONFIRM_DAYS))}).`,
      );
    }
    if (checkDate < new Date(doc.expectedPregnancyCheckDate) && body.earlyCheck !== true) {
      throw new AppError(
        status.CONFLICT,
        `The pregnancy check is scheduled for ${dayKey(doc.expectedPregnancyCheckDate)}. Send earlyCheck: true if a veterinarian has already verified the pregnancy.`,
      );
    }
    if (animal.lifeStatus !== AnimalLifeStatuses.ACTIVE) {
      warnings.push(`${animal.animalCode} is ${animal.lifeStatus} — the pregnancy is recorded for history only.`);
    }
    const other = await activePregnancyFor(access, doc.animalId);
    if (other && String(other.breedingId) !== String(doc._id)) {
      throw new AppError(
        status.CONFLICT,
        `${animal.animalCode} already has an active pregnancy (${other.pregnancyNo}) — a female cannot have two confirmed pregnancies at once.`,
      );
    }
    if (existingPregnancy && existingPregnancy.pregnancyStatus !== PregnancyStatuses.FAILED) {
      throw new AppError(
        status.CONFLICT,
        `Pregnancy ${existingPregnancy.pregnancyNo} already exists for this breeding (${existingPregnancy.pregnancyStatus}) — one breeding has at most one pregnancy.`,
      );
    }

    //conception: approved rule = the service day, overridable within heat .. service + 3 days
    conceptionDate = isBlank(body.conceptionDate) ? service : parseCalendarDate("conceptionDate", body.conceptionDate);
    if (conceptionDate < new Date(doc.heatDetectedDate) || conceptionDate > addDays(service, 3)) {
      throw new AppError(status.BAD_REQUEST, "conceptionDate must be between the heat date and 3 days after the insemination date!");
    }
    if (conceptionDate > checkDate) throw new AppError(status.BAD_REQUEST, "conceptionDate cannot be after the check date!");
    expectedCalvingDate = isBlank(body.expectedCalvingDate)
      ? addDays(conceptionDate, CATTLE_GESTATION_DAYS)
      : parseCalendarDate("expectedCalvingDate", body.expectedCalvingDate);
    const gestation = daysBetween(conceptionDate, expectedCalvingDate);
    if (gestation < MIN_GESTATION_DAYS || gestation > MAX_GESTATION_DAYS) {
      throw new AppError(
        status.BAD_REQUEST,
        `expectedCalvingDate must be ${MIN_GESTATION_DAYS}–${MAX_GESTATION_DAYS} days after conception (it is ${gestation}; cattle average ${CATTLE_GESTATION_DAYS}).`,
      );
    }
  } else if (target === PregnancyResults.FAILED) {
    if (service && checkDate < service) throw new AppError(status.BAD_REQUEST, "checkDate cannot be before the insemination date!");
    if (doc.pregnancyResult === PregnancyResults.CONFIRMED) {
      if (existingPregnancy && existingPregnancy.pregnancyStatus !== PregnancyStatuses.PREGNANT) {
        throw new AppError(
          status.CONFLICT,
          `Pregnancy ${existingPregnancy.pregnancyNo} is already ${existingPregnancy.pregnancyStatus} — the breeding result can no longer be corrected.`,
        );
      }
    }
    if (!service) warnings.push("No service date was recorded — the attempt is closed as Failed.");
  }

  //result trail in remarks (the schema has no actualPregnancyCheckDate, spec §103)
  const tag = isCorrection ? `Corrected ${doc.pregnancyResult} → ${target}` : `Check ${dayKey(checkDate)}: ${target}`;
  const trailNote = [note, reason && isCorrection ? `Reason: ${reason}` : undefined].filter(Boolean).join(" — ") || (isCorrection ? undefined : "recorded");
  const newRemarks = appendRemark(doc.remarks, tag, trailNote) ?? doc.remarks ?? "";

  const pregnancyNo = target === PregnancyResults.CONFIRMED && !existingPregnancy ? await generatePregnancyNo() : null;

  const result = await executeAtomically(async (session, undo) => {
    const updated = await BreedingModel.findOneAndUpdate(
      { _id: doc._id, pregnancyResult: doc.pregnancyResult, updatedAt: doc.updatedAt },
      { $set: { pregnancyResult: target, remarks: newRemarks } },
      { returnDocument: "after", ...sessionOpts(session) },
    );
    if (!updated) throw new AppError(status.CONFLICT, "This breeding record was changed by someone else. Reload and try again.");
    undo.push(() =>
      BreedingModel.updateOne({ _id: doc._id }, { $set: { pregnancyResult: doc.pregnancyResult, remarks: doc.remarks ?? "" } }),
    );

    let pregnancy: { _id: Types.ObjectId; pregnancyNo: string; action: "Created" | "Reopened" | "Closed" } | null = null;
    if (target === PregnancyResults.CONFIRMED) {
      if (existingPregnancy) {
        //re-open the episode closed by an earlier Confirmed → Failed correction (1:1 kept)
        const before = existingPregnancy;
        await PregnancyModel.updateOne(
          { _id: before._id },
          {
            $set: {
              pregnancyStatus: PregnancyStatuses.PREGNANT,
              conceptionDate,
              expectedCalvingDate,
              remarks: appendRemark(before.remarks, "Re-confirmed", reason ?? note) ?? before.remarks ?? "",
            },
          },
          sessionOpts(session),
        );
        undo.push(() =>
          PregnancyModel.updateOne(
            { _id: before._id },
            {
              $set: {
                pregnancyStatus: before.pregnancyStatus,
                conceptionDate: before.conceptionDate,
                expectedCalvingDate: before.expectedCalvingDate,
                remarks: before.remarks ?? "",
              },
            },
          ),
        );
        pregnancy = { _id: before._id, pregnancyNo: before.pregnancyNo, action: "Reopened" };
      } else {
        const [created] = await PregnancyModel.create(
          [
            {
              pregnancyNo: pregnancyNo as string,
              farmId: access.farmObjectId,
              animalId: doc.animalId,
              breedingId: doc._id,
              conceptionDate: conceptionDate as Date,
              expectedCalvingDate: expectedCalvingDate as Date,
              actualCalvingDate: null,
              calfCount: null,
              calfGender: null,
              pregnancyStatus: PregnancyStatuses.PREGNANT,
              remarks: `Confirmed from ${doc.breedingNo} (${doc.breedingMethod}).${note ? ` ${note}` : ""}`.slice(0, MAX_TEXT_LENGTH),
              createdBy: memberId,
            },
          ],
          sessionOpts(session),
        );
        if (!created) throw new AppError(status.INTERNAL_SERVER_ERROR, "Failed to create the pregnancy record!");
        undo.push(() => PregnancyModel.deleteOne({ _id: created._id }));
        pregnancy = { _id: created._id, pregnancyNo: created.pregnancyNo, action: "Created" };
      }
    } else if (target === PregnancyResults.FAILED && existingPregnancy?.pregnancyStatus === PregnancyStatuses.PREGNANT) {
      //Confirmed → Failed correction: close the linked pregnancy (kept for history, never deleted)
      const before = existingPregnancy;
      const closed = await PregnancyModel.findOneAndUpdate(
        { _id: before._id, pregnancyStatus: PregnancyStatuses.PREGNANT },
        {
          $set: {
            pregnancyStatus: PregnancyStatuses.FAILED,
            remarks: appendRemark(before.remarks, "Breeding result corrected to Failed", reason) ?? before.remarks ?? "",
          },
        },
        { returnDocument: "after", ...sessionOpts(session) },
      );
      if (!closed) throw new AppError(status.CONFLICT, "The linked pregnancy was changed by someone else. Reload and try again.");
      undo.push(() =>
        PregnancyModel.updateOne({ _id: before._id }, { $set: { pregnancyStatus: before.pregnancyStatus, remarks: before.remarks ?? "" } }),
      );
      pregnancy = { _id: before._id, pregnancyNo: before.pregnancyNo, action: "Closed" };
    }

    const change =
      target === PregnancyResults.PENDING
        ? null
        : await syncAnimalReproductive(access, doc, target as TPregnancyResult, session, undo, notes);
    return { pregnancy, reproductiveStatus: change };
  });

  const event = isCorrection ? "Pregnancy Result Corrected" : target === PregnancyResults.CONFIRMED ? "Pregnancy Confirmed" : "Breeding Failed";
  await audit(
    context,
    access.farmObjectId,
    "Breeding",
    doc._id,
    AuditActions.UPDATE,
    event,
    { pregnancyResult: doc.pregnancyResult, remarks: doc.remarks ?? null },
    {
      pregnancyResult: target,
      checkDate: dayKey(checkDate),
      ...(reason ? { reason } : {}),
      ...(note ? { note } : {}),
      ...(result.pregnancy ? { pregnancy: { pregnancyNo: result.pregnancy.pregnancyNo, action: result.pregnancy.action } } : {}),
      animalReproductiveStatus: result.reproductiveStatus,
    },
    ["pregnancyResult", "remarks", ...(result.pregnancy ? ["pregnancy"] : [])],
  );
  if (result.pregnancy) {
    const action = result.pregnancy.action;
    await audit(
      context,
      access.farmObjectId,
      "Pregnancy",
      result.pregnancy._id,
      action === "Created" ? AuditActions.CREATE : AuditActions.UPDATE,
      action === "Created" ? "Pregnancy Created" : action === "Reopened" ? "Pregnancy Re-confirmed" : "Pregnancy Closed by Correction",
      action === "Created" ? null : { pregnancyStatus: existingPregnancy?.pregnancyStatus ?? null },
      {
        pregnancyNo: result.pregnancy.pregnancyNo,
        breedingNo: doc.breedingNo,
        pregnancyStatus: action === "Closed" ? PregnancyStatuses.FAILED : PregnancyStatuses.PREGNANT,
        ...(conceptionDate ? { conceptionDate, expectedCalvingDate } : {}),
      },
      action === "Created" ? [] : ["pregnancyStatus"],
    );
  }

  await NotificationProducers.breedingChanged(access.farmObjectId, doc.animalId);
  if (result.pregnancy) {
    await NotificationProducers.pregnancyChanged(
      access.farmObjectId,
      result.pregnancy._id,
      result.pregnancy.action === "Closed" ? undefined : "confirmed",
    );
  }

  return {
    breeding: await loadDetail(access, doc._id),
    pregnancy: result.pregnancy,
    animalReproductiveStatus: result.reproductiveStatus,
    //derived from the Pregnancy record; the reminder itself is a notification
    calvingReminder:
      target === PregnancyResults.CONFIRMED && expectedCalvingDate
        ? { expectedCalvingDate, dueInDays: daysBetween(today, expectedCalvingDate) }
        : null,
    warnings: [...warnings, ...notes],
  };
};

/* -------------------------------------------------------------------------- */
/*                           Controlled correction                            */
/* -------------------------------------------------------------------------- */

//Pending records can still be fully corrected; once a result exists only the
//administrative fields change (dates / method would desync the Pregnancy chain)
const UPDATABLE_BY_RESULT: Record<string, string[]> = {
  Pending: [
    "heatDetectedDate",
    "inseminationDate",
    "breedingMethod",
    "bullId",
    "semenBatchNo",
    "technicianName",
    "expectedPregnancyCheckDate",
    "remarks",
    "reason",
  ],
  Failed: ["bullId", "semenBatchNo", "technicianName", "remarks", "reason"],
  Confirmed: ["bullId", "semenBatchNo", "technicianName", "remarks", "reason"],
};
//reproductive-history changes that need a written reason (spec §77/§131)
const MATERIAL_FIELDS = ["heatDetectedDate", "inseminationDate", "breedingMethod", "bullId"];

const idOrNull = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : null);
const timeOrNull = (v: Date | null | undefined) => (v ? new Date(v).getTime() : null);

/**
 * PUT /:id — controlled correction (Owner / Manager / Vet) with an AuditLog diff.
 *  - Pending: dates, method, bull, semen batch, technician, check date, remarks
 *  - Confirmed / Failed: bull, semen batch, technician, remarks (to change dates or
 *    the method, correct the result first through PATCH /:id/pregnancy-result)
 * animalId, breedingNo and pregnancyResult never change here. The merged record is
 * re-validated as a whole (date chain + method rules).
 */
const updateBreeding = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  rejectServerFields(body);
  if ("animalId" in body) {
    throw new AppError(status.BAD_REQUEST, "animalId cannot be changed — delete the erroneous entry and log it for the right animal.");
  }
  if ("pregnancyResult" in body) throw new AppError(status.BAD_REQUEST, "Results are recorded through PATCH /:id/pregnancy-result.");
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, BreedingPermissions.UPDATE, "correct breeding records");
  requireWritableFarm(access);

  const doc = await findRecord(access, id);
  const allowed = UPDATABLE_BY_RESULT[doc.pregnancyResult] ?? ["remarks", "reason"];
  const refused = Object.keys(body).filter((key) => !allowed.includes(key));
  if (refused.length) {
    throw new AppError(
      status.BAD_REQUEST,
      `${refused.join(", ")} cannot be changed on a ${doc.pregnancyResult} breeding${doc.pregnancyResult !== PregnancyResults.PENDING ? " — correct the result first" : ""}!`,
    );
  }

  const animal = await findAnimal(access, String(doc.animalId));
  const warnings: string[] = [];
  const set: Record<string, unknown> = {};

  //method
  const method = isBlank(body.breedingMethod) ? doc.breedingMethod : String(body.breedingMethod);
  if (!METHODS.includes(method)) throw new AppError(status.BAD_REQUEST, `breedingMethod must be one of: ${METHODS.join(", ")}!`);
  if (method !== doc.breedingMethod) set.breedingMethod = method;

  //dates (validated as one chain)
  if ("heatDetectedDate" in body || "inseminationDate" in body || "expectedPregnancyCheckDate" in body) {
    const heat = isBlank(body.heatDetectedDate)
      ? new Date(doc.heatDetectedDate)
      : parseEventDate("heatDetectedDate", body.heatDetectedDate, animal.birthDate);
    let insemination = doc.inseminationDate ? new Date(doc.inseminationDate) : null;
    if ("inseminationDate" in body) {
      insemination = isBlank(body.inseminationDate) ? null : parseEventDate("inseminationDate", body.inseminationDate, animal.birthDate);
    }
    const checkSent = !isBlank(body.expectedPregnancyCheckDate);
    const check = checkSent
      ? parseCalendarDate("expectedPregnancyCheckDate", body.expectedPregnancyCheckDate)
      : new Date(doc.expectedPregnancyCheckDate);
    const dates = validateDates({ heat, insemination, check }, { checkWasSent: true });
    if (timeOrNull(dates.heatDetectedDate) !== timeOrNull(doc.heatDetectedDate)) set.heatDetectedDate = dates.heatDetectedDate;
    if (timeOrNull(dates.inseminationDate) !== timeOrNull(doc.inseminationDate ?? null)) set.inseminationDate = dates.inseminationDate;
    if (timeOrNull(dates.expectedPregnancyCheckDate) !== timeOrNull(doc.expectedPregnancyCheckDate)) {
      set.expectedPregnancyCheckDate = dates.expectedPregnancyCheckDate;
    }
  }

  //bull (re-checked whenever the bull or the method changes)
  const bullRef = "bullId" in body ? body.bullId : doc.bullId ? String(doc.bullId) : null;
  if ("bullId" in body || set.breedingMethod) {
    const bull = await resolveBull(access, bullRef, method, animal._id, warnings);
    const next = bull?._id ?? null;
    if (idOrNull(next) !== idOrNull(doc.bullId)) set.bullId = next;
  }

  //semen batch (Natural Mating clears it automatically when the method changes)
  const semenSent = "semenBatchNo" in body;
  const semen = semenSent ? parseSemenBatch(body.semenBatchNo) : (doc.semenBatchNo ?? null);
  const finalSemen = applyMethodRules(method, semen, { semenWasSent: semenSent && !isBlank(body.semenBatchNo) });
  if (finalSemen !== (doc.semenBatchNo ?? null)) {
    set.semenBatchNo = finalSemen;
    if (!finalSemen && doc.semenBatchNo && !semenSent) warnings.push("semenBatchNo was cleared — it does not apply to Natural Mating.");
  }

  if ("technicianName" in body) {
    const name = parseTechnician(body.technicianName);
    if (name !== doc.technicianName) set.technicianName = name;
  }
  if ("remarks" in body) {
    const remarks = parseText("remarks", body.remarks) ?? "";
    if (remarks !== (doc.remarks ?? "")) set.remarks = remarks;
  }

  const changedFields = Object.keys(set);
  if (!changedFields.length) {
    return { mode: "unchanged" as const, breeding: await loadDetail(access, doc._id), warnings };
  }
  const material = changedFields.filter((f) => MATERIAL_FIELDS.includes(f));
  const reason = material.length ? requireReason("reason", body.reason, `change ${material.join(", ")}`) : parseText("reason", body.reason);

  if (set.heatDetectedDate || set.inseminationDate) {
    const merged = {
      heatDetectedDate: (set.heatDetectedDate as Date | undefined) ?? new Date(doc.heatDetectedDate),
      inseminationDate: "inseminationDate" in set ? (set.inseminationDate as Date | null) : (doc.inseminationDate ?? null),
    };
    const dup = await findPossibleDuplicate(access, animal._id, merged, doc._id);
    if (dup) warnings.push(`Note: ${dup.breedingNo} (${dup.pregnancyResult}) is logged for this animal around the same dates.`);
  }

  const updated = await BreedingModel.findOneAndUpdate(
    { _id: doc._id, pregnancyResult: doc.pregnancyResult, updatedAt: doc.updatedAt },
    { $set: set },
    { returnDocument: "after", runValidators: true },
  );
  if (!updated) throw new AppError(status.CONFLICT, "This breeding record was changed by someone else. Reload and try again.");

  const before = auditSnapshot(doc) as Record<string, unknown>;
  const oldData: Record<string, unknown> = {};
  const newData: Record<string, unknown> = {};
  for (const key of changedFields) {
    oldData[key] = before[key] ?? null;
    newData[key] = set[key] ?? null;
  }
  if (reason) newData.reason = reason;
  let event = "Breeding Corrected";
  if (changedFields.length === 1) {
    event =
      {
        breedingMethod: "Method Changed",
        bullId: "Bull Changed",
        semenBatchNo: "Semen Batch Changed",
        expectedPregnancyCheckDate: "Pregnancy Check Date Changed",
        heatDetectedDate: "Heat Date Changed",
        inseminationDate: "Insemination Date Changed",
        technicianName: "Technician Changed",
        remarks: "Breeding Updated",
      }[changedFields[0] as string] ?? event;
  }
  await audit(context, access.farmObjectId, "Breeding", doc._id, AuditActions.UPDATE, event, oldData, newData, changedFields);

  await NotificationProducers.breedingChanged(access.farmObjectId, doc.animalId);
  return { mode: "updated" as const, breeding: await loadDetail(access, doc._id), changedFields, warnings };
};

/* -------------------------------------------------------------------------- */
/*                                   Delete                                   */
/* -------------------------------------------------------------------------- */

/**
 * DELETE /:id — Owner only, for erroneous entries. A Confirmed breeding, or any breeding
 * with a linked Pregnancy record (even one closed by a correction), is reproductive
 * history and is never deleted (spec §107 / final schema). A reason is required and the
 * full record is preserved in the AuditLog.
 */
const deleteBreeding = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, BreedingPermissions.DELETE, "delete breeding records");
  requireWritableFarm(access);
  const reason = requireReason("reason", (payload ?? {}).reason, "delete a breeding record");

  const doc = await findRecord(access, id);
  if (doc.pregnancyResult === PregnancyResults.CONFIRMED) {
    throw new AppError(status.CONFLICT, "A Confirmed breeding is linked to a pregnancy and cannot be deleted.");
  }
  const pregnancy = await PregnancyModel.findOne({ breedingId: doc._id }).select("pregnancyNo pregnancyStatus").lean();
  if (pregnancy) {
    throw new AppError(
      status.CONFLICT,
      `Pregnancy ${pregnancy.pregnancyNo} (${pregnancy.pregnancyStatus}) is linked to this breeding — it is kept as reproductive history.`,
    );
  }

  const removed = await BreedingModel.deleteOne({ _id: doc._id, pregnancyResult: doc.pregnancyResult, updatedAt: doc.updatedAt });
  if (!removed.deletedCount) throw new AppError(status.CONFLICT, "This breeding record was changed by someone else. Reload and try again.");

  await audit(context, access.farmObjectId, "Breeding", doc._id, AuditActions.DELETE, "Breeding Deleted", auditSnapshot(doc), { reason });
  await NotificationProducers.breedingChanged(access.farmObjectId, doc.animalId);
  return { _id: doc._id, breedingNo: doc.breedingNo, deleted: true };
};

/* -------------------------------------------------------------------------- */
/*                                   Reads                                    */
/* -------------------------------------------------------------------------- */

const LIST_SORT_FIELDS = new Set([
  "heatDetectedDate",
  "inseminationDate",
  "expectedPregnancyCheckDate",
  "createdAt",
  "updatedAt",
  "breedingNo",
  "pregnancyResult",
  "breedingMethod",
]);
const DATE_FIELDS = ["heatDetectedDate", "inseminationDate", "expectedPregnancyCheckDate"];

const parseSort = (value: unknown, fallback = "-heatDetectedDate"): Record<string, 1 | -1> => {
  const raw = isBlank(value) ? fallback : String(value);
  const sort: Record<string, 1 | -1> = {};
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const desc = part.startsWith("-");
    const field = desc ? part.slice(1) : part;
    if (!LIST_SORT_FIELDS.has(field)) throw new AppError(status.BAD_REQUEST, `sort must use: ${[...LIST_SORT_FIELDS].join(", ")}!`);
    sort[field] = desc ? -1 : 1;
  }
  sort._id = -1;
  return sort;
};

const parseWindowDays = (value: unknown) =>
  isBlank(value) ? DEFAULT_CHECK_WINDOW_DAYS : Math.floor(parseNumber("days", value, { min: 0, max: MAX_CHECK_WINDOW_DAYS }));

/**
 * GET / — farm-wide breeding records, paginated. Filters: animalId, bullId,
 * breedingMethod (comma list), pregnancyResult (comma list), overdueCheck=true
 * (Pending + check date passed — derived, never stored), check=overdue|today|upcoming
 * (+ checkDays), semenBatchNo, technicianName, heatOnly=true, from/to on dateField
 * (heatDetectedDate | inseminationDate | expectedPregnancyCheckDate), searchTerm, sort.
 */
const getFarmBreedings = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const filter: Record<string, unknown> = { farmId: access.farmObjectId };
  const and: Record<string, unknown>[] = [];

  if (!isBlank(query.animalId)) filter.animalId = (await findAnimal(access, query.animalId))._id;
  if (!isBlank(query.bullId)) filter.bullId = (await findAnimal(access, query.bullId, "bullId"))._id;
  if (!isBlank(query.breedingMethod)) filter.breedingMethod = { $in: parseEnumList("breedingMethod", query.breedingMethod, METHODS) };
  if (!isBlank(query.pregnancyResult)) filter.pregnancyResult = { $in: parseEnumList("pregnancyResult", query.pregnancyResult, RESULTS) };
  if (!isBlank(query.semenBatchNo)) {
    filter.semenBatchNo = { $regex: `^${escapeRegex(String(query.semenBatchNo).trim())}$`, $options: "i" };
  }
  if (!isBlank(query.technicianName)) {
    filter.technicianName = { $regex: escapeRegex(String(query.technicianName).trim()), $options: "i" };
  }
  if (query.heatOnly === "true") filter.inseminationDate = null;

  const dateField = isBlank(query.dateField) ? "heatDetectedDate" : String(query.dateField);
  if (!DATE_FIELDS.includes(dateField)) throw new AppError(status.BAD_REQUEST, `dateField must be one of: ${DATE_FIELDS.join(", ")}!`);
  const range = parseDateRange(query, dateField);
  if (Object.keys(range).length) and.push(range);

  const today = startOfTodayUtc();
  const mode = !isBlank(query.check) ? String(query.check) : query.overdueCheck === "true" ? "overdue" : null;
  if (mode) {
    const pending = { pregnancyResult: PregnancyResults.PENDING };
    if (mode === "overdue") and.push({ ...pending, expectedPregnancyCheckDate: { $lt: today } });
    else if (mode === "today") and.push({ ...pending, expectedPregnancyCheckDate: { $gte: today, $lt: addDays(today, 1) } });
    else if (mode === "upcoming") {
      and.push({ ...pending, expectedPregnancyCheckDate: { $gte: today, $lt: addDays(today, parseWindowDays(query.checkDays) + 1) } });
    } else throw new AppError(status.BAD_REQUEST, "check must be overdue, today or upcoming!");
  }
  if (!isBlank(query.searchTerm)) {
    const rx = { $regex: escapeRegex(String(query.searchTerm).trim()), $options: "i" };
    and.push({ $or: [{ breedingNo: rx }, { semenBatchNo: rx }, { technicianName: rx }, { remarks: rx }] });
  }
  if (and.length) filter.$and = and;

  const { page, limit, skip } = parsePaging(query, MAX_LIST_LIMIT);
  const [total, rows] = await Promise.all([
    BreedingModel.countDocuments(filter),
    populateRecord(BreedingModel.find(filter).sort(parseSort(query.sort)).skip(skip).limit(limit).select("-__v")).lean(),
  ]);
  const data = (rows as unknown as TBreedingDoc[]).map((row) => ({ ...row, ...derive(row) }));
  return { meta: pageMeta(page, limit, total), data };
};

type TEvaluated = { pregnancyResult: string };

/** attempts per conception = evaluated attempts / confirmed (Pending excluded, spec §64). */
const outcomeStats = (rows: TEvaluated[]) => {
  const confirmed = rows.filter((r) => r.pregnancyResult === PregnancyResults.CONFIRMED).length;
  const failed = rows.filter((r) => r.pregnancyResult === PregnancyResults.FAILED).length;
  const pending = rows.filter((r) => r.pregnancyResult === PregnancyResults.PENDING).length;
  const evaluated = confirmed + failed;
  return {
    attempts: rows.length,
    confirmed,
    failed,
    pending,
    evaluated,
    conceptionRatePercent: percent(confirmed, evaluated),
    attemptsPerConception: confirmed ? round2(evaluated / confirmed) : null,
  };
};

/**
 * GET /animals/:animalId/breedings — the female's chronological breeding history
 * (oldest first, numbered attempts, attempts needed for each conception), conception
 * rate, active pending checks, the active pregnancy and current eligibility.
 */
const getAnimalBreedings = async (farmId: string, animalRef: string, requesterUserId: string) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const animal = await findAnimal(access, animalRef);
  const [rows, pregnancies, eligibility] = await Promise.all([
    populateRecord(
      BreedingModel.find({ farmId: access.farmObjectId, animalId: animal._id })
        .sort({ heatDetectedDate: 1, createdAt: 1 })
        .limit(MAX_ANIMAL_HISTORY)
        .select("-__v"),
    ).lean(),
    PregnancyModel.find({ farmId: access.farmObjectId, animalId: animal._id })
      .sort({ conceptionDate: -1 })
      .select("pregnancyNo breedingId conceptionDate expectedCalvingDate actualCalvingDate pregnancyStatus calfCount calfGender")
      .lean(),
    animal.gender === AnimalGenders.FEMALE ? checkEligibility(access, animal) : Promise.resolve(null),
  ]);
  const pregnancyOf = new Map(pregnancies.map((p) => [String(p.breedingId), p]));

  //number each attempt and count how many attempts each conception needed (spec §97–98)
  let sinceConception = 0;
  const conceptionAttempts: number[] = [];
  const history = (rows as unknown as TBreedingDoc[]).map((row, index) => {
    sinceConception += 1;
    let attemptsForConception: number | null = null;
    if (row.pregnancyResult === PregnancyResults.CONFIRMED) {
      attemptsForConception = sinceConception;
      conceptionAttempts.push(sinceConception);
      sinceConception = 0;
    }
    const pregnancy = pregnancyOf.get(String(row._id)) ?? null;
    return { ...row, ...derive(row), attemptNumber: index + 1, attemptsForConception, pregnancy };
  });

  const stats = outcomeStats(history);
  //consecutive failures since the last conception ("repeat breeder" signal at ≥ 3)
  let consecutiveFailures = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const r = history[i]!.pregnancyResult;
    if (r === PregnancyResults.FAILED) consecutiveFailures += 1;
    else if (r === PregnancyResults.CONFIRMED) break;
  }
  const last = history[history.length - 1];
  const lastService = [...history].reverse().find((h) => h.inseminationDate)?.inseminationDate ?? null;

  return {
    animal,
    summary: {
      ...stats,
      avgAttemptsBeforePregnancy: conceptionAttempts.length
        ? round2(conceptionAttempts.reduce((a, b) => a + b, 0) / conceptionAttempts.length)
        : null,
      consecutiveFailures,
      isRepeatBreeder: consecutiveFailures >= 3,
      lastHeatDate: last?.heatDetectedDate ?? null,
      lastServiceDate: lastService,
      //days since the last heat (cows cycle about every 21 days)
      daysSinceLastHeat: last ? daysBetween(new Date(last.heatDetectedDate), startOfTodayUtc()) : null,
      nextExpectedHeat: last && last.pregnancyResult !== PregnancyResults.CONFIRMED ? addDays(new Date(last.heatDetectedDate), 21) : null,
    },
    //Pending attempts still awaiting their pregnancy check (overdue flagged, never auto-failed)
    activePendingChecks: history.filter((h) => h.pregnancyResult === PregnancyResults.PENDING),
    activePregnancy: pregnancies.find((p) => p.pregnancyStatus === PregnancyStatuses.PREGNANT) ?? null,
    pregnancies,
    eligibility,
    history,
  };
};

/**
 * GET /analytics — reproductive metrics (spec §63–66, §97–101): confirmation rate
 * (Confirmed / (Confirmed + Failed), Pending excluded), attempts per conception,
 * method comparison, bull / semen batch / technician outcomes, monthly trend and repeat
 * breeders. Filters: from/to (heatDetectedDate), breedingMethod. Bull / batch numbers are
 * descriptive farm statistics, not proof of genetic or clinical quality.
 */
const getAnalytics = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const match: Record<string, unknown> = { farmId: access.farmObjectId, ...parseDateRange(query, "heatDetectedDate") };
  if (!isBlank(query.breedingMethod)) match.breedingMethod = { $in: parseEnumList("breedingMethod", query.breedingMethod, METHODS) };

  const rows = await BreedingModel.find(match)
    .select("animalId bullId semenBatchNo technicianName breedingMethod pregnancyResult heatDetectedDate inseminationDate expectedPregnancyCheckDate createdAt")
    .sort({ heatDetectedDate: 1, createdAt: 1 })
    .lean();
  const today = startOfTodayUtc();
  const totals = outcomeStats(rows);

  // eslint-disable-next-line no-unused-vars
  const groupBy = (keyOf: (r: (typeof rows)[number]) => string | null) => {
    const map = new Map<string, (typeof rows)[number][]>();
    for (const r of rows) {
      const key = keyOf(r);
      if (!key) continue;
      map.set(key, [...(map.get(key) ?? []), r]);
    }
    return map;
  };
  const ranked = <T extends { attempts: number; evaluated: number }>(list: T[]) =>
    list.sort((a, b) => b.evaluated - a.evaluated || b.attempts - a.attempts).slice(0, 10);

  const byMethod = METHODS.map((method) => ({ method, ...outcomeStats(rows.filter((r) => r.breedingMethod === method)) }));

  const bullGroups = groupBy((r) => (r.bullId ? String(r.bullId) : null));
  const bulls = await AnimalModel.find({ _id: { $in: [...bullGroups.keys()].map((k) => new Types.ObjectId(k)) } })
    .select("animalCode name lifeStatus")
    .lean();
  const bullOf = new Map(bulls.map((b) => [String(b._id), b]));
  const byBull = ranked([...bullGroups.entries()].map(([key, list]) => ({ bull: bullOf.get(key) ?? { _id: key }, ...outcomeStats(list) })));

  const bySemenBatch = ranked(
    [...groupBy((r) => r.semenBatchNo ?? null).entries()].map(([semenBatchNo, list]) => ({ semenBatchNo, ...outcomeStats(list) })),
  );
  const techGroups = groupBy((r) => (r.technicianName ? r.technicianName.trim().toLowerCase() : null));
  const byTechnician = ranked(
    [...techGroups.entries()].map(([, list]) => ({ technicianName: list[0]!.technicianName, ...outcomeStats(list) })),
  );

  //monthly trend by heat month (last 12 months of the filtered range)
  const monthMap = new Map<string, (typeof rows)[number][]>();
  for (const r of rows) {
    const key = dayKey(r.heatDetectedDate).slice(0, 7);
    monthMap.set(key, [...(monthMap.get(key) ?? []), r]);
  }
  const monthly = [...monthMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([month, list]) => ({ month, ...outcomeStats(list) }));

  //per animal: attempts needed per conception + repeat breeders (≥ 3 failures in a row)
  const perAnimal = groupBy((r) => String(r.animalId));
  const conceptionAttempts: number[] = [];
  const repeat: { animalId: string; consecutiveFailures: number; attempts: number }[] = [];
  for (const [animalId, list] of perAnimal.entries()) {
    let since = 0;
    for (const r of list) {
      since += 1;
      if (r.pregnancyResult === PregnancyResults.CONFIRMED) {
        conceptionAttempts.push(since);
        since = 0;
      }
    }
    let streak = 0;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const result = list[i]!.pregnancyResult;
      if (result === PregnancyResults.FAILED) streak += 1;
      else if (result === PregnancyResults.CONFIRMED) break;
    }
    if (streak >= 3) repeat.push({ animalId, consecutiveFailures: streak, attempts: list.length });
  }
  const repeatAnimals = await AnimalModel.find({ _id: { $in: repeat.map((r) => new Types.ObjectId(r.animalId)) } })
    .select("animalCode name reproductiveStatus lifeStatus")
    .lean();
  const repeatOf = new Map(repeatAnimals.map((a) => [String(a._id), a]));

  const pendingRows = rows.filter((r) => r.pregnancyResult === PregnancyResults.PENDING);
  const [activePregnancies, dueCalvings] = await Promise.all([
    PregnancyModel.countDocuments({ farmId: access.farmObjectId, pregnancyStatus: PregnancyStatuses.PREGNANT }),
    PregnancyModel.countDocuments({
      farmId: access.farmObjectId,
      pregnancyStatus: PregnancyStatuses.PREGNANT,
      expectedCalvingDate: { $gte: today, $lt: addDays(today, 31) },
    }),
  ]);

  return {
    asOf: today,
    totals: {
      ...totals,
      animalsBred: perAnimal.size,
      heatOnly: rows.filter((r) => !r.inseminationDate).length,
      overdueChecks: pendingRows.filter((r) => new Date(r.expectedPregnancyCheckDate) < today).length,
      checksDueNext7Days: pendingRows.filter((r) => {
        const d = new Date(r.expectedPregnancyCheckDate);
        return d >= today && d < addDays(today, 8);
      }).length,
      avgAttemptsBeforePregnancy: conceptionAttempts.length
        ? round2(conceptionAttempts.reduce((a, b) => a + b, 0) / conceptionAttempts.length)
        : null,
      activePregnancies,
      calvingsDueNext30Days: dueCalvings,
    },
    byMethod,
    byBull,
    bySemenBatch,
    byTechnician,
    monthly,
    repeatBreeders: repeat
      .sort((a, b) => b.consecutiveFailures - a.consecutiveFailures)
      .slice(0, 20)
      .map((r) => ({ ...r, animal: repeatOf.get(r.animalId) ?? null })),
    disclaimer:
      "Bull, semen batch and technician figures are descriptive farm statistics. Outcomes also depend on the animal, timing and management, so they are not proof of genetic or clinical quality.",
  };
};

/** GET /pregnancy-checks — Pending breedings grouped as overdue / today / upcoming (reminder list). */
const getPregnancyChecks = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const days = parseWindowDays(query.days);
  const today = startOfTodayUtc();
  const rows = await populateRecord(
    BreedingModel.find({
      farmId: access.farmObjectId,
      pregnancyResult: PregnancyResults.PENDING,
      expectedPregnancyCheckDate: { $lt: addDays(today, days + 1) },
    })
      .sort({ expectedPregnancyCheckDate: 1 })
      .limit(300)
      .select("breedingNo animalId bullId breedingMethod heatDetectedDate inseminationDate expectedPregnancyCheckDate pregnancyResult technicianName semenBatchNo"),
  ).lean();
  const items = (rows as unknown as TBreedingDoc[]).map((r) => ({ ...r, ...derive(r) }));
  return {
    asOf: today,
    windowDays: days,
    overdue: items.filter((i) => i.checkState === "Overdue"),
    today: items.filter((i) => i.checkState === "Today"),
    upcoming: items.filter((i) => i.checkState === "Upcoming"),
  };
};

/**
 * GET /eligibility?animalId= — pre-check for the breeding form: blockers, warnings,
 * pending attempts, active pregnancy, last breeding and the default check date.
 */
const getEligibility = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const animal = await findAnimal(access, query.animalId);
  const eligibility = await checkEligibility(access, animal);
  const base = isBlank(query.serviceDate) ? startOfTodayUtc() : parseCalendarDate("serviceDate", query.serviceDate);
  return {
    animal,
    ...eligibility,
    canCreate: BreedingPermissions.CREATE.includes(access.role as never) && access.farmStatus === FarmStatuses.ACTIVE,
    suggestedPregnancyCheckDate: addDays(base, DEFAULT_PREGNANCY_CHECK_DAYS),
  };
};

/**
 * GET /bulls — male animals of this farm selectable as bullId, with their breeding
 * outcome counts. Active bulls by default; includeInactive=true adds sold / dead sires
 * (valid for AI / ET history).
 */
const getBulls = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const filter: Record<string, unknown> = { farmId: access.farmObjectId, gender: AnimalGenders.MALE };
  if (query.includeInactive !== "true") filter.lifeStatus = AnimalLifeStatuses.ACTIVE;
  if (!isBlank(query.searchTerm)) {
    const rx = { $regex: escapeRegex(String(query.searchTerm).trim()), $options: "i" };
    filter.$or = [{ animalCode: rx }, { name: rx }, { tagNumber: rx }];
  }
  const bulls = await AnimalModel.find(filter)
    .select("animalCode name tagNumber lifeStatus birthDate breedId purpose")
    .populate("breedId", "breedName breedCode")
    .sort({ lifeStatus: 1, animalCode: 1 })
    .limit(300)
    .lean();
  const counts = await BreedingModel.aggregate<{ _id: Types.ObjectId; attempts: number; confirmed: number; failed: number }>([
    { $match: { farmId: access.farmObjectId, bullId: { $in: bulls.map((b) => b._id) } } },
    {
      $group: {
        _id: "$bullId",
        attempts: { $sum: 1 },
        confirmed: { $sum: { $cond: [{ $eq: ["$pregnancyResult", PregnancyResults.CONFIRMED] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ["$pregnancyResult", PregnancyResults.FAILED] }, 1, 0] } },
      },
    },
  ]);
  const countOf = new Map(counts.map((c) => [String(c._id), c]));
  return bulls.map((b) => {
    const c = countOf.get(String(b._id));
    const age = ageInMonths(b.birthDate);
    return {
      ...b,
      ageMonths: age,
      isMature: age === null ? null : age >= MIN_BULL_AGE_MONTHS,
      attempts: c?.attempts ?? 0,
      confirmed: c?.confirmed ?? 0,
      failed: c?.failed ?? 0,
      conceptionRatePercent: c ? percent(c.confirmed, c.confirmed + c.failed) : null,
    };
  });
};

/** GET /:id — one breeding (by _id or BRD number), populated, with the linked Pregnancy. */
const getBreeding = async (farmId: string, id: string, requesterUserId: string) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const doc = await findRecord(access, id);
  return loadDetail(access, doc._id);
};

/** GET /:id/audit-logs — Owner / Manager / Vet: who logged, corrected and checked the record. */
const getAuditLogs = async (farmId: string, id: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, BreedingPermissions.AUDIT, "view breeding history");
  const doc = await findRecord(access, id);
  const pregnancy = await PregnancyModel.findOne({ breedingId: doc._id }).select("_id").lean();
  const { page, limit, skip } = parsePaging(query, MAX_LIST_LIMIT);
  const filter = {
    farmId: access.farmObjectId,
    $or: [
      { entityType: AuditEntityTypes.BREEDING, entityId: doc._id },
      ...(pregnancy ? [{ entityType: AuditEntityTypes.PREGNANCY, entityId: pregnancy._id }] : []),
    ],
  };
  const [total, data] = await Promise.all([
    AuditLogModel.countDocuments(filter),
    AuditLogModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      //never expose IP / user agent to farm users
      .select("logNo action event entityType oldData newData changedFields status createdAt userId")
      .populate("userId", "userId fullName")
      .lean(),
  ]);
  return { meta: pageMeta(page, limit, total), data };
};

/** GET /meta — enums, transitions, permissions, policy and limits for forms and filters. */
const getMeta = () => ({
  breedingMethods: METHODS,
  pregnancyResults: RESULTS,
  resultTransitions: RESULT_TRANSITIONS,
  updatableByResult: UPDATABLE_BY_RESULT,
  materialFields: MATERIAL_FIELDS,
  permissions: BreedingPermissions,
  reproductivePolicy: {
    blocked: BLOCKED_REPRODUCTIVE_STATUSES,
    eligible: ELIGIBLE_REPRODUCTIVE_STATUSES,
    caution: CAUTION_REPRODUCTIVE_STATUSES,
  },
  methodRules: {
    [BreedingMethods.ARTIFICIAL_INSEMINATION]: { semenBatchNo: "required", bullId: "optional (sire)" },
    [BreedingMethods.NATURAL_MATING]: { semenBatchNo: "not applicable", bullId: "required (Active male of this farm)" },
    [BreedingMethods.EMBRYO_TRANSFER]: { semenBatchNo: "optional", bullId: "optional", remarks: "embryo / donor details" },
  },
  sortFields: [...LIST_SORT_FIELDS],
  dateFields: DATE_FIELDS,
  limits: {
    maxTextLength: MAX_TEXT_LENGTH,
    maxShortText: MAX_SHORT_TEXT,
    minBreedingAgeMonths: MIN_BREEDING_AGE_MONTHS,
    minBullAgeMonths: MIN_BULL_AGE_MONTHS,
    defaultPregnancyCheckDays: DEFAULT_PREGNANCY_CHECK_DAYS,
    minPregnancyCheckDays: MIN_PREGNANCY_CHECK_DAYS,
    maxPregnancyCheckDays: MAX_PREGNANCY_CHECK_DAYS,
    maxHeatToServiceDays: MAX_HEAT_TO_SERVICE_DAYS,
    minConfirmDays: MIN_CONFIRM_DAYS,
    duplicateWindowDays: DUPLICATE_WINDOW_DAYS,
    maxBackdateDays: MAX_BACKDATE_DAYS,
    gestationDays: CATTLE_GESTATION_DAYS,
    minGestationDays: MIN_GESTATION_DAYS,
    maxGestationDays: MAX_GESTATION_DAYS,
    defaultCheckWindowDays: DEFAULT_CHECK_WINDOW_DAYS,
    maxCheckWindowDays: MAX_CHECK_WINDOW_DAYS,
  },
});

export const BreedingServices = {
  createBreeding,
  recordPregnancyResult,
  updateBreeding,
  deleteBreeding,
  getFarmBreedings,
  getAnimalBreedings,
  getAnalytics,
  getPregnancyChecks,
  getEligibility,
  getBulls,
  getBreeding,
  getAuditLogs,
  getMeta,
};
