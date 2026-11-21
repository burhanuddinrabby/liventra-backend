import status from "http-status";
import mongoose, { isValidObjectId, Types } from "mongoose";
import type { ClientSession } from "mongoose";
import AppError from "../../errors/AppError.js";
import { AnimalModel } from "../animal/animal.model.js";
import { AnimalLifeStatuses } from "../animal/animal.constants.js";
import { AuditLogModel } from "../auditLog/auditLog.model.js";
import {
  AuditActions,
  AuditEntityTypes,
  AuditModules,
} from "../auditLog/auditLog.constants.js";
import type { TAuditAction } from "../auditLog/auditLog.interface.js";
import { recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext } from "../auditLog/auditLog.utils.js";
import { FarmModel } from "../farm/farm.model.js";
import { FarmStatuses } from "../farm/farm.constants.js";
import type { TFarmMemberRole } from "../farmMember/farmMember.interface.js";
import { FarmMemberServices } from "../farmMember/farmMember.service.js";
import { FeedFormulaModel } from "../feedFormula/feedFormula.model.js";
import {
  FeedFormulaPurposes,
  FeedFormulaSeasons,
  FeedFormulaStages,
  seasonForMonth,
} from "../feedFormula/feedFormula.constants.js";
import { FeedFormulaServices } from "../feedFormula/feedFormula.services.js";
import {
  convertQuantity,
  toKilograms,
} from "../feedFormula/feedFormula.utils.js";
import { FeedRecommendationModel } from "./feedRecommendation.model.js";
import {
  ACTIVE_RECOMMENDATION_STATUSES,
  ADG_DMI_PER_KG,
  CREATABLE_STATUSES,
  DMI_PERCENT_OF_BODY_WEIGHT,
  FeedRecommendationPermissions,
  FeedRecommendationStatuses,
  HEALTH_REVIEW_STATUSES,
  IMMUTABLE_SNAPSHOT_FIELDS,
  MAX_LIST_LIMIT,
  MAX_SCALE_FACTOR,
  MAX_TEXT_LENGTH,
  MILK_DMI_PER_LITER,
  MILK_LOOKBACK_DAYS,
  MILK_RECORD_COLLECTION,
  MIN_CRUDE_PROTEIN,
  MIN_SCALE_FACTOR,
  OFFICIAL_RECOMMENDATION_STATUSES,
  RECOMMENDATION_RULE_VERSION,
  ReviewTransitions,
  SEASON_DMI_FACTOR,
  STALE_WEIGHT_DAYS,
  StatusTransitions,
  WEIGHT_RECORD_COLLECTION,
} from "./feedRecommendation.constants.js";
import type {
  TFeedRecommendation,
  TFeedRecommendationStatus,
  TInputSnapshot,
  TRecommendedItem,
} from "./feedRecommendation.interface.js";
import {
  RECOMMENDATION_NO_PATTERN,
  ageInMonths,
  clamp,
  derivePurpose,
  deriveStage,
  escapeRegex,
  generateRecommendationNo,
  round,
  runInTransaction,
} from "./feedRecommendation.utils.js";

type TPayload = Record<string, unknown>;

const STAGES = Object.values(FeedFormulaStages) as string[];
const PURPOSES = Object.values(FeedFormulaPurposes) as string[];
const SEASONS = Object.values(FeedFormulaSeasons) as string[];
const STATUSES = Object.values(FeedRecommendationStatuses) as string[];
const DAY_MS = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/*                         Farm-scoped authorization                          */
/* -------------------------------------------------------------------------- */

type TAccess = {
  userObjectId: Types.ObjectId;
  farmObjectId: Types.ObjectId;
  farmCode: string;
  farmStatus: string;
  role: TFarmMemberRole;
  //FarmMember _id of the caller (createdBy / reviewedBy); null only for a super admin without a row
  memberObjectId: Types.ObjectId | null;
};

/**
 * Active membership (or super admin / Farm.ownerId treated as Owner) + farm status.
 * The owner account self-heals a missing Owner row so it can always sign records.
 */
const resolveAccess = async (farmId: string, requesterUserId: string): Promise<TAccess> => {
  const access = await FarmMemberServices.resolveFarmAccess(farmId, requesterUserId);
  const role = FarmMemberServices.getActorRole(access);
  if (!role) throw new AppError(status.FORBIDDEN, "You are not an active member of this farm!");

  let memberObjectId = (access.membership?._id as Types.ObjectId | undefined) ?? null;
  if (!memberObjectId && access.isOwnerAccount) {
    const row = await FarmMemberServices.ensureOwnerMembership(access.farm._id, access.user._id);
    memberObjectId = (row?._id as Types.ObjectId | undefined) ?? null;
  }

  const farm = await FarmModel.findById(access.farm._id).select("status").lean();
  return {
    userObjectId: access.user._id,
    farmObjectId: access.farm._id,
    farmCode: access.farm.farmId,
    farmStatus: farm?.status ?? FarmStatuses.ACTIVE,
    role,
    memberObjectId,
  };
};

const requireRole = (access: TAccess, allowed: readonly TFarmMemberRole[], action: string) => {
  if (!allowed.includes(access.role)) {
    throw new AppError(
      status.FORBIDDEN,
      `Your farm role (${access.role}) is not allowed to ${action}!`,
    );
  }
};

/** Suspended / Inactive farms are read-only. */
const requireWritableFarm = (access: TAccess) => {
  if (access.farmStatus === FarmStatuses.ARCHIVED || access.farmStatus === FarmStatuses.INACTIVE) {
    throw new AppError(
      status.FORBIDDEN,
      `This farm is ${access.farmStatus.toLowerCase()} — feed recommendations are read-only!`,
    );
  }
};

//createdBy / reviewedBy reference a FarmMember row (final schema)
const requireMemberRow = (access: TAccess): Types.ObjectId => {
  if (!access.memberObjectId) {
    throw new AppError(
      status.FORBIDDEN,
      "An active farm membership is required to sign feed recommendations!",
    );
  }
  return access.memberObjectId;
};

/* -------------------------------------------------------------------------- */
/*                               Parsing helpers                              */
/* -------------------------------------------------------------------------- */

const isBlank = (value: unknown) =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");

const parseObjectId = (field: string, value: unknown): Types.ObjectId => {
  if (typeof value !== "string" || !isValidObjectId(value)) {
    throw new AppError(status.BAD_REQUEST, `${field} must be a valid id!`);
  }
  return new Types.ObjectId(value);
};

const parseEnum = (field: string, value: unknown, allowed: readonly string[]): string => {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new AppError(status.BAD_REQUEST, `${field} must be one of: ${allowed.join(", ")}!`);
  }
  return value;
};

const parseNonNegative = (field: string, value: unknown): number => {
  const num = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isFinite(num) || num < 0) {
    throw new AppError(status.BAD_REQUEST, `${field} must be a non-negative number!`);
  }
  return num;
};

const parseText = (field: string, value: unknown, required = false): string | undefined => {
  if (isBlank(value)) {
    if (required) throw new AppError(status.BAD_REQUEST, `${field} is required!`);
    return undefined;
  }
  if (typeof value !== "string") throw new AppError(status.BAD_REQUEST, `${field} must be text!`);
  const text = value.trim();
  if (text.length > MAX_TEXT_LENGTH) {
    throw new AppError(status.BAD_REQUEST, `${field} cannot exceed ${MAX_TEXT_LENGTH} characters!`);
  }
  return text;
};

const parseBoolean = (value: unknown): boolean => value === true || value === "true";

const parseDate = (field: string, value: unknown, endOfDay = false): Date => {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new AppError(status.BAD_REQUEST, `${field} must be a valid date!`);
  //a bare YYYY-MM-DD "to" date includes the whole day
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) date.setUTCHours(23, 59, 59, 999);
  return date;
};

//PATCH bodies may only carry controlled metadata — snapshot fields are frozen
const rejectSnapshotEdits = (body: TPayload) => {
  const forbidden = IMMUTABLE_SNAPSHOT_FIELDS.filter((field) => field in body);
  if (forbidden.length > 0) {
    throw new AppError(
      status.BAD_REQUEST,
      `Recommendation snapshots are immutable (${forbidden.join(", ")}). Generate a new recommendation instead.`,
    );
  }
};

/* -------------------------------------------------------------------------- */
/*                          Rule-based nutrition engine                       */
/* -------------------------------------------------------------------------- */

type TIngredientMaster = {
  _id: Types.ObjectId;
  ingredientCode: string;
  ingredientName: string;
  category: string;
  unit: string;
  pricePerUnit: number;
  dryMatterPercentage: number;
  crudeProtein: number;
  energy: number;
  isAvailable: boolean;
  isActive: boolean;
};

type TFormulaForEngine = {
  _id: Types.ObjectId;
  formulaCode: string;
  formulaName: string;
  breedId: Types.ObjectId;
  stage: string;
  purpose: string;
  season: string;
  targetADG?: number;
  ruleVersion: string;
  isDefault?: boolean;
  ingredients: { ingredientId: unknown; percentage: number; quantity: number; unit: string }[];
};

//preview lines carry extra (non-persisted) detail for the UI
type TPreviewItem = TRecommendedItem & {
  ingredientCode: string;
  category: string;
  dryMatterKg: number | null;
  pricePerUnit: number;
  ingredientUnit: string;
  isAvailable: boolean;
};

type TEngineResult = {
  animal: Record<string, unknown>;
  formula: Record<string, unknown> | null;
  formulaCandidates: Record<string, unknown>[];
  inputSnapshot: TInputSnapshot;
  recommendedItems: TPreviewItem[];
  totalRecommendedDMI: number;
  estimatedDailyCost: number;
  requiredDMI: number | null;
  scaleFactor: number;
  explanation: string[];
  warnings: string[];
  ruleVersion: string;
  //reasons the result cannot be saved as an official record
  blockers: string[];
  canSave: boolean;
};

const INGREDIENT_FIELDS =
  "ingredientCode ingredientName category unit pricePerUnit dryMatterPercentage crudeProtein energy isAvailable isActive";

const isMaster = (value: unknown): value is TIngredientMaster =>
  !!value && typeof value === "object" && "ingredientCode" in value;

/** Latest day's total milk (L) within MILK_LOOKBACK_DAYS from the MilkRecord collection. */
const latestMilkYield = async (
  farmObjectId: Types.ObjectId,
  animalObjectId: Types.ObjectId,
): Promise<{ yield: number; date: Date } | null> => {
  const db = mongoose.connection.db;
  if (!db) return null;
  try {
    const since = new Date(Date.now() - MILK_LOOKBACK_DAYS * DAY_MS);
    const rows = await db
      .collection(MILK_RECORD_COLLECTION)
      .find({ farmId: farmObjectId, animalId: animalObjectId, recordDate: { $gte: since } })
      .project({ recordDate: 1, quantity: 1, unit: 1 })
      .sort({ recordDate: -1 })
      .limit(50)
      .toArray();
    const first = rows[0];
    if (!first) return null;
    const dayKey = (d: unknown) => new Date(d as Date).toISOString().slice(0, 10);
    const latestDay = dayKey(first.recordDate);
    const total = rows
      .filter((row) => dayKey(row.recordDate) === latestDay)
      .reduce((sum, row) => {
        const qty = Number(row.quantity) || 0;
        return sum + (row.unit === "ml" ? qty / 1000 : qty);
      }, 0);
    return { yield: round(total, 2), date: new Date(first.recordDate as Date) };
  } catch {
    return null;
  }
};

/** Date of the latest WeightRecord, falling back to the profile's last update. */
const latestWeightDate = async (
  farmObjectId: Types.ObjectId,
  animalObjectId: Types.ObjectId,
): Promise<Date | null> => {
  const db = mongoose.connection.db;
  if (!db) return null;
  try {
    const row = await db
      .collection(WEIGHT_RECORD_COLLECTION)
      .find({ farmId: farmObjectId, animalId: animalObjectId })
      .project({ recordedDate: 1 })
      .sort({ recordedDate: -1 })
      .limit(1)
      .next();
    return row?.recordedDate ? new Date(row.recordedDate as Date) : null;
  } catch {
    return null;
  }
};

const formulaSummary = (formula: TFormulaForEngine) => ({
  _id: formula._id,
  formulaCode: formula.formulaCode,
  formulaName: formula.formulaName,
  stage: formula.stage,
  purpose: formula.purpose,
  season: formula.season,
  ruleVersion: formula.ruleVersion,
  isDefault: !!formula.isDefault,
});

/**
 * Generates a recommendation from the animal's live context (rule v1.0):
 *  1. Context: age (birthDate), currentWeight, health/reproductive status, latest
 *     MilkRecord yield, stage/purpose derived from the animal (overridable), season
 *     (request or current Bangladesh season), targetADG (request or formula).
 *  2. Formula: the requested active formulaId, or the best match from
 *     FeedFormula /match. Ambiguous or missing matches never fabricate a plan.
 *  3. Requirement: DMI = weight × stage %BW (+0.1 kg DM per L milk when lactating,
 *     + ADG adjustment), × season factor. Formula quantities are scaled to it
 *     (bounded 0.5×–2×); without a weight the formula is used unscaled.
 *  4. Items priced with the current ingredient prices; warnings for stale data,
 *     health, unavailable/retired ingredients and low protein.
 * Pure read — nothing is written, so a preview never pollutes the database.
 */
const runEngine = async (
  access: TAccess,
  requesterUserId: string,
  payload: TPayload,
): Promise<TEngineResult> => {
  const body = payload ?? {};
  const explanation: string[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  const now = new Date();

  //--- animal (farm-isolated)
  const animalObjectId = parseObjectId("animalId", body.animalId);
  const animal = await AnimalModel.findOne({ _id: animalObjectId, farmId: access.farmObjectId })
    .select(
      "animalCode name gender purpose birthDate currentWeight breedId lifeStatus healthStatus reproductiveStatus isActive updatedAt",
    )
    .populate("breedId", "breedCode breedName")
    .lean();
  if (!animal) throw new AppError(status.NOT_FOUND, "Animal not found in this farm!");
  if (animal.lifeStatus !== AnimalLifeStatuses.ACTIVE || !animal.isActive) {
    throw new AppError(
      status.CONFLICT,
      `Animal ${animal.animalCode} is ${animal.lifeStatus} — recommendations can only be generated for active animals.`,
    );
  }
  const breed = animal.breedId as unknown as { _id: Types.ObjectId; breedCode: string; breedName: string } | null;

  //--- context
  const age = ageInMonths(animal.birthDate ?? null, now);
  if (age === null) warnings.push("Birth date unknown; age was not considered.");

  const weight = typeof animal.currentWeight === "number" ? animal.currentWeight : null;
  if (weight === null) {
    warnings.push("Current weight is missing; formula quantities are used without weight scaling.");
  } else {
    const weighedAt =
      (await latestWeightDate(access.farmObjectId, animalObjectId)) ??
      (animal.updatedAt ? new Date(animal.updatedAt) : null);
    if (weighedAt && now.getTime() - weighedAt.getTime() > STALE_WEIGHT_DAYS * DAY_MS) {
      warnings.push(
        `Weight data may be stale (last updated ${weighedAt.toISOString().slice(0, 10)}); re-weigh the animal for accuracy.`,
      );
    }
  }

  const derivedStage = deriveStage({
    gender: animal.gender,
    purpose: animal.purpose,
    reproductiveStatus: animal.reproductiveStatus,
    ageMonths: age,
  });
  const stage = isBlank(body.stage) ? derivedStage : parseEnum("stage", body.stage, STAGES);
  const purpose = isBlank(body.purpose)
    ? derivePurpose({ purpose: animal.purpose, stage })
    : parseEnum("purpose", body.purpose, PURPOSES);
  const season = isBlank(body.season) ? seasonForMonth(now.getMonth()) : parseEnum("season", body.season, SEASONS);

  let milkYield: number | null = null;
  if (!isBlank(body.milkYield)) {
    milkYield = parseNonNegative("milkYield", body.milkYield);
    explanation.push(`Milk yield ${milkYield} L/day provided manually`);
  } else {
    const milk = await latestMilkYield(access.farmObjectId, animalObjectId);
    if (milk) {
      milkYield = milk.yield;
      explanation.push(`Milk yield ${milk.yield} L/day from MilkRecord of ${milk.date.toISOString().slice(0, 10)}`);
    } else if (stage === FeedFormulaStages.LACTATING) {
      warnings.push(`No milk record in the last ${MILK_LOOKBACK_DAYS} days; milk yield was not considered.`);
    }
  }
  const requestedADG = isBlank(body.targetADG) ? null : parseNonNegative("targetADG", body.targetADG);

  if (HEALTH_REVIEW_STATUSES.includes(animal.healthStatus)) {
    warnings.push(`Animal is ${animal.healthStatus}; consult a veterinarian before changing feed (expert review recommended).`);
  }

  //--- formula
  let formula: TFormulaForEngine | null = null;
  let formulaCandidates: Record<string, unknown>[] = [];
  if (!isBlank(body.formulaId)) {
    const ref = String(body.formulaId).trim();
    const found = await FeedFormulaModel.findOne(
      isValidObjectId(ref) ? { _id: ref } : { formulaCode: ref.toUpperCase() },
    )
      .populate("ingredients.ingredientId", INGREDIENT_FIELDS)
      .lean();
    if (!found) throw new AppError(status.NOT_FOUND, "Feed formula not found!");
    if (!found.isActive) throw new AppError(status.CONFLICT, "This feed formula is retired and cannot be used!");
    formula = found as unknown as TFormulaForEngine;
    explanation.push(`Formula ${formula.formulaCode} (${formula.formulaName}) selected manually`);
    if (breed && String(formula.breedId) !== String(breed._id)) {
      warnings.push("Selected formula is for a different breed than this animal.");
    }
    if (formula.stage !== stage) warnings.push(`Selected formula is for the ${formula.stage} stage (animal: ${stage}).`);
    if (formula.purpose !== purpose) warnings.push(`Selected formula is for ${formula.purpose} (animal: ${purpose}).`);
    if (formula.season !== season && formula.season !== FeedFormulaSeasons.ALL_SEASON) {
      warnings.push(`Selected formula is a ${formula.season} formula (current season: ${season}).`);
    }
  } else {
    const match = await FeedFormulaServices.matchFormulas(
      {
        farmId: access.farmCode,
        animalId: String(animalObjectId),
        stage,
        purpose,
        season,
        ...(milkYield !== null ? { milkYield } : {}),
        ...(requestedADG !== null ? { targetADG: requestedADG } : {}),
        limit: 5,
      },
      requesterUserId,
    );
    formulaCandidates = match.candidates.map((c) => ({
      ...formulaSummary(c.formula as unknown as TFormulaForEngine),
      score: c.score,
    }));
    for (const w of match.warnings) if (!/Season not provided/.test(w)) warnings.push(w);
    if (match.bestMatch) {
      formula = match.bestMatch.formula as unknown as TFormulaForEngine;
      explanation.push(...match.bestMatch.explanation);
      explanation.push(`Formula ${formula.formulaCode} (${formula.formulaName}) matched automatically`);
    } else if (match.requiresManualSelection) {
      blockers.push("Several formulas match equally well; choose a formulaId.");
    } else {
      blockers.push("No suitable active feed formula found for this animal; choose a formulaId or ask an expert.");
    }
  }

  const targetADG = requestedADG ?? (typeof formula?.targetADG === "number" ? formula.targetADG : null);

  const inputSnapshot: TInputSnapshot = {
    age,
    currentWeight: weight,
    stage,
    purpose,
    healthStatus: animal.healthStatus,
    reproductiveStatus: animal.reproductiveStatus,
    milkYield,
    targetADG,
    season,
  };

  const animalSummary = {
    _id: animal._id,
    animalCode: animal.animalCode,
    name: animal.name,
    gender: animal.gender,
    purpose: animal.purpose,
    breed: breed ? { _id: breed._id, breedCode: breed.breedCode, breedName: breed.breedName } : null,
  };

  const empty = (): TEngineResult => ({
    animal: animalSummary,
    formula: formula ? formulaSummary(formula) : null,
    formulaCandidates,
    inputSnapshot,
    recommendedItems: [],
    totalRecommendedDMI: 0,
    estimatedDailyCost: 0,
    requiredDMI: null,
    scaleFactor: 1,
    explanation,
    warnings,
    ruleVersion: RECOMMENDATION_RULE_VERSION,
    blockers,
    canSave: false,
  });
  if (!formula) return empty();

  //--- ingredient masters
  const allowUnavailable = parseBoolean(body.allowUnavailableIngredients);
  const lines: { master: TIngredientMaster; quantity: number; unit: string }[] = [];
  for (const line of formula.ingredients) {
    const master = line.ingredientId;
    if (!isMaster(master)) {
      warnings.push("An ingredient of this formula no longer exists in the catalog and was skipped.");
      continue;
    }
    if (!master.isActive) {
      warnings.push(`${master.ingredientName} is retired from the ingredient catalog and was skipped.`);
      continue;
    }
    if (!master.isAvailable) {
      warnings.push(`${master.ingredientName} is currently unavailable.`);
      if (!allowUnavailable) {
        blockers.push(
          `${master.ingredientName} is unavailable; send allowUnavailableIngredients: true to save anyway.`,
        );
      }
    }
    lines.push({ master, quantity: line.quantity, unit: line.unit });
  }
  if (lines.length === 0) {
    blockers.push("None of the formula's ingredients can be used.");
    return empty();
  }

  //--- requirement and scaling
  const dmOf = (master: TIngredientMaster, quantity: number, unit: string) => {
    const kg = toKilograms(quantity, unit);
    return kg === null ? null : (kg * master.dryMatterPercentage) / 100;
  };
  const formulaDM = lines.reduce((sum, l) => sum + (dmOf(l.master, l.quantity, l.unit) ?? 0), 0);

  let requiredDMI: number | null = null;
  let scaleFactor = 1;
  if (weight !== null && weight > 0) {
    const pct = DMI_PERCENT_OF_BODY_WEIGHT[stage] ?? 2.5;
    let dmi = (weight * pct) / 100;
    explanation.push(`Base intake ${pct}% of ${weight} kg body weight = ${round(dmi, 2)} kg DM/day (${stage} stage)`);
    if (stage === FeedFormulaStages.LACTATING && milkYield !== null && milkYield > 0) {
      dmi += milkYield * MILK_DMI_PER_LITER;
      explanation.push(`+${round(milkYield * MILK_DMI_PER_LITER, 2)} kg DM for ${milkYield} L/day milk`);
    }
    if (requestedADG !== null && typeof formula.targetADG === "number" && requestedADG > formula.targetADG) {
      const extra = (requestedADG - formula.targetADG) * ADG_DMI_PER_KG;
      dmi += extra;
      explanation.push(`+${round(extra, 2)} kg DM for target ADG ${requestedADG} kg/day`);
    }
    const seasonFactor = SEASON_DMI_FACTOR[season] ?? 1;
    if (seasonFactor !== 1) {
      dmi *= seasonFactor;
      explanation.push(`${season} adjustment ×${seasonFactor}`);
    }
    requiredDMI = round(dmi, 2);

    if (formulaDM > 0) {
      const raw = requiredDMI / formulaDM;
      scaleFactor = round(clamp(raw, MIN_SCALE_FACTOR, MAX_SCALE_FACTOR), 3);
      if (scaleFactor !== round(raw, 3)) {
        warnings.push(
          `Required intake differs strongly from the formula (×${round(raw, 2)}); scaling was limited to ×${scaleFactor}. Consider a formula closer to this animal's weight.`,
        );
      }
      explanation.push(`Formula quantities scaled ×${scaleFactor} to meet ${requiredDMI} kg DM/day`);
    } else {
      warnings.push("Formula has no measurable dry matter; quantities were not scaled.");
    }
  }
  if (season === FeedFormulaSeasons.SUMMER) warnings.push("Summer heat: water intake should increase.");

  //--- items
  let totalDM = 0;
  let proteinDM = 0;
  let totalCost = 0;
  const recommendedItems: TPreviewItem[] = lines.map(({ master, quantity, unit }) => {
    const qty = round(quantity * scaleFactor, 2);
    const dm = dmOf(master, qty, unit);
    if (dm !== null) {
      totalDM += dm;
      proteinDM += dm * master.crudeProtein;
    }
    const cost = round(convertQuantity(qty, unit, master.unit) * master.pricePerUnit, 2);
    totalCost += cost;
    return {
      ingredientId: master._id,
      ingredientName: master.ingredientName,
      quantity: qty,
      unit,
      estimatedCost: cost,
      ingredientCode: master.ingredientCode,
      category: master.category,
      dryMatterKg: dm === null ? null : round(dm, 3),
      pricePerUnit: master.pricePerUnit,
      ingredientUnit: master.unit,
      isAvailable: master.isAvailable,
    };
  });

  const crudeProtein = totalDM > 0 ? round(proteinDM / totalDM, 2) : 0;
  const minCP = MIN_CRUDE_PROTEIN[stage];
  if (minCP !== undefined && totalDM > 0 && crudeProtein < minCP) {
    warnings.push(`Low Protein Diet: ${crudeProtein}% CP of DM (recommended ≥ ${minCP}% for ${stage}).`);
  }
  explanation.push(`Rule version ${RECOMMENDATION_RULE_VERSION} (formula rule ${formula.ruleVersion})`);

  return {
    ...empty(),
    recommendedItems,
    totalRecommendedDMI: round(totalDM, 3),
    estimatedDailyCost: round(totalCost, 2),
    requiredDMI,
    scaleFactor,
    canSave: blockers.length === 0,
  };
};

/* -------------------------------------------------------------------------- */
/*                               Read helpers                                 */
/* -------------------------------------------------------------------------- */

const MEMBER_POPULATE = {
  select: "role userId",
  populate: { path: "userId", select: "userId fullName" },
};

//served straight from the stored snapshot — never recalculated from master data
const populateDetail = <T>(query: T): T => {
  const q = query as unknown as mongoose.Query<unknown, unknown>;
  return q
    .populate("animalId", "animalCode name gender purpose lifeStatus profilePhoto")
    .populate("formulaId", "formulaCode formulaName ruleVersion stage purpose season isActive")
    .populate({ path: "createdBy", ...MEMBER_POPULATE })
    .populate({ path: "reviewedBy", ...MEMBER_POPULATE })
    .populate("supersededBy", "recommendationNo status generatedAt") as unknown as T;
};

const findRecommendation = async (access: TAccess, ref: string) => {
  const value = String(ref ?? "").trim();
  if (!value) throw new AppError(status.BAD_REQUEST, "Recommendation id or number is required!");
  let filter: Record<string, unknown>;
  if (isValidObjectId(value)) filter = { _id: new Types.ObjectId(value) };
  else if (RECOMMENDATION_NO_PATTERN.test(value)) filter = { recommendationNo: value.toUpperCase() };
  else throw new AppError(status.BAD_REQUEST, "Invalid recommendation id or number!");
  const doc = await FeedRecommendationModel.findOne({ ...filter, farmId: access.farmObjectId });
  if (!doc) throw new AppError(status.NOT_FOUND, "Feed recommendation not found!");
  return doc;
};

const loadDetail = (id: Types.ObjectId) =>
  populateDetail(FeedRecommendationModel.findById(id).select("-__v")).lean();

const auditSnapshot = (doc: { toObject?: () => unknown } | Record<string, unknown>) => {
  const obj = (typeof doc.toObject === "function" ? doc.toObject() : doc) as Record<string, unknown>;
  return {
    recommendationNo: obj.recommendationNo,
    animalId: obj.animalId,
    formulaId: obj.formulaId,
    status: obj.status,
    estimatedDailyCost: obj.estimatedDailyCost,
    totalRecommendedDMI: obj.totalRecommendedDMI,
    ruleVersion: obj.ruleVersion,
    statusReason: obj.statusReason,
    reviewNote: obj.reviewNote,
  };
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
    entityType: AuditEntityTypes.FEED_RECOMMENDATION,
    entityId,
    action,
    module: AuditModules.FEED,
    event,
    oldData,
    newData,
    changedFields,
  });

/** Marks the animal's other active plans Superseded (inside the caller's transaction). */
const supersedePrevious = async (
  farmObjectId: Types.ObjectId,
  animalObjectId: Types.ObjectId,
  newId: Types.ObjectId,
  session: ClientSession | null,
) => {
  const filter = {
    farmId: farmObjectId,
    animalId: animalObjectId,
    _id: { $ne: newId },
    status: { $in: ACTIVE_RECOMMENDATION_STATUSES },
  };
  const previous = await FeedRecommendationModel.find(filter)
    .select("_id recommendationNo status")
    .session(session)
    .lean();
  if (previous.length === 0) return previous;
  await FeedRecommendationModel.updateMany(
    { _id: { $in: previous.map((p) => p._id) } },
    {
      $set: {
        status: FeedRecommendationStatuses.SUPERSEDED,
        supersededBy: newId,
        supersededAt: new Date(),
      },
    },
    session ? { session } : {},
  );
  return previous;
};

const auditSuperseded = (
  context: TAuditContext,
  farmId: Types.ObjectId,
  previous: { _id: unknown; recommendationNo: string; status: string }[],
  newNo: string,
) =>
  Promise.all(
    previous.map((p) =>
      audit(
        context,
        farmId,
        p._id as Types.ObjectId,
        AuditActions.UPDATE,
        "Recommendation Superseded",
        { status: p.status },
        { status: FeedRecommendationStatuses.SUPERSEDED, supersededBy: newNo },
        ["status", "supersededBy", "supersededAt"],
      ),
    ),
  );

/* -------------------------------------------------------------------------- */
/*                                  Services                                  */
/* -------------------------------------------------------------------------- */

/** POST /preview — live, unsaved recommendation. */
const previewRecommendation = async (farmId: string, requesterUserId: string, payload: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, FeedRecommendationPermissions.PREVIEW, "preview feed recommendations");
  const result = await runEngine(access, requesterUserId, payload);
  const active = await FeedRecommendationModel.findOne({
    farmId: access.farmObjectId,
    animalId: result.animal._id as Types.ObjectId,
    status: { $in: ACTIVE_RECOMMENDATION_STATUSES },
  })
    .sort({ generatedAt: -1 })
    .select("recommendationNo status generatedAt estimatedDailyCost totalRecommendedDMI ruleVersion")
    .lean();
  return { ...result, isPreview: true, generatedAt: new Date(), currentActiveRecommendation: active ?? null };
};

/**
 * POST / — official snapshot. The server re-runs the engine (client-sent items are
 * never trusted), freezes the result, then — in one transaction — creates the new
 * record first and only afterwards supersedes the animal's previous active plan.
 */
const createRecommendation = async (
  farmId: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, FeedRecommendationPermissions.CREATE, "generate feed recommendations");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);

  const recordStatus = (
    isBlank(body.status) ? FeedRecommendationStatuses.CONFIRMED : parseEnum("status", body.status, CREATABLE_STATUSES)
  ) as TFeedRecommendationStatus;

  const result = await runEngine(access, requesterUserId, body);
  if (!result.canSave) {
    throw new AppError(status.UNPROCESSABLE_ENTITY, `Recommendation cannot be saved: ${result.blockers.join(" ")}`);
  }

  const generatedAt = new Date();
  const animalObjectId = result.animal._id as Types.ObjectId;
  const recommendationNo = await generateRecommendationNo(generatedAt);
  const data: TFeedRecommendation = {
    recommendationNo,
    farmId: access.farmObjectId,
    animalId: animalObjectId,
    formulaId: (result.formula?._id as Types.ObjectId | undefined) ?? null,
    generatedAt,
    inputSnapshot: result.inputSnapshot,
    //persist only the snapshot fields of each line
    recommendedItems: result.recommendedItems.map((i) => ({
      ingredientId: i.ingredientId,
      ingredientName: i.ingredientName,
      quantity: i.quantity,
      unit: i.unit,
      estimatedCost: i.estimatedCost,
    })),
    totalRecommendedDMI: result.totalRecommendedDMI,
    estimatedDailyCost: result.estimatedDailyCost,
    explanation: result.explanation,
    warnings: result.warnings,
    ruleVersion: result.ruleVersion,
    status: recordStatus,
    createdBy: memberId,
  };

  const { created, superseded } = await runInTransaction(async (session) => {
    const [doc] = await FeedRecommendationModel.create([data], session ? { session } : {});
    if (!doc) throw new AppError(status.INTERNAL_SERVER_ERROR, "Failed to save the recommendation!");
    if (recordStatus !== FeedRecommendationStatuses.CONFIRMED) return { created: doc, superseded: [] };
    try {
      const prev = await supersedePrevious(access.farmObjectId, animalObjectId, doc._id, session);
      return { created: doc, superseded: prev };
    } catch (error) {
      //no transaction (standalone mongod): compensate so no half-applied state remains
      if (!session) await FeedRecommendationModel.deleteOne({ _id: doc._id });
      throw error;
    }
  });

  await audit(
    context,
    access.farmObjectId,
    created._id,
    AuditActions.CREATE,
    recordStatus === FeedRecommendationStatuses.CONFIRMED ? "Recommendation Confirmed" : "Recommendation Generated",
    null,
    auditSnapshot(created),
  );
  await auditSuperseded(context, access.farmObjectId, superseded, recommendationNo);

  return {
    recommendation: await loadDetail(created._id),
    supersededRecommendations: superseded.map((p) => p.recommendationNo),
  };
};

const LIST_SORT_FIELDS = new Set([
  "generatedAt",
  "createdAt",
  "estimatedDailyCost",
  "totalRecommendedDMI",
  "recommendationNo",
  "status",
  "ruleVersion",
]);

const parseSort = (value: unknown): Record<string, 1 | -1> => {
  if (isBlank(value)) return { generatedAt: -1, _id: -1 };
  const sort: Record<string, 1 | -1> = {};
  for (const raw of String(value).split(",")) {
    const key = raw.trim();
    const field = key.replace(/^-/, "");
    if (!LIST_SORT_FIELDS.has(field)) {
      throw new AppError(status.BAD_REQUEST, `Cannot sort by "${field}"!`);
    }
    sort[field] = key.startsWith("-") ? -1 : 1;
  }
  sort._id = -1;
  return sort;
};

const parsePaging = (query: TPayload) => {
  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || 10, 1), MAX_LIST_LIMIT);
  return { page, limit, skip: (page - 1) * limit };
};

//animalId filter accepts a Mongo _id or the farm's animalCode (AN-000001)
const resolveAnimalFilter = async (access: TAccess, value: string): Promise<Types.ObjectId> => {
  const ref = value.trim();
  const animal = await AnimalModel.findOne(
    isValidObjectId(ref)
      ? { _id: new Types.ObjectId(ref), farmId: access.farmObjectId }
      : { animalCode: ref.toUpperCase(), farmId: access.farmObjectId },
  )
    .select("_id")
    .lean();
  if (!animal) throw new AppError(status.NOT_FOUND, "Animal not found in this farm!");
  return animal._id as Types.ObjectId;
};

/** GET / — farm-wide list with filters + pagination. */
const getFarmRecommendations = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const filter: Record<string, unknown> = { farmId: access.farmObjectId };

  if (!isBlank(query.animalId)) filter.animalId = await resolveAnimalFilter(access, String(query.animalId));
  if (!isBlank(query.status)) {
    const values = String(query.status).split(",").map((s) => s.trim()).filter(Boolean);
    values.forEach((v) => parseEnum("status", v, STATUSES));
    filter.status = values.length === 1 ? values[0] : { $in: values };
  }
  if (!isBlank(query.ruleVersion)) filter.ruleVersion = parseText("ruleVersion", query.ruleVersion);
  if (!isBlank(query.formulaId)) filter.formulaId = parseObjectId("formulaId", query.formulaId);
  if (!isBlank(query.season)) filter["inputSnapshot.season"] = parseEnum("season", query.season, SEASONS);
  if (!isBlank(query.stage)) filter["inputSnapshot.stage"] = parseEnum("stage", query.stage, STAGES);
  const range: Record<string, Date> = {};
  if (!isBlank(query.from)) range.$gte = parseDate("from", query.from);
  if (!isBlank(query.to)) range.$lte = parseDate("to", query.to, true);
  if (range.$gte && range.$lte && range.$gte > range.$lte) {
    throw new AppError(status.BAD_REQUEST, "from must be before to!");
  }
  if (Object.keys(range).length) filter.generatedAt = range;
  if (!isBlank(query.searchTerm)) {
    filter.recommendationNo = { $regex: escapeRegex(String(query.searchTerm).trim()), $options: "i" };
  }

  const { page, limit, skip } = parsePaging(query);
  const [total, data] = await Promise.all([
    FeedRecommendationModel.countDocuments(filter),
    FeedRecommendationModel.find(filter)
      .sort(parseSort(query.sort))
      .skip(skip)
      .limit(limit)
      .select("-__v -explanation")
      .populate("animalId", "animalCode name")
      .populate("formulaId", "formulaCode formulaName ruleVersion")
      .populate({ path: "createdBy", ...MEMBER_POPULATE })
      .lean(),
  ]);
  return {
    meta: { page, limit, totalEntries: total, totalPage: Math.ceil(total / limit) },
    data,
  };
};

/** GET /animals/:animalId/feed-recommendations — chronological history + active plan. */
const getAnimalRecommendations = async (
  farmId: string,
  animalRef: string,
  requesterUserId: string,
  query: TPayload,
) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const animalObjectId = await resolveAnimalFilter(access, animalRef);
  const animal = await AnimalModel.findById(animalObjectId)
    .select("animalCode name gender purpose lifeStatus healthStatus reproductiveStatus currentWeight profilePhoto")
    .lean();

  const filter: Record<string, unknown> = { farmId: access.farmObjectId, animalId: animalObjectId };
  if (!isBlank(query.status)) {
    const values = String(query.status).split(",").map((s) => s.trim()).filter(Boolean);
    values.forEach((v) => parseEnum("status", v, STATUSES));
    filter.status = { $in: values };
  }
  const { page, limit, skip } = parsePaging({ ...query, limit: query.limit ?? 50 });

  const [total, history, active, counts] = await Promise.all([
    FeedRecommendationModel.countDocuments(filter),
    populateDetail(
      FeedRecommendationModel.find(filter).sort({ generatedAt: -1, _id: -1 }).skip(skip).limit(limit).select("-__v"),
    ).lean(),
    populateDetail(
      FeedRecommendationModel.findOne({
        farmId: access.farmObjectId,
        animalId: animalObjectId,
        status: { $in: ACTIVE_RECOMMENDATION_STATUSES },
      })
        .sort({ generatedAt: -1 })
        .select("-__v"),
    ).lean(),
    FeedRecommendationModel.aggregate([
      { $match: { farmId: access.farmObjectId, animalId: animalObjectId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  return {
    meta: { page, limit, totalEntries: total, totalPage: Math.ceil(total / limit) },
    data: {
      animal,
      activeRecommendation: active ?? null,
      statusCounts: Object.fromEntries(STATUSES.map((s) => [s, counts.find((c) => c._id === s)?.count ?? 0])),
      history,
    },
  };
};

/** GET /:id — single immutable snapshot by _id or recommendationNo. */
const getRecommendation = async (farmId: string, ref: string, requesterUserId: string) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const doc = await findRecommendation(access, ref);
  return loadDetail(doc._id);
};

/** GET /meta — enums + rule factors for forms, filters and explainability. */
const getMeta = () => ({
  statuses: STATUSES,
  creatableStatuses: CREATABLE_STATUSES,
  statusTransitions: StatusTransitions,
  reviewTransitions: ReviewTransitions,
  stages: STAGES,
  purposes: PURPOSES,
  seasons: SEASONS,
  currentSeason: seasonForMonth(new Date().getMonth()),
  ruleVersion: RECOMMENDATION_RULE_VERSION,
  rules: {
    dmiPercentOfBodyWeight: DMI_PERCENT_OF_BODY_WEIGHT,
    milkDmiPerLiter: MILK_DMI_PER_LITER,
    adgDmiPerKg: ADG_DMI_PER_KG,
    seasonDmiFactor: SEASON_DMI_FACTOR,
    scaleFactorRange: { min: MIN_SCALE_FACTOR, max: MAX_SCALE_FACTOR },
    minCrudeProtein: MIN_CRUDE_PROTEIN,
    staleWeightDays: STALE_WEIGHT_DAYS,
    milkLookbackDays: MILK_LOOKBACK_DAYS,
  },
  permissions: FeedRecommendationPermissions,
  units: { totalRecommendedDMI: "kg DM/day", estimatedDailyCost: "BDT/day", milkYield: "L/day", targetADG: "kg/day" },
});

/** GET /stats — farm dashboard numbers. */
const getStats = async (farmId: string, requesterUserId: string) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const match = { farmId: access.farmObjectId };
  const [byStatus, byRule, active, animals] = await Promise.all([
    FeedRecommendationModel.aggregate([{ $match: match }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    FeedRecommendationModel.aggregate([
      { $match: match },
      { $group: { _id: "$ruleVersion", count: { $sum: 1 }, avgDailyCost: { $avg: "$estimatedDailyCost" } } },
      { $sort: { _id: 1 } },
    ]),
    FeedRecommendationModel.aggregate([
      { $match: { ...match, status: { $in: ACTIVE_RECOMMENDATION_STATUSES } } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          totalDailyCost: { $sum: "$estimatedDailyCost" },
          avgDailyCost: { $avg: "$estimatedDailyCost" },
          avgDMI: { $avg: "$totalRecommendedDMI" },
        },
      },
    ]),
    FeedRecommendationModel.distinct("animalId", { ...match, status: { $in: ACTIVE_RECOMMENDATION_STATUSES } }),
  ]);
  const total = byStatus.reduce((sum, s) => sum + s.count, 0);
  const activeRow = active[0];
  return {
    total,
    byStatus: Object.fromEntries(STATUSES.map((s) => [s, byStatus.find((b) => b._id === s)?.count ?? 0])),
    byRuleVersion: byRule.map((r) => ({ ruleVersion: r._id, count: r.count, avgDailyCost: round(r.avgDailyCost ?? 0, 2) })),
    activePlans: {
      count: activeRow?.count ?? 0,
      animalsCovered: animals.length,
      totalDailyCost: round(activeRow?.totalDailyCost ?? 0, 2),
      avgDailyCost: round(activeRow?.avgDailyCost ?? 0, 2),
      avgDMI: round(activeRow?.avgDMI ?? 0, 3),
    },
  };
};

/**
 * PATCH /:id/status — Draft → Confirmed (supersedes the previous active plan in a
 * transaction) or Draft/Confirmed → Rejected (reason required). Snapshot fields are
 * rejected outright.
 */
const updateStatus = async (
  farmId: string,
  ref: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  rejectSnapshotEdits(body);
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, FeedRecommendationPermissions.STATUS, "change recommendation status");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);

  const doc = await findRecommendation(access, ref);
  const next = parseEnum("status", body.status, STATUSES) as TFeedRecommendationStatus;
  const allowed = StatusTransitions[doc.status] ?? [];
  if (!allowed.includes(next)) {
    throw new AppError(
      status.CONFLICT,
      `Cannot change status from ${doc.status} to ${next}${allowed.length ? ` (allowed: ${allowed.join(", ")})` : ""}!`,
    );
  }
  const reason = parseText("reason", body.reason, next === FeedRecommendationStatuses.REJECTED);
  const before = auditSnapshot(doc);

  if (next === FeedRecommendationStatuses.CONFIRMED) {
    //the animal must still be under active management to receive a new official plan
    const animal = await AnimalModel.findById(doc.animalId).select("animalCode lifeStatus isActive").lean();
    if (!animal || animal.lifeStatus !== AnimalLifeStatuses.ACTIVE || !animal.isActive) {
      throw new AppError(status.CONFLICT, "The animal is no longer active; this draft cannot be confirmed.");
    }
  }

  const superseded = await runInTransaction(async (session) => {
    const set: Record<string, unknown> = { status: next };
    if (next === FeedRecommendationStatuses.REJECTED) {
      set.statusReason = reason;
      set.reviewedBy = memberId;
      set.reviewedAt = new Date();
    } else if (reason) {
      set.statusReason = reason;
    }
    //optimistic guard: the status must not have changed since it was read
    const updated = await FeedRecommendationModel.updateOne(
      { _id: doc._id, status: doc.status },
      { $set: set },
      session ? { session } : {},
    );
    if (updated.modifiedCount !== 1) {
      throw new AppError(status.CONFLICT, "The recommendation was changed by someone else; reload and try again.");
    }
    if (next !== FeedRecommendationStatuses.CONFIRMED) return [];
    try {
      return await supersedePrevious(doc.farmId, doc.animalId, doc._id, session);
    } catch (error) {
      if (!session) {
        await FeedRecommendationModel.updateOne({ _id: doc._id }, { $set: { status: doc.status } });
      }
      throw error;
    }
  });

  const fresh = await loadDetail(doc._id);
  await audit(
    context,
    doc.farmId,
    doc._id,
    next === FeedRecommendationStatuses.REJECTED ? AuditActions.REJECT : AuditActions.UPDATE,
    next === FeedRecommendationStatuses.REJECTED ? "Recommendation Rejected" : "Recommendation Confirmed",
    before,
    auditSnapshot((fresh ?? {}) as Record<string, unknown>),
    ["status", ...(reason ? ["statusReason"] : []), ...(next === FeedRecommendationStatuses.REJECTED ? ["reviewedBy", "reviewedAt"] : [])],
  );
  await auditSuperseded(context, doc.farmId, superseded, doc.recommendationNo);

  return { recommendation: fresh, supersededRecommendations: superseded.map((p) => p.recommendationNo) };
};

/** PATCH /:id/review — optional expert validation: Confirmed → Expert Approved | Rejected. */
const reviewRecommendation = async (
  farmId: string,
  ref: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  rejectSnapshotEdits(body);
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, FeedRecommendationPermissions.REVIEW, "review feed recommendations");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);

  const doc = await findRecommendation(access, ref);
  const decision = parseEnum("decision", body.decision ?? body.status, [
    FeedRecommendationStatuses.EXPERT_APPROVED,
    FeedRecommendationStatuses.REJECTED,
  ]) as TFeedRecommendationStatus;
  const allowed = ReviewTransitions[doc.status] ?? [];
  if (!allowed.includes(decision)) {
    throw new AppError(
      status.CONFLICT,
      `Only Confirmed recommendations can be reviewed (current status: ${doc.status})!`,
    );
  }
  const note = parseText("reviewNote", body.reviewNote ?? body.reason, decision === FeedRecommendationStatuses.REJECTED);
  const before = auditSnapshot(doc);

  const set: Record<string, unknown> = {
    status: decision,
    reviewedBy: memberId,
    reviewedAt: new Date(),
  };
  if (note) set.reviewNote = note;
  if (note && decision === FeedRecommendationStatuses.REJECTED) set.statusReason = note;
  const updated = await FeedRecommendationModel.updateOne({ _id: doc._id, status: doc.status }, { $set: set });
  if (updated.modifiedCount !== 1) {
    throw new AppError(status.CONFLICT, "The recommendation was changed by someone else; reload and try again.");
  }

  const fresh = await loadDetail(doc._id);
  await audit(
    context,
    doc.farmId,
    doc._id,
    decision === FeedRecommendationStatuses.REJECTED ? AuditActions.REJECT : AuditActions.APPROVE,
    decision === FeedRecommendationStatuses.REJECTED ? "Recommendation Rejected" : "Recommendation Expert Approved",
    before,
    auditSnapshot((fresh ?? {}) as Record<string, unknown>),
    Object.keys(set),
  );
  return fresh;
};

/** DELETE /:id — Owner; only unconfirmed Draft records may be physically removed. */
const deleteRecommendation = async (
  farmId: string,
  ref: string,
  requesterUserId: string,
  context: TAuditContext,
) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, FeedRecommendationPermissions.DELETE, "delete feed recommendations");
  requireWritableFarm(access);
  const doc = await findRecommendation(access, ref);
  //official statuses (Confirmed / Expert Approved / Superseded / Rejected) are history
  if (OFFICIAL_RECOMMENDATION_STATUSES.includes(doc.status) || doc.status !== FeedRecommendationStatuses.DRAFT) {
    throw new AppError(
      status.CONFLICT,
      `${doc.status} recommendations are official history and cannot be deleted. Use Rejected or generate a newer recommendation instead.`,
    );
  }
  const before = auditSnapshot(doc);
  const removed = await FeedRecommendationModel.deleteOne({ _id: doc._id, status: FeedRecommendationStatuses.DRAFT });
  if (removed.deletedCount !== 1) {
    throw new AppError(status.CONFLICT, "The recommendation was changed by someone else; reload and try again.");
  }
  await audit(context, doc.farmId, doc._id, AuditActions.DELETE, "Draft Recommendation Deleted", before, null);
  return { _id: doc._id, recommendationNo: doc.recommendationNo };
};

/** GET /:id/audit-logs — status / review history of one recommendation. */
const getAuditLogs = async (farmId: string, ref: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, FeedRecommendationPermissions.AUDIT, "view recommendation audit logs");
  const doc = await findRecommendation(access, ref);
  const { page, limit, skip } = parsePaging(query);
  const filter = {
    entityType: AuditEntityTypes.FEED_RECOMMENDATION,
    entityId: doc._id,
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
  return { meta: { page, limit, totalEntries: total, totalPage: Math.ceil(total / limit) }, data };
};

export const FeedRecommendationServices = {
  previewRecommendation,
  createRecommendation,
  getFarmRecommendations,
  getAnimalRecommendations,
  getRecommendation,
  getMeta,
  getStats,
  updateStatus,
  reviewRecommendation,
  deleteRecommendation,
  getAuditLogs,
};
