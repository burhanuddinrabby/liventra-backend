import status from "http-status";
import mongoose, { isValidObjectId, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import AppError from "../../errors/AppError.js";
import QueryBuilder from "../../builder/QueryBuilder.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { UserModel } from "../auth/auth.model.js";
import { BreedModel } from "../breed/breed.model.js";
import { AnimalModel } from "../animal/animal.model.js";
import { FarmMemberModel } from "../farmMember/farmMember.model.js";
import { FarmMemberServices } from "../farmMember/farmMember.service.js";
import { FeedIngredientModel } from "../feedIngredient/feedIngredient.model.js";
import { FeedIngredientUnits } from "../feedIngredient/feedIngredient.constants.js";
import { AuditLogModel } from "../auditLog/auditLog.model.js";
import {
  AuditActions,
  AuditEntityTypes,
  AuditModules,
} from "../auditLog/auditLog.constants.js";
import { recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext } from "../auditLog/auditLog.utils.js";
import { FeedFormulaModel } from "./feedFormula.model.js";
import {
  ANIMAL_PURPOSE_TO_FORMULA_PURPOSE,
  FEED_FORMULA_REFERENCE_SOURCES,
  FeedFormulaNutritionUnits,
  FeedFormulaPurposes,
  FeedFormulaSeasons,
  FeedFormulaStages,
  MAX_FORMULA_INGREDIENTS,
  PERCENTAGE_QUANTITY_TOLERANCE,
  PERCENTAGE_SUM_TOLERANCE,
  PERCENTAGE_TOTAL,
  REPRODUCTIVE_STATUS_TO_STAGE,
  UnitConversions,
  seasonForMonth,
} from "./feedFormula.constants.js";
import type {
  TExpectedNutrition,
  TFeedFormula,
  TFormulaIngredient,
  TFormulaUsage,
  TRange,
} from "./feedFormula.interface.js";
import {
  bumpRuleVersion,
  compareRuleVersions,
  convertQuantity,
  escapeRegex,
  generateFormulaCode,
  round,
  toKilograms,
  unitsCompatible,
} from "./feedFormula.utils.js";

type TPayload = Record<string, unknown>;
type TFormulaDoc = HydratedDocument<TFeedFormula>;
//enum fields are validated as plain strings before querying
type TFormulaFilter = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* Projections                                                         */
/* ------------------------------------------------------------------ */

//actor identity only — never contact details
const USER_PUBLIC_FIELDS = "userId fullName";
const BREED_PUBLIC_FIELDS = "breedCode breedName category purpose isActive";
//everything the nutrition/cost calculation and the UI need from an ingredient
const INGREDIENT_CALC_FIELDS =
  "ingredientCode ingredientName category unit pricePerUnit dryMatterPercentage crudeProtein energy isAvailable isActive";
const LOOKUP_FIELDS =
  "formulaCode formulaName breedId stage purpose season targetWeightRange targetMilkYield targetADG estimatedDailyCost ruleVersion isDefault isActive";

const SORT_FIELDS = new Set([
  "formulaCode",
  "formulaName",
  "stage",
  "purpose",
  "season",
  "ruleVersion",
  "estimatedDailyCost",
  "targetADG",
  "isDefault",
  "isActive",
  "createdAt",
  "updatedAt",
]);

const STAGES = Object.values(FeedFormulaStages) as string[];
const PURPOSES = Object.values(FeedFormulaPurposes) as string[];
const SEASONS = Object.values(FeedFormulaSeasons) as string[];
const UNITS = Object.values(FeedIngredientUnits) as string[];
const RULE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/;

/* ------------------------------------------------------------------ */
/* Parsing helpers                                                     */
/* ------------------------------------------------------------------ */

const parseBoolean = (value: unknown): boolean | undefined => {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
};

const isBlank = (value: unknown) =>
  value === null || (typeof value === "string" && value.trim() === "");

const parseNumber = (field: string, value: unknown, opts: { positive?: boolean; max?: number } = {}) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (typeof value === "boolean" || isBlank(value) || !Number.isFinite(parsed)) {
    throw new AppError(status.BAD_REQUEST, `${field} must be a valid number!`);
  }
  if (opts.positive ? parsed <= 0 : parsed < 0) {
    throw new AppError(
      status.BAD_REQUEST,
      opts.positive ? `${field} must be greater than 0!` : `${field} cannot be negative!`,
    );
  }
  if (opts.max !== undefined && parsed > opts.max) {
    throw new AppError(status.BAD_REQUEST, `${field} cannot exceed ${opts.max}!`);
  }
  return parsed;
};

const parseEnum = (field: string, value: unknown, allowed: readonly string[]): string => {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new AppError(status.BAD_REQUEST, `${field} must be one of: ${allowed.join(", ")}!`);
  }
  return value;
};

const parseObjectId = (field: string, value: unknown): Types.ObjectId => {
  if (typeof value !== "string" || !isValidObjectId(value)) {
    throw new AppError(status.BAD_REQUEST, `${field} must be a valid ObjectId!`);
  }
  return new Types.ObjectId(value);
};

const parseFormulaName = (value: unknown): string => {
  if (typeof value !== "string") throw new AppError(status.BAD_REQUEST, "formulaName must be a string!");
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 3 || name.length > 150) {
    throw new AppError(status.BAD_REQUEST, "Formula name must be 3-150 characters!");
  }
  return name;
};

const parseDescription = (value: unknown): string => {
  if (typeof value !== "string") throw new AppError(status.BAD_REQUEST, "description must be a string!");
  return value.trim().slice(0, 2000);
};

const parseRuleVersion = (value: unknown): string => {
  if (typeof value !== "string" || !RULE_VERSION_PATTERN.test(value.trim())) {
    throw new AppError(
      status.BAD_REQUEST,
      "ruleVersion must be 1-30 characters: letters, digits, '.', '_' or '-' (e.g. v1.0)!",
    );
  }
  return value.trim();
};

//target ranges: both bounds optional, non-negative, min <= max
const parseRange = (field: string, value: unknown): TRange => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError(status.BAD_REQUEST, `${field} must be an object with min and/or max!`);
  }
  const raw = value as TPayload;
  const result: TRange = {};
  if (raw.min !== undefined && raw.min !== null) result.min = parseNumber(`${field}.min`, raw.min);
  if (raw.max !== undefined && raw.max !== null) result.max = parseNumber(`${field}.max`, raw.max);
  if (result.min === undefined && result.max === undefined) {
    throw new AppError(status.BAD_REQUEST, `${field} needs a min and/or max value!`);
  }
  if (result.min !== undefined && result.max !== undefined && result.min > result.max) {
    throw new AppError(status.BAD_REQUEST, `${field}.min must be less than or equal to ${field}.max!`);
  }
  return result;
};

type TIngredientInput = {
  ref: string;
  percentage?: number;
  quantity: number;
  unit?: string;
};

const parseIngredientLines = (value: unknown): TIngredientInput[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError(status.BAD_REQUEST, "A formula needs at least one ingredient!");
  }
  if (value.length > MAX_FORMULA_INGREDIENTS) {
    throw new AppError(status.BAD_REQUEST, `A formula can have at most ${MAX_FORMULA_INGREDIENTS} ingredients!`);
  }
  return value.map((line, index) => {
    const label = `ingredients[${index}]`;
    if (typeof line !== "object" || line === null) {
      throw new AppError(status.BAD_REQUEST, `${label} must be an object!`);
    }
    const raw = line as TPayload;
    const ref = typeof raw.ingredientId === "string" ? raw.ingredientId.trim() : "";
    if (!ref) throw new AppError(status.BAD_REQUEST, `${label}.ingredientId is required!`);
    const parsed: TIngredientInput = {
      ref,
      quantity: parseNumber(`${label}.quantity`, raw.quantity, { positive: true }),
    };
    if (raw.percentage !== undefined && raw.percentage !== null) {
      parsed.percentage = parseNumber(`${label}.percentage`, raw.percentage, { max: 100 });
    }
    if (raw.unit !== undefined && raw.unit !== null) parsed.unit = parseEnum(`${label}.unit`, raw.unit, UNITS);
    return parsed;
  });
};

/* ------------------------------------------------------------------ */
/* Composition: validation + nutrition / cost calculation              */
/* ------------------------------------------------------------------ */

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

type TBreakdownLine = {
  ingredientId: Types.ObjectId;
  ingredientCode: string;
  ingredientName: string;
  category: string;
  percentage: number;
  quantity: number;
  unit: string;
  asFedKg: number | null;
  dryMatterKg: number | null;
  pricePerUnit: number;
  ingredientUnit: string;
  estimatedCost: number;
  isAvailable: boolean;
  isActive: boolean;
};

type TComposition = {
  ingredients: TFormulaIngredient[];
  expectedNutrition: TExpectedNutrition;
  estimatedDailyCost: number;
  breakdown: TBreakdownLine[];
  totals: { asFedKg: number; percentage: number };
  warnings: string[];
};

/**
 * Pure calculation from ingredient master data (no DB access, no validation of
 * lifecycle). Used both when saving and when re-pricing a stored formula.
 *  - dryMatter     = Σ asFedKg × DM% / 100                 (kg DM/day)
 *  - crudeProtein  = Σ (DMkg × CP%) / Σ DMkg               (% of DM)
 *  - energy        = Σ (DMkg × Mcal/kg) / Σ DMkg           (Mcal/kg DM)
 *  - cost          = Σ quantity (in the ingredient's unit) × pricePerUnit
 * Countable lines (piece) are priced but excluded from mass-based nutrition.
 */
const calculateComposition = (
  lines: { master: TIngredientMaster; percentage: number; quantity: number; unit: string }[],
): Omit<TComposition, "ingredients"> => {
  const warnings: string[] = [];
  let totalDm = 0;
  let proteinDm = 0;
  let energyDm = 0;
  let totalAsFed = 0;
  let totalCost = 0;
  let totalPercentage = 0;

  const breakdown = lines.map(({ master, percentage, quantity, unit }) => {
    const asFedKg = toKilograms(quantity, unit);
    const dryMatterKg = asFedKg === null ? null : (asFedKg * master.dryMatterPercentage) / 100;
    if (asFedKg !== null && dryMatterKg !== null) {
      totalAsFed += asFedKg;
      totalDm += dryMatterKg;
      proteinDm += dryMatterKg * master.crudeProtein;
      energyDm += dryMatterKg * master.energy;
    } else {
      warnings.push(`${master.ingredientName} is counted in pieces and is excluded from nutrition totals.`);
    }
    const estimatedCost = convertQuantity(quantity, unit, master.unit) * master.pricePerUnit;
    totalCost += estimatedCost;
    totalPercentage += percentage;

    return {
      ingredientId: master._id,
      ingredientCode: master.ingredientCode,
      ingredientName: master.ingredientName,
      category: master.category,
      percentage,
      quantity,
      unit,
      asFedKg: asFedKg === null ? null : round(asFedKg),
      dryMatterKg: dryMatterKg === null ? null : round(dryMatterKg),
      pricePerUnit: master.pricePerUnit,
      ingredientUnit: master.unit,
      estimatedCost: round(estimatedCost, 2),
      isAvailable: master.isAvailable,
      isActive: master.isActive,
    };
  });

  return {
    expectedNutrition: {
      dryMatter: round(totalDm),
      crudeProtein: totalDm > 0 ? round(proteinDm / totalDm, 2) : 0,
      energy: totalDm > 0 ? round(energyDm / totalDm, 3) : 0,
    },
    estimatedDailyCost: round(totalCost, 2),
    breakdown,
    totals: { asFedKg: round(totalAsFed), percentage: round(totalPercentage, 2) },
    warnings,
  };
};

/**
 * Validates a new/changed composition against the FeedIngredient master and the
 * formulation basis, then calculates nutrition and cost.
 * Rules: ingredients exist, are active and available, no duplicates, units
 * compatible with the ingredient's unit, quantity > 0, percentages either all
 * given or all derived from the quantity shares, sum = 100, and (when every line
 * has a mass) each percentage agrees with its quantity share.
 */
const buildComposition = async (rawLines: unknown): Promise<TComposition> => {
  const inputs = parseIngredientLines(rawLines);

  const ids = inputs.filter((l) => isValidObjectId(l.ref)).map((l) => new Types.ObjectId(l.ref));
  const codes = inputs.filter((l) => !isValidObjectId(l.ref)).map((l) => l.ref.toUpperCase());
  const masters = await FeedIngredientModel.find({
    $or: [{ _id: { $in: ids } }, { ingredientCode: { $in: codes } }],
  })
    .select(INGREDIENT_CALC_FIELDS)
    .lean<TIngredientMaster[]>();

  const byId = new Map(masters.map((m) => [String(m._id), m]));
  const byCode = new Map(masters.map((m) => [m.ingredientCode, m]));

  const seen = new Set<string>();
  const resolved = inputs.map((line, index) => {
    const label = `ingredients[${index}]`;
    const master = isValidObjectId(line.ref) ? byId.get(line.ref) : byCode.get(line.ref.toUpperCase());
    if (!master) throw new AppError(status.BAD_REQUEST, `${label}: feed ingredient "${line.ref}" not found!`);
    if (!master.isActive) {
      throw new AppError(status.BAD_REQUEST, `${master.ingredientName} is retired and cannot be used in a formula!`);
    }
    if (!master.isAvailable) {
      throw new AppError(
        status.BAD_REQUEST,
        `${master.ingredientName} is currently unavailable and cannot be used in a new formula!`,
      );
    }
    const key = String(master._id);
    if (seen.has(key)) {
      throw new AppError(
        status.BAD_REQUEST,
        `${master.ingredientName} appears more than once; combine it into a single line!`,
      );
    }
    seen.add(key);

    const unit = line.unit ?? master.unit;
    if (!unitsCompatible(unit, master.unit)) {
      throw new AppError(
        status.BAD_REQUEST,
        `${label}: unit "${unit}" is not compatible with ${master.ingredientName}'s unit "${master.unit}"!`,
      );
    }
    return { master, quantity: line.quantity, unit, percentage: line.percentage };
  });

  //percentage basis = share of the total as-fed mix
  const withPercentage = resolved.filter((l) => l.percentage !== undefined).length;
  if (withPercentage !== 0 && withPercentage !== resolved.length) {
    throw new AppError(
      status.BAD_REQUEST,
      "Give a percentage for every ingredient, or omit all of them to derive them from the quantities!",
    );
  }

  const masses = resolved.map((l) => toKilograms(l.quantity, l.unit));
  const allMass = masses.every((m) => m !== null);
  const totalMass = masses.reduce<number>((sum, m) => sum + (m ?? 0), 0);

  let percentages: number[];
  if (withPercentage === 0) {
    if (!allMass || totalMass <= 0) {
      throw new AppError(
        status.BAD_REQUEST,
        "Percentages are required when an ingredient is measured in pieces!",
      );
    }
    percentages = masses.map((m) => round(((m ?? 0) / totalMass) * 100, 2));
    //absorb rounding drift into the largest line so the sum is exactly 100
    const drift = round(PERCENTAGE_TOTAL - percentages.reduce((s, p) => s + p, 0), 2);
    if (drift !== 0) {
      const largest = percentages.indexOf(Math.max(...percentages));
      percentages[largest] = round((percentages[largest] ?? 0) + drift, 2);
    }
  } else {
    percentages = resolved.map((l) => l.percentage as number);
    const sum = percentages.reduce((s, p) => s + p, 0);
    if (Math.abs(sum - PERCENTAGE_TOTAL) > PERCENTAGE_SUM_TOLERANCE) {
      throw new AppError(
        status.BAD_REQUEST,
        `Ingredient percentages must sum to ${PERCENTAGE_TOTAL}% (currently ${round(sum, 2)}%)!`,
      );
    }
    if (allMass && totalMass > 0) {
      resolved.forEach((line, index) => {
        const share = ((masses[index] ?? 0) / totalMass) * 100;
        const stated = percentages[index] ?? 0;
        if (Math.abs(share - stated) > PERCENTAGE_QUANTITY_TOLERANCE) {
          throw new AppError(
            status.BAD_REQUEST,
            `${line.master.ingredientName}: percentage ${stated}% does not match its quantity share of the mix (${round(share, 2)}%)!`,
          );
        }
      });
    }
  }

  const lines = resolved.map((line, index) => ({
    master: line.master,
    percentage: percentages[index] ?? 0,
    quantity: line.quantity,
    unit: line.unit,
  }));
  const calculation = calculateComposition(lines);

  return {
    ingredients: lines.map((line) => ({
      ingredientId: line.master._id,
      percentage: line.percentage,
      quantity: line.quantity,
      unit: line.unit as TFormulaIngredient["unit"],
    })),
    ...calculation,
  };
};

//re-prices a stored formula with the current master data (detail / match views)
const currentMetrics = (formula: { ingredients: TFormulaIngredient[] }, masters: TIngredientMaster[]) => {
  const byId = new Map(masters.map((m) => [String(m._id), m]));
  const lines: Parameters<typeof calculateComposition>[0] = [];
  const warnings: string[] = [];
  for (const line of formula.ingredients) {
    const master = byId.get(String(line.ingredientId));
    if (!master) {
      warnings.push(`Ingredient ${String(line.ingredientId)} no longer exists in the catalog.`);
      continue;
    }
    if (!master.isActive) warnings.push(`${master.ingredientName} is retired from the ingredient catalog.`);
    else if (!master.isAvailable) warnings.push(`${master.ingredientName} is currently unavailable.`);
    lines.push({ master, percentage: line.percentage, quantity: line.quantity, unit: line.unit });
  }
  const calculation = calculateComposition(lines);
  return { ...calculation, warnings: [...warnings, ...calculation.warnings] };
};

/* ------------------------------------------------------------------ */
/* Actor / authorization helpers                                       */
/* ------------------------------------------------------------------ */

type TActor = { _id: Types.ObjectId; systemRole: string };

//re-reads the account from the DB (never trusts the token role)
const getActor = async (actorUserId?: string): Promise<TActor> => {
  const user = actorUserId
    ? await UserModel.findOne({ userId: actorUserId, isActive: true, isDeleted: { $ne: true } })
        .select("_id systemRole")
        .lean()
    : null;
  if (!user) throw new AppError(status.FORBIDDEN, "You're not authorized!");
  return { _id: user._id as Types.ObjectId, systemRole: String(user.systemRole) };
};

const isPlatformAdmin = (role?: string) =>
  role === SystemRoles.ADMIN || role === SystemRoles.SUPER_ADMIN;

/* ------------------------------------------------------------------ */
/* Integrity helpers                                                   */
/* ------------------------------------------------------------------ */

const findFormulaByRef = async (ref: string): Promise<TFormulaDoc> => {
  const value = String(ref ?? "").trim();
  if (!value) throw new AppError(status.BAD_REQUEST, "Formula id or code is required!");
  const formula = isValidObjectId(value)
    ? await FeedFormulaModel.findById(value)
    : await FeedFormulaModel.findOne({ formulaCode: value.toUpperCase() });
  if (!formula) throw new AppError(status.NOT_FOUND, "Feed formula not found!");
  return formula;
};

//"Breed must be active to create a feed formula"
const assertActiveBreed = async (breedId: Types.ObjectId) => {
  const breed = await BreedModel.findById(breedId).select("breedName isActive").lean();
  if (!breed) throw new AppError(status.BAD_REQUEST, "Breed not found!");
  if (!breed.isActive) {
    throw new AppError(status.BAD_REQUEST, `${breed.breedName} is inactive; feed formulas need an active breed!`);
  }
};

type TContext = { breedId: Types.ObjectId; stage: string; purpose: string; season: string };

const contextOf = (formula: TContext): TContext => ({
  breedId: formula.breedId,
  stage: formula.stage,
  purpose: formula.purpose,
  season: formula.season,
});

//same context + same name + same ruleVersion would be indistinguishable in reports
const assertUniqueVersion = async (
  context: TContext,
  formulaName: string,
  ruleVersion: string,
  excludeId?: Types.ObjectId,
) => {
  const existing = await FeedFormulaModel.findOne({
    ...context,
    formulaName,
    ruleVersion,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  } as TFormulaFilter)
    .collation({ locale: "en", strength: 2 })
    .select("formulaCode")
    .lean();
  if (existing) {
    throw new AppError(
      status.CONFLICT,
      `"${formulaName}" ${ruleVersion} already exists for this context (${existing.formulaCode}); use a new ruleVersion!`,
    );
  }
};

const isDuplicateKey = (error: unknown, field?: string) => {
  if (typeof error !== "object" || error === null || (error as { code?: number }).code !== 11000) return false;
  if (!field) return true;
  const keyValue = (error as { keyValue?: Record<string, unknown> }).keyValue ?? {};
  return Object.keys(keyValue)[0] === field;
};

const countFormulaUsage = async (formulaId: Types.ObjectId): Promise<TFormulaUsage> => {
  const db = mongoose.connection.db;
  const counts = await Promise.all(
    FEED_FORMULA_REFERENCE_SOURCES.map(async (source) => {
      if (!db) return 0;
      try {
        return await db.collection(source.collection).countDocuments({ [source.path]: formulaId });
      } catch {
        return 0;
      }
    }),
  );
  const usage: TFormulaUsage = { feedRecommendations: 0, total: 0 };
  FEED_FORMULA_REFERENCE_SOURCES.forEach((source, index) => {
    const count = counts[index] ?? 0;
    usage[source.key] = count;
    usage.total += count;
  });
  return usage;
};

//plain snapshot for audit oldData/newData (ObjectIds/Dates become strings)
const snapshot = (doc: TFormulaDoc | null, fields?: readonly string[]) => {
  if (!doc) return null;
  const plain = JSON.parse(JSON.stringify(doc.toObject())) as Record<string, unknown>;
  delete plain.__v;
  if (!fields) return plain;
  return Object.fromEntries(fields.map((field) => [field, plain[field] ?? null]));
};

const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

//normalized ingredient lines for change detection (order-sensitive on purpose)
const ingredientSignature = (lines: TFormulaIngredient[]) =>
  lines.map((l) => ({
    ingredientId: String(l.ingredientId),
    percentage: l.percentage,
    quantity: l.quantity,
    unit: l.unit,
  }));

const audit = (
  context: TAuditContext,
  formulaId: Types.ObjectId,
  action: (typeof AuditActions)[keyof typeof AuditActions],
  event: string,
  data: { oldData?: Record<string, unknown> | null; newData?: Record<string, unknown> | null; changedFields?: string[] } = {},
) =>
  recordAuditLog({
    context,
    entityType: AuditEntityTypes.FEED_FORMULA,
    entityId: formulaId,
    action,
    module: AuditModules.FEED,
    event,
    ...data,
  });

/**
 * Makes `formula` the only active default for its exact context.
 * Competitors are unset first, then the target is set; the partial unique index
 * (unique_active_default_per_context) rejects a concurrent race with 409.
 */
const promoteToDefault = async (formula: TFormulaDoc, actorId: Types.ObjectId, context: TAuditContext) => {
  const competitors = await FeedFormulaModel.find({
    ...contextOf(formula),
    _id: { $ne: formula._id },
    isDefault: true,
  } as TFormulaFilter)
    .select("_id formulaCode")
    .lean();

  if (competitors.length) {
    await FeedFormulaModel.updateMany(
      { _id: { $in: competitors.map((c) => c._id) } },
      { $set: { isDefault: false, updatedBy: actorId } },
    );
    await Promise.all(
      competitors.map((c) =>
        audit(context, c._id as Types.ObjectId, AuditActions.UPDATE, "Formula Removed as Default", {
          oldData: { isDefault: true },
          newData: { isDefault: false, replacedBy: formula.formulaCode },
          changedFields: ["isDefault"],
        }),
      ),
    );
  }

  let updated: TFormulaDoc | null;
  try {
    updated = await FeedFormulaModel.findByIdAndUpdate(
      formula._id,
      { $set: { isDefault: true, updatedBy: actorId } },
      { returnDocument: "after", runValidators: true },
    );
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError(status.CONFLICT, "Another default was set for this context at the same time, please retry!");
    }
    throw error;
  }
  if (!updated) throw new AppError(status.NOT_FOUND, "Feed formula not found!");

  await audit(context, updated._id, AuditActions.UPDATE, "Formula Made Default", {
    oldData: { isDefault: false },
    newData: { isDefault: true, replaced: competitors.map((c) => c.formulaCode) },
    changedFields: ["isDefault"],
  });
  return updated;
};

//inserts with a generated FF-000001 code, retrying when two creations race
const insertFormula = async (data: Omit<TFeedFormula, "formulaCode">): Promise<TFormulaDoc> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const formulaCode = await generateFormulaCode();
    try {
      return await FeedFormulaModel.create({ ...data, formulaCode });
    } catch (error) {
      if (isDuplicateKey(error, "formulaCode") && attempt < 2) continue;
      if (isDuplicateKey(error)) throw new AppError(status.CONFLICT, "Formula code already exists, please retry!");
      throw error;
    }
  }
  throw new AppError(status.CONFLICT, "Could not generate a formula code, please retry!");
};

/* ------------------------------------------------------------------ */
/* Scientific field parsing (create / update / clone)                  */
/* ------------------------------------------------------------------ */

type TScientificInput = {
  breedId?: Types.ObjectId;
  stage?: string;
  purpose?: string;
  season?: string;
  targetWeightRange?: TRange | null; //null = clear
  targetMilkYield?: TRange | null;
  targetADG?: number | null;
  ingredients?: unknown; //raw lines, validated by buildComposition
  ruleVersion?: string;
};

const parseScientific = (payload: TPayload, allowClear: boolean): TScientificInput => {
  const result: TScientificInput = {};
  if (payload.breedId !== undefined) result.breedId = parseObjectId("breedId", payload.breedId);
  if (payload.stage !== undefined) result.stage = parseEnum("stage", payload.stage, STAGES);
  if (payload.purpose !== undefined) result.purpose = parseEnum("purpose", payload.purpose, PURPOSES);
  if (payload.season !== undefined) result.season = parseEnum("season", payload.season, SEASONS);

  for (const field of ["targetWeightRange", "targetMilkYield"] as const) {
    const value = payload[field];
    if (value === undefined) continue;
    if (isBlank(value)) {
      if (allowClear) result[field] = null;
      continue;
    }
    result[field] = parseRange(field, value);
  }
  if (payload.targetADG !== undefined) {
    if (isBlank(payload.targetADG)) {
      if (allowClear) result.targetADG = null;
    } else {
      result.targetADG = parseNumber("targetADG", payload.targetADG);
    }
  }
  if (payload.ingredients !== undefined) result.ingredients = payload.ingredients;
  if (payload.ruleVersion !== undefined) result.ruleVersion = parseRuleVersion(payload.ruleVersion);
  return result;
};

//merges stored values with parsed overrides into a complete formula body
const mergeFormula = (
  source: TFeedFormula,
  overrides: TScientificInput,
  composition: TComposition | null,
) => {
  const merged: Record<string, unknown> = {
    breedId: overrides.breedId ?? source.breedId,
    stage: overrides.stage ?? source.stage,
    purpose: overrides.purpose ?? source.purpose,
    season: overrides.season ?? source.season,
  };
  for (const field of ["targetWeightRange", "targetMilkYield", "targetADG"] as const) {
    const override = overrides[field];
    if (override === null) continue; //cleared
    const value = override !== undefined ? override : source[field];
    if (value !== undefined) merged[field] = value;
  }
  if (composition) {
    merged.ingredients = composition.ingredients;
    merged.expectedNutrition = composition.expectedNutrition;
    merged.estimatedDailyCost = composition.estimatedDailyCost;
  } else {
    merged.ingredients = source.ingredients;
    merged.expectedNutrition = source.expectedNutrition;
    merged.estimatedDailyCost = source.estimatedDailyCost;
  }
  return merged;
};

//stored ingredient lines re-validated as if newly entered (versions / reactivation)
const linesForRevalidation = (lines: TFormulaIngredient[]) =>
  lines.map((l) => ({
    ingredientId: String(l.ingredientId),
    percentage: l.percentage,
    quantity: l.quantity,
    unit: l.unit,
  }));

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

/**
 * Full specification: populated breed / ingredients / actors, the stored
 * (save-time) nutrition and cost, plus `currentMetrics` re-priced with today's
 * ingredient prices and warnings for retired/unavailable ingredients.
 */
const getFormula = async (ref: string) => {
  const formula = await findFormulaByRef(ref);
  const populated = await FeedFormulaModel.findById(formula._id)
    .select("-__v")
    .populate("breedId", BREED_PUBLIC_FIELDS)
    .populate("ingredients.ingredientId", INGREDIENT_CALC_FIELDS)
    .populate("createdBy", USER_PUBLIC_FIELDS)
    .populate("updatedBy", USER_PUBLIC_FIELDS)
    .lean();
  if (!populated) throw new AppError(status.NOT_FOUND, "Feed formula not found!");

  //populated ingredient docs double as master data for re-pricing
  const masters = populated.ingredients
    .map((l) => l.ingredientId as unknown as TIngredientMaster | null)
    .filter((m): m is TIngredientMaster => !!m && typeof m === "object" && "ingredientCode" in m);
  const plainLines = populated.ingredients.map((l) => ({
    ...l,
    ingredientId: ((l.ingredientId as unknown as TIngredientMaster | null)?._id ?? l.ingredientId) as Types.ObjectId,
  }));
  const metrics = currentMetrics({ ingredients: plainLines }, masters);

  return {
    ...populated,
    nutritionUnits: FeedFormulaNutritionUnits,
    currentMetrics: {
      expectedNutrition: metrics.expectedNutrition,
      estimatedDailyCost: metrics.estimatedDailyCost,
      costDifference: round(metrics.estimatedDailyCost - populated.estimatedDailyCost, 2),
      breakdown: metrics.breakdown,
      totals: metrics.totals,
    },
    warnings: metrics.warnings,
  };
};

const parseListFilter = (query: TPayload, isAdmin: boolean) => {
  const filter: Record<string, unknown> = {};

  for (const [field, allowed] of [
    ["stage", STAGES],
    ["purpose", PURPOSES],
    ["season", SEASONS],
  ] as const) {
    const raw = query[field];
    if (typeof raw === "string" && raw.trim()) {
      //comma-separated multi-select; unknown values are ignored
      const values = raw
        .split(",")
        .map((v) => v.trim())
        .filter((v) => allowed.includes(v));
      if (values.length) filter[field] = values.length === 1 ? values[0] : { $in: values };
    }
  }

  if (typeof query.breedId === "string" && isValidObjectId(query.breedId)) {
    filter.breedId = new Types.ObjectId(query.breedId);
  }
  if (typeof query.ingredientId === "string" && isValidObjectId(query.ingredientId)) {
    filter["ingredients.ingredientId"] = new Types.ObjectId(query.ingredientId);
  }
  if (typeof query.ruleVersion === "string" && RULE_VERSION_PATTERN.test(query.ruleVersion.trim())) {
    filter.ruleVersion = query.ruleVersion.trim();
  }
  const isDefault = parseBoolean(query.isDefault);
  if (isDefault !== undefined) filter.isDefault = isDefault;

  //routine selection sees active formulas only; inactive history is admin/audit only
  if (!isAdmin) {
    filter.isActive = true;
  } else if (String(query.isActive).toLowerCase() !== "all") {
    filter.isActive = parseBoolean(query.isActive) ?? true;
  }

  const cost: Record<string, number> = {};
  const minCost = Number(query.minCost);
  const maxCost = Number(query.maxCost);
  if (query.minCost !== undefined && Number.isFinite(minCost)) cost.$gte = minCost;
  if (query.maxCost !== undefined && Number.isFinite(maxCost)) cost.$lte = maxCost;
  if (Object.keys(cost).length) filter.estimatedDailyCost = cost;

  return filter;
};

const getAllFormulas = async (query: TPayload, actorUserId?: string) => {
  const actor = await getActor(actorUserId);
  const filter = parseListFilter(query, isPlatformAdmin(actor.systemRole));

  const listQuery: TPayload = {};
  if (typeof query.searchTerm === "string" && query.searchTerm.trim()) {
    //QueryBuilder interpolates this straight into $regex
    listQuery.searchTerm = escapeRegex(query.searchTerm.trim().slice(0, 100));
  }
  const sortTokens = String(query.sort ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => SORT_FIELDS.has(token.replace(/^-/, "")));
  listQuery.sort = sortTokens.length ? sortTokens.join(",") : "-createdAt";
  listQuery.page = Math.max(Number(query.page) || 1, 1);
  listQuery.limit = Math.min(Math.max(Number(query.limit) || 10, 1), 100);
  if (typeof query.fields === "string" && query.fields.trim()) {
    listQuery.fields = query.fields
      .split(",")
      .map((f) => f.trim())
      .filter((f) => /^-?[A-Za-z.]+$/.test(f))
      .join(",");
  }

  const formulaQuery = new QueryBuilder<TFeedFormula>(
    FeedFormulaModel.find(filter).populate("breedId", "breedCode breedName"),
    listQuery,
  )
    .search(["formulaCode", "formulaName"])
    .filter()
    .sort()
    .paginate()
    .fields();

  const [meta, formulas] = await Promise.all([formulaQuery.countTotal(), formulaQuery.modelQuery]);
  return { meta, formulas };
};

//slim active list for selectors (manual formula selection, recommendation UI)
const getFormulaLookup = async (query: TPayload) => {
  const filter: Record<string, unknown> = { isActive: true };
  if (typeof query.breedId === "string" && isValidObjectId(query.breedId)) {
    filter.breedId = new Types.ObjectId(query.breedId);
  }
  if (typeof query.stage === "string" && STAGES.includes(query.stage)) filter.stage = query.stage;
  if (typeof query.purpose === "string" && PURPOSES.includes(query.purpose)) filter.purpose = query.purpose;
  if (typeof query.season === "string" && SEASONS.includes(query.season)) {
    filter.season = { $in: [...new Set([query.season, FeedFormulaSeasons.ALL_SEASON])] };
  }
  const searchTerm = typeof query.searchTerm === "string" ? query.searchTerm.trim() : "";
  if (searchTerm) {
    const regex = new RegExp(escapeRegex(searchTerm.slice(0, 100)), "i");
    filter.$or = [{ formulaName: regex }, { formulaCode: regex }];
  }
  return FeedFormulaModel.find(filter)
    .select(LOOKUP_FIELDS)
    .populate("breedId", "breedCode breedName")
    .sort({ isDefault: -1, formulaName: 1 })
    .limit(200)
    .lean();
};

const getFormulaMeta = () => ({
  stages: STAGES,
  purposes: PURPOSES,
  seasons: SEASONS,
  units: UNITS,
  unitConversions: UnitConversions,
  nutritionUnits: FeedFormulaNutritionUnits,
  formulationBasis: {
    percentage: "Share of the total as-fed mix (%). All ingredient percentages of one formula sum to 100.",
    quantity: "Prescribed amount per animal per day, in the line's unit.",
    percentageSumTolerance: PERCENTAGE_SUM_TOLERANCE,
    percentageQuantityTolerance: PERCENTAGE_QUANTITY_TOLERANCE,
    volumeDensityAssumption: "1 kg per liter",
  },
  seasonCalendar: { Summer: "Mar–Jun", Rainy: "Jul–Oct", Winter: "Nov–Feb" },
  maxIngredients: MAX_FORMULA_INGREDIENTS,
  currency: "BDT",
});

const countBy = (field: string) =>
  FeedFormulaModel.aggregate<{ _id: string; count: number }>([
    { $match: { isActive: true } },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
  ]);

const getFormulaStats = async () => {
  const [summaryRows, byStage, byPurpose, bySeason] = await Promise.all([
    FeedFormulaModel.aggregate<{ total: number; active: number; retired: number; defaults: number; avgCost: number }>([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: ["$isActive", 1, 0] } },
          retired: { $sum: { $cond: ["$isActive", 0, 1] } },
          defaults: { $sum: { $cond: [{ $and: ["$isActive", "$isDefault"] }, 1, 0] } },
          avgCost: { $avg: { $cond: ["$isActive", "$estimatedDailyCost", null] } },
        },
      },
    ]),
    countBy("stage"),
    countBy("purpose"),
    countBy("season"),
  ]);
  const summary = summaryRows[0] ?? { total: 0, active: 0, retired: 0, defaults: 0, avgCost: 0 };
  //every enum value present (0 included), in enum order; active formulas only
  const expand = (rows: { _id: string; count: number }[], values: string[]) => {
    const map = new Map(rows.map((r) => [r._id, r.count]));
    return values.map((value) => ({ value, count: map.get(value) ?? 0 }));
  };
  return {
    total: summary.total,
    active: summary.active,
    retired: summary.retired,
    defaults: summary.defaults,
    avgEstimatedDailyCost: round(summary.avgCost ?? 0, 2),
    byStage: expand(byStage, STAGES),
    byPurpose: expand(byPurpose, PURPOSES),
    bySeason: expand(bySeason, SEASONS),
  };
};

//version family = every formula with the same exact context, newest rule first
const getFormulaVersions = async (ref: string, actorUserId?: string) => {
  const actor = await getActor(actorUserId);
  const formula = await findFormulaByRef(ref);
  const versions = await FeedFormulaModel.find({
    ...contextOf(formula),
    ...(isPlatformAdmin(actor.systemRole) ? {} : { $or: [{ isActive: true }, { _id: formula._id }] }),
  } as TFormulaFilter)
    .select(`${LOOKUP_FIELDS} createdAt updatedAt`)
    .populate("createdBy", USER_PUBLIC_FIELDS)
    .lean();
  versions.sort(
    (a, b) =>
      compareRuleVersions(b.ruleVersion, a.ruleVersion) ||
      new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
  );
  return { context: contextOf(formula), current: formula._id, versions };
};

const getFormulaUsage = async (ref: string) => {
  const formula = await findFormulaByRef(ref);
  const usage = await countFormulaUsage(formula._id);
  return {
    _id: formula._id,
    formulaCode: formula.formulaCode,
    formulaName: formula.formulaName,
    usage,
    canHardDelete: usage.total === 0,
    //scientific edits on a used formula always create a new version
    scientificEditMode: usage.total === 0 ? "in-place" : "new-version",
  };
};

const getFormulaAuditLogs = async (ref: string, query: TPayload) => {
  const formula = await findFormulaByRef(ref);
  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
  const filter = { entityType: AuditEntityTypes.FEED_FORMULA, entityId: formula._id };
  const [total, logs] = await Promise.all([
    AuditLogModel.countDocuments(filter),
    AuditLogModel.find(filter)
      .select("-__v -ipAddress -userAgent -browser -operatingSystem -location")
      .populate("userId", "userId fullName systemRole")
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
  ]);
  return { meta: { page, limit, totalEntries: total, totalPage: Math.ceil(total / limit) }, logs };
};

//dry run for the formula builder: validates + calculates without saving
const previewComposition = async (payload: TPayload) => {
  const composition = await buildComposition((payload ?? {}).ingredients);
  return {
    ingredients: composition.ingredients,
    expectedNutrition: composition.expectedNutrition,
    estimatedDailyCost: composition.estimatedDailyCost,
    breakdown: composition.breakdown,
    totals: composition.totals,
    warnings: composition.warnings,
    nutritionUnits: FeedFormulaNutritionUnits,
  };
};

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

type TMatchCandidate = {
  formula: Record<string, unknown>;
  score: number;
  explanation: string[];
  warnings: string[];
};

const inRange = (value: number, range?: TRange) =>
  !range ||
  ((range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max));

const hasRange = (range?: TRange) => !!range && (range.min !== undefined || range.max !== undefined);

const rangeLabel = (range: TRange, unit: string) =>
  `${range.min ?? "…"}–${range.max ?? "…"} ${unit}`;

/**
 * Deterministic formula selection for an animal context.
 * Hard filters: active, exact breed/stage/purpose, season = requested or
 * "All Season", weight / milk yield inside the formula's target range (when both
 * sides are known). Score: exact season 30 / All Season 15; weight in range 25 /
 * formula without range 10; milk in range 25 / no range 10; ADG closeness up to 10.
 * Ties: score → isDefault → newest ruleVersion → latest update. An unresolved tie
 * between non-default formulas is reported as ambiguous (manual selection), and
 * no match returns a warning — the engine never fabricates a plan.
 */
const matchFormulas = async (payload: TPayload, actorUserId?: string) => {
  const body = payload ?? {};
  const actor = await getActor(actorUserId);
  const warnings: string[] = [];

  //--- access: farm members (of the given farm, or of any farm) and platform admins
  const farmRef = typeof body.farmId === "string" ? body.farmId.trim() : "";
  let farmObjectId: Types.ObjectId | null = null;
  if (farmRef) {
    const access = await FarmMemberServices.resolveFarmAccess(farmRef, actorUserId as string);
    farmObjectId = access.farm._id as Types.ObjectId;
  } else if (!isPlatformAdmin(actor.systemRole)) {
    const membership = await FarmMemberModel.exists({ userId: actor._id, isActive: true });
    if (!membership) {
      throw new AppError(status.FORBIDDEN, "Only farm members or platform admins can match feed formulas!");
    }
  }

  //--- context: explicit fields win over values derived from the animal
  let breedId = body.breedId !== undefined ? parseObjectId("breedId", body.breedId) : undefined;
  let stage = body.stage !== undefined ? parseEnum("stage", body.stage, STAGES) : undefined;
  let purpose = body.purpose !== undefined ? parseEnum("purpose", body.purpose, PURPOSES) : undefined;
  let weight = body.weight !== undefined ? parseNumber("weight", body.weight) : undefined;
  const milkYield = body.milkYield !== undefined ? parseNumber("milkYield", body.milkYield) : undefined;
  const targetADG = body.targetADG !== undefined ? parseNumber("targetADG", body.targetADG) : undefined;
  let animalSummary: Record<string, unknown> | null = null;

  if (body.animalId !== undefined) {
    if (!farmObjectId) throw new AppError(status.BAD_REQUEST, "farmId is required when matching by animalId!");
    const animalId = parseObjectId("animalId", body.animalId);
    const animal = await AnimalModel.findOne({ _id: animalId, farmId: farmObjectId })
      .select("animalCode name breedId purpose reproductiveStatus currentWeight lifeStatus isActive")
      .lean();
    if (!animal) throw new AppError(status.NOT_FOUND, "Animal not found in this farm!");
    if (animal.lifeStatus !== "Active" || !animal.isActive) {
      warnings.push(`Animal ${animal.animalCode} is not active (${animal.lifeStatus}).`);
    }
    breedId ??= animal.breedId as Types.ObjectId;
    stage ??= REPRODUCTIVE_STATUS_TO_STAGE[animal.reproductiveStatus];
    purpose ??= ANIMAL_PURPOSE_TO_FORMULA_PURPOSE[animal.purpose];
    if (weight === undefined && typeof animal.currentWeight === "number") weight = animal.currentWeight;
    animalSummary = {
      _id: animal._id,
      animalCode: animal.animalCode,
      name: animal.name,
      reproductiveStatus: animal.reproductiveStatus,
      purpose: animal.purpose,
      currentWeight: animal.currentWeight,
    };
  }

  if (!breedId) throw new AppError(status.BAD_REQUEST, "breedId is required (or an animalId to derive it)!");
  if (!stage) {
    throw new AppError(status.BAD_REQUEST, `stage is required (one of: ${STAGES.join(", ")})!`);
  }
  if (!purpose) {
    throw new AppError(status.BAD_REQUEST, `purpose is required (one of: ${PURPOSES.join(", ")})!`);
  }
  let seasonSource: "request" | "derived" = "request";
  let season: string;
  if (body.season !== undefined) {
    season = parseEnum("season", body.season, SEASONS);
  } else {
    season = seasonForMonth(new Date().getMonth());
    seasonSource = "derived";
  }
  const limit = Math.min(Math.max(Number(body.limit) || 5, 1), 20);

  const breed = await BreedModel.findById(breedId).select(BREED_PUBLIC_FIELDS).lean();
  if (!breed) throw new AppError(status.BAD_REQUEST, "Breed not found!");

  const seasons = [...new Set([season, FeedFormulaSeasons.ALL_SEASON])];
  const formulas = await FeedFormulaModel.find({
    isActive: true,
    breedId,
    stage,
    purpose,
    season: { $in: seasons },
  } as TFormulaFilter)
    .select("-__v")
    .populate("ingredients.ingredientId", INGREDIENT_CALC_FIELDS)
    .lean();

  const excluded = { outOfWeightRange: 0, outOfMilkYieldRange: 0 };
  const candidates: (TMatchCandidate & { isDefault: boolean; ruleVersion: string; updatedAt: number })[] = [];

  for (const formula of formulas) {
    const explanation = [`Breed ${breed.breedName}`, `${stage} stage`, `${purpose} purpose`];
    const candidateWarnings: string[] = [];
    let score = 0;

    if (formula.season === season) {
      score += 30;
      explanation.push(`${season} formula applied`);
    } else {
      score += 15;
      explanation.push("All Season formula applied (no season-specific match required)");
    }

    if (weight !== undefined && hasRange(formula.targetWeightRange)) {
      if (!inRange(weight, formula.targetWeightRange)) {
        excluded.outOfWeightRange++;
        continue;
      }
      score += 25;
      explanation.push(`Weight ${weight} kg is within ${rangeLabel(formula.targetWeightRange as TRange, "kg")}`);
    } else if (hasRange(formula.targetWeightRange)) {
      candidateWarnings.push("Animal weight not provided; target weight range was not checked.");
    } else {
      score += 10;
    }

    if (milkYield !== undefined && hasRange(formula.targetMilkYield)) {
      if (!inRange(milkYield, formula.targetMilkYield)) {
        excluded.outOfMilkYieldRange++;
        continue;
      }
      score += 25;
      explanation.push(`Milk yield ${milkYield} L/day is within ${rangeLabel(formula.targetMilkYield as TRange, "L/day")}`);
    } else if (hasRange(formula.targetMilkYield)) {
      candidateWarnings.push("Milk yield not provided; target milk yield range was not checked.");
    } else {
      score += 10;
    }

    if (targetADG !== undefined && typeof formula.targetADG === "number") {
      const diff = Math.abs(targetADG - formula.targetADG);
      score += Math.max(0, round(10 - diff * 20, 2)); //0.5 kg/day off → 0
      explanation.push(`Target ADG ${formula.targetADG} kg/day (requested ${targetADG})`);
    }

    const masters = formula.ingredients
      .map((l) => l.ingredientId as unknown as TIngredientMaster | null)
      .filter((m): m is TIngredientMaster => !!m && typeof m === "object" && "ingredientCode" in m);
    const plainLines = formula.ingredients.map((l) => ({
      ...l,
      ingredientId: ((l.ingredientId as unknown as TIngredientMaster | null)?._id ?? l.ingredientId) as Types.ObjectId,
    }));
    const metrics = currentMetrics({ ingredients: plainLines }, masters);
    candidateWarnings.push(...metrics.warnings);
    if (formula.isDefault) explanation.push("Default formula for this context");

    candidates.push({
      formula: {
        ...formula,
        currentEstimatedDailyCost: metrics.estimatedDailyCost,
      },
      score: round(score, 2),
      explanation,
      warnings: candidateWarnings,
      isDefault: formula.isDefault,
      ruleVersion: formula.ruleVersion,
      updatedAt: new Date(formula.updatedAt ?? 0).getTime(),
    });
  }

  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.isDefault) - Number(a.isDefault) ||
      compareRuleVersions(b.ruleVersion, a.ruleVersion) ||
      b.updatedAt - a.updatedAt,
  );

  const [top, second] = candidates;
  let bestMatch: TMatchCandidate | null = null;
  let requiresManualSelection = false;
  if (!top) {
    warnings.push(
      "No suitable active formula found for this context. Select a formula manually or request expert review.",
    );
  } else if (
    second &&
    second.score === top.score &&
    !top.isDefault &&
    !second.isDefault
  ) {
    requiresManualSelection = true;
    warnings.push("Multiple formulas match equally well and none is the default; select one manually.");
  } else {
    bestMatch = top;
  }
  if (seasonSource === "derived") warnings.push(`Season not provided; derived "${season}" from the current date.`);

  const strip = ({ formula, score, explanation, warnings: w }: TMatchCandidate) => ({
    formula,
    score,
    explanation,
    warnings: w,
  });

  return {
    context: {
      breed: { _id: breed._id, breedCode: breed.breedCode, breedName: breed.breedName },
      stage,
      purpose,
      season,
      seasonSource,
      weight: weight ?? null,
      milkYield: milkYield ?? null,
      targetADG: targetADG ?? null,
      animal: animalSummary,
    },
    matched: candidates.length > 0,
    bestMatch: bestMatch ? strip(bestMatch) : null,
    requiresManualSelection,
    candidates: candidates.slice(0, limit).map(strip),
    totalCandidates: candidates.length,
    excluded,
    warnings,
  };
};

/* ------------------------------------------------------------------ */
/* Write                                                               */
/* ------------------------------------------------------------------ */

const createFormula = async (payload: TPayload, context: TAuditContext) => {
  const body = payload ?? {};
  const actor = await getActor(context.actorUserId);

  const formulaName = parseFormulaName(body.formulaName);
  const sci = parseScientific(body, false);
  if (!sci.breedId) throw new AppError(status.BAD_REQUEST, "breedId is required!");
  if (!sci.stage) parseEnum("stage", undefined, STAGES);
  if (!sci.purpose) parseEnum("purpose", undefined, PURPOSES);
  if (!sci.season) parseEnum("season", undefined, SEASONS);
  if (!sci.ruleVersion) throw new AppError(status.BAD_REQUEST, "ruleVersion is required (e.g. v1.0)!");
  const isDefault = body.isDefault === undefined ? false : parseBoolean(body.isDefault);
  if (isDefault === undefined) throw new AppError(status.BAD_REQUEST, "isDefault must be a boolean!");

  await assertActiveBreed(sci.breedId);
  const composition = await buildComposition(body.ingredients);
  const formulaContext = {
    breedId: sci.breedId,
    stage: sci.stage as string,
    purpose: sci.purpose as string,
    season: sci.season as string,
  };
  await assertUniqueVersion(formulaContext, formulaName, sci.ruleVersion);

  const data: Record<string, unknown> = {
    formulaName,
    ...formulaContext,
    ingredients: composition.ingredients,
    expectedNutrition: composition.expectedNutrition,
    estimatedDailyCost: composition.estimatedDailyCost,
    ruleVersion: sci.ruleVersion,
    //default is applied after insert so competing defaults are unset first
    isDefault: false,
    isActive: true,
    createdBy: actor._id,
  };
  if (sci.targetWeightRange) data.targetWeightRange = sci.targetWeightRange;
  if (sci.targetMilkYield) data.targetMilkYield = sci.targetMilkYield;
  if (typeof sci.targetADG === "number") data.targetADG = sci.targetADG;
  if (body.description !== undefined && !isBlank(body.description)) {
    data.description = parseDescription(body.description);
  }

  let created = await insertFormula(data as Omit<TFeedFormula, "formulaCode">);
  await audit(context, created._id, AuditActions.CREATE, "Formula Created", { newData: snapshot(created) });
  if (isDefault) created = await promoteToDefault(created, actor._id, context);

  return { formula: created, calculation: { breakdown: composition.breakdown, totals: composition.totals }, warnings: composition.warnings };
};

type TVersionOptions = {
  ruleVersion?: string;
  bump?: "minor" | "major";
  formulaName?: string;
  description?: string | null;
  retirePrevious: boolean;
  makeDefault: boolean;
  event: string;
};

/**
 * Creates a new formula record from `source` + overrides (new FF code, new
 * ruleVersion). The source is never modified scientifically; optionally it is
 * retired and its default flag handed over. FeedRecommendation snapshots keep
 * pointing to the untouched source.
 */
const createVersionFrom = async (
  source: TFormulaDoc,
  sci: TScientificInput,
  options: TVersionOptions,
  actor: TActor,
  context: TAuditContext,
) => {
  const ruleVersion = options.ruleVersion ?? bumpRuleVersion(source.ruleVersion, options.bump);
  if (ruleVersion === source.ruleVersion) {
    throw new AppError(status.BAD_REQUEST, "A new version needs a different ruleVersion than the source formula!");
  }

  //ingredients are always re-validated: a version may not carry retired/unavailable ingredients
  const composition = await buildComposition(sci.ingredients ?? linesForRevalidation(source.ingredients));
  const merged = mergeFormula(source.toObject(), sci, composition);
  const formulaContext = {
    breedId: merged.breedId as Types.ObjectId,
    stage: merged.stage as string,
    purpose: merged.purpose as string,
    season: merged.season as string,
  };
  await assertActiveBreed(formulaContext.breedId);
  const formulaName = options.formulaName ?? source.formulaName;
  await assertUniqueVersion(formulaContext, formulaName, ruleVersion);

  const description = options.description === undefined ? source.description : options.description;
  const data: Record<string, unknown> = {
    ...merged,
    formulaName,
    ruleVersion,
    isDefault: false,
    isActive: true,
    createdBy: actor._id,
  };
  if (description) data.description = description;

  let created = await insertFormula(data as Omit<TFeedFormula, "formulaCode">);
  await audit(context, created._id, AuditActions.CREATE, options.event, {
    newData: { ...snapshot(created), versionOf: source.formulaCode, previousRuleVersion: source.ruleVersion },
  });
  if (ruleVersion !== source.ruleVersion) {
    await audit(context, created._id, AuditActions.UPDATE, "Rule Version Changed", {
      oldData: { formulaCode: source.formulaCode, ruleVersion: source.ruleVersion },
      newData: { formulaCode: created.formulaCode, ruleVersion },
      changedFields: ["ruleVersion"],
    });
  }

  let previous: TFormulaDoc = source;
  const wasDefault = source.isDefault && source.isActive;
  if (options.retirePrevious && source.isActive) {
    const retired = await FeedFormulaModel.findByIdAndUpdate(
      source._id,
      { $set: { isActive: false, isDefault: false, updatedBy: actor._id } },
      { returnDocument: "after", runValidators: true },
    );
    if (retired) previous = retired;
    await audit(context, source._id, AuditActions.ARCHIVE, "Formula Deactivated", {
      oldData: { isActive: true, isDefault: source.isDefault },
      newData: { isActive: false, isDefault: false, supersededBy: created.formulaCode },
      changedFields: source.isDefault ? ["isActive", "isDefault"] : ["isActive"],
    });
  }

  //default follows the new version when it replaces a default in the same context
  const sameContext = sameValue(contextOf(source), formulaContext);
  if (options.makeDefault || (wasDefault && options.retirePrevious && sameContext)) {
    created = await promoteToDefault(created, actor._id, context);
  }

  return { formula: created, previous, warnings: composition.warnings };
};

/**
 * PUT /:id
 *  - formulaName / description only → updated in place.
 *  - scientific changes on a formula not yet used by any FeedRecommendation →
 *    updated in place (recalculated), unless createNewVersion=true.
 *  - scientific changes on a used formula (or createNewVersion=true) → a new
 *    version record is created; the original is retired (retirePrevious, default
 *    true) and its default flag moves to the new version.
 */
const updateFormula = async (ref: string, payload: TPayload, context: TAuditContext) => {
  const body = payload ?? {};
  const actor = await getActor(context.actorUserId);
  const formula = await findFormulaByRef(ref);

  const meta: { formulaName?: string; description?: string | null } = {};
  if (body.formulaName !== undefined) meta.formulaName = parseFormulaName(body.formulaName);
  if (body.description !== undefined) {
    meta.description = isBlank(body.description) ? null : parseDescription(body.description);
  }
  const sci = parseScientific(body, true);

  //detect real scientific changes (values equal to the stored ones are ignored)
  let composition: TComposition | null = null;
  const changedScientific: string[] = [];
  for (const field of ["breedId", "stage", "purpose", "season", "targetWeightRange", "targetMilkYield", "targetADG", "ruleVersion"] as const) {
    const value = sci[field];
    if (value === undefined) continue;
    const stored = formula.get(field) as unknown;
    if (!sameValue(JSON.parse(JSON.stringify(value)), JSON.parse(JSON.stringify(stored ?? null)))) {
      changedScientific.push(field);
    }
  }
  if (sci.ingredients !== undefined) {
    composition = await buildComposition(sci.ingredients);
    if (!sameValue(ingredientSignature(composition.ingredients), ingredientSignature(formula.ingredients))) {
      changedScientific.push("ingredients");
    }
  }

  const changedMeta = (Object.keys(meta) as (keyof typeof meta)[]).filter(
    (field) => !sameValue(meta[field], formula.get(field)),
  );
  if (!changedScientific.length && !changedMeta.length) {
    if (!Object.keys(meta).length && sci.ingredients === undefined && !Object.keys(sci).length) {
      throw new AppError(status.BAD_REQUEST, "No updatable formula fields were provided!");
    }
    return { mode: "unchanged" as const, formula, previous: null, warnings: [] as string[] };
  }

  const forceVersion = parseBoolean(body.createNewVersion) === true;
  const usage = changedScientific.length ? await countFormulaUsage(formula._id) : { total: 0, feedRecommendations: 0 };

  //--- scientific change on a used formula → new version (historical protection)
  if (changedScientific.length && (forceVersion || usage.total > 0)) {
    const retirePrevious = parseBoolean(body.retirePrevious) ?? true;
    const versionSci: TScientificInput = { ...sci };
    if (composition) versionSci.ingredients = linesForRevalidation(composition.ingredients);
    const options: TVersionOptions = {
      retirePrevious,
      makeDefault: false,
      event: "Formula Version Created",
    };
    //an unchanged ruleVersion in the body means "auto-bump"
    if (sci.ruleVersion && sci.ruleVersion !== formula.ruleVersion) options.ruleVersion = sci.ruleVersion;
    if (meta.formulaName) options.formulaName = meta.formulaName;
    if (meta.description !== undefined) options.description = meta.description;
    const result = await createVersionFrom(formula, versionSci, options, actor, context);
    return {
      mode: "versioned" as const,
      formula: result.formula,
      previous: result.previous,
      usage,
      warnings: result.warnings,
    };
  }

  //--- in-place update (metadata, or scientific change on an unused formula)
  const set: Record<string, unknown> = { updatedBy: actor._id };
  const unset: Record<string, 1> = {};
  if (meta.formulaName) set.formulaName = meta.formulaName;
  if (meta.description === null) unset.description = 1;
  else if (meta.description !== undefined) set.description = meta.description;

  if (changedScientific.length) {
    const merged = mergeFormula(formula.toObject(), sci, composition);
    for (const field of ["breedId", "stage", "purpose", "season", "ingredients", "expectedNutrition", "estimatedDailyCost"]) {
      set[field] = merged[field];
    }
    for (const field of ["targetWeightRange", "targetMilkYield", "targetADG"] as const) {
      if (sci[field] === null) unset[field] = 1;
      else if (sci[field] !== undefined) set[field] = sci[field];
    }
    if (sci.ruleVersion) set.ruleVersion = sci.ruleVersion;

    const newContext = {
      breedId: merged.breedId as Types.ObjectId,
      stage: merged.stage as string,
      purpose: merged.purpose as string,
      season: merged.season as string,
    };
    if (changedScientific.includes("breedId")) await assertActiveBreed(newContext.breedId);
    //moving a default to another context would break "one default per context"
    if (formula.isDefault && !sameValue(contextOf(formula), newContext)) set.isDefault = false;
    await assertUniqueVersion(
      newContext,
      (set.formulaName as string | undefined) ?? formula.formulaName,
      (set.ruleVersion as string | undefined) ?? formula.ruleVersion,
      formula._id,
    );
  } else if (meta.formulaName) {
    await assertUniqueVersion(contextOf(formula), meta.formulaName, formula.ruleVersion, formula._id);
  }

  const before = snapshot(formula) ?? {};
  let updated: TFormulaDoc | null;
  try {
    updated = await FeedFormulaModel.findByIdAndUpdate(
      formula._id,
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { returnDocument: "after", runValidators: true },
    );
  } catch (error) {
    if (isDuplicateKey(error)) throw new AppError(status.CONFLICT, "This change conflicts with another formula!");
    throw error;
  }
  if (!updated) throw new AppError(status.NOT_FOUND, "Feed formula not found!");

  const changedFields = [...changedMeta, ...changedScientific];
  if (changedScientific.length) {
    for (const derived of ["expectedNutrition", "estimatedDailyCost"]) {
      if (!sameValue(before[derived], JSON.parse(JSON.stringify(updated.get(derived))))) changedFields.push(derived);
    }
    if (set.isDefault === false) changedFields.push("isDefault");
  }
  //most specific label wins; changedFields carries the full detail
  const event = changedFields.includes("ingredients")
    ? "Ingredient Changed"
    : changedFields.includes("ruleVersion")
      ? "Rule Version Changed"
      : changedFields.some((f) => f === "targetWeightRange" || f === "targetMilkYield" || f === "targetADG")
        ? "Target Range Changed"
        : "Formula Updated";
  await audit(context, updated._id, AuditActions.UPDATE, event, {
    oldData: Object.fromEntries(changedFields.map((f) => [f, before[f] ?? null])),
    newData: snapshot(updated, changedFields),
    changedFields,
  });

  return {
    mode: "updated" as const,
    formula: updated,
    previous: null,
    warnings: [
      ...(composition?.warnings ?? []),
      ...(set.isDefault === false ? ["The formula moved to a new context and is no longer the default."] : []),
    ],
  };
};

//POST /:id/clone-version — explicit new version (source stays active unless retirePrevious)
const cloneVersion = async (ref: string, payload: TPayload, context: TAuditContext) => {
  const body = payload ?? {};
  const actor = await getActor(context.actorUserId);
  const source = await findFormulaByRef(ref);
  const sci = parseScientific(body, true);

  const options: TVersionOptions = {
    retirePrevious: parseBoolean(body.retirePrevious) ?? false,
    makeDefault: parseBoolean(body.isDefault) ?? false,
    event: "Formula Version Created",
  };
  if (sci.ruleVersion) options.ruleVersion = sci.ruleVersion;
  if (body.bump !== undefined) options.bump = parseEnum("bump", body.bump, ["minor", "major"]) as "minor" | "major";
  if (body.formulaName !== undefined) options.formulaName = parseFormulaName(body.formulaName);
  if (body.description !== undefined) {
    options.description = isBlank(body.description) ? null : parseDescription(body.description);
  }

  return createVersionFrom(source, sci, options, actor, context);
};

//PATCH /:id/set-default — { isDefault?: boolean } (default true)
const setDefault = async (ref: string, payload: TPayload, context: TAuditContext) => {
  const body = payload ?? {};
  const actor = await getActor(context.actorUserId);
  const formula = await findFormulaByRef(ref);
  const target = body.isDefault === undefined ? true : parseBoolean(body.isDefault);
  if (target === undefined) throw new AppError(status.BAD_REQUEST, "isDefault must be a boolean!");

  if (target) {
    if (!formula.isActive) {
      throw new AppError(status.CONFLICT, "Only an active formula can be the default; activate it first!");
    }
    if (formula.isDefault) return formula;
    return promoteToDefault(formula, actor._id, context);
  }

  if (!formula.isDefault) return formula;
  const updated = await FeedFormulaModel.findByIdAndUpdate(
    formula._id,
    { $set: { isDefault: false, updatedBy: actor._id } },
    { returnDocument: "after", runValidators: true },
  );
  if (!updated) throw new AppError(status.NOT_FOUND, "Feed formula not found!");
  await audit(context, updated._id, AuditActions.UPDATE, "Formula Removed as Default", {
    oldData: { isDefault: true },
    newData: { isDefault: false },
    changedFields: ["isDefault"],
  });
  return updated;
};

/**
 * Lifecycle status. Retiring removes the formula from future matching (and drops
 * its default flag) but keeps the document for FeedRecommendation history.
 * Reactivating re-checks that the breed and every ingredient are still active.
 */
const setActiveStatus = async (
  formula: TFormulaDoc,
  isActive: boolean,
  actor: TActor,
  context: TAuditContext,
  reason?: string,
) => {
  if (isActive === formula.isActive) return formula;

  if (isActive) {
    await assertActiveBreed(formula.breedId);
    const ingredients = await FeedIngredientModel.find({
      _id: { $in: formula.ingredients.map((l) => l.ingredientId) },
    })
      .select("ingredientName isActive")
      .lean();
    const retired = ingredients.filter((i) => !i.isActive).map((i) => i.ingredientName);
    if (retired.length || ingredients.length !== formula.ingredients.length) {
      throw new AppError(
        status.CONFLICT,
        `Cannot activate: ${retired.length ? `retired ingredient(s) ${retired.join(", ")}` : "an ingredient no longer exists"}. Clone a new version with replacement ingredients instead.`,
      );
    }
  }

  const set: Record<string, unknown> = { isActive, updatedBy: actor._id };
  if (!isActive) set.isDefault = false;
  const updated = await FeedFormulaModel.findByIdAndUpdate(
    formula._id,
    { $set: set },
    { returnDocument: "after", runValidators: true },
  );
  if (!updated) throw new AppError(status.NOT_FOUND, "Feed formula not found!");

  const changedFields = ["isActive", ...(!isActive && formula.isDefault ? ["isDefault"] : [])];
  await audit(
    context,
    updated._id,
    isActive ? AuditActions.UPDATE : AuditActions.ARCHIVE,
    isActive ? "Formula Activated" : "Formula Deactivated",
    {
      oldData: { isActive: formula.isActive, isDefault: formula.isDefault },
      newData: { isActive, isDefault: updated.isDefault, ...(reason ? { reason } : {}) },
      changedFields,
    },
  );
  return updated;
};

const toggleActive = async (ref: string, payload: TPayload, context: TAuditContext) => {
  const body = payload ?? {};
  const actor = await getActor(context.actorUserId);
  const formula = await findFormulaByRef(ref);
  let isActive = !formula.isActive; //no value = toggle
  if (body.isActive !== undefined) {
    const parsed = parseBoolean(body.isActive);
    if (parsed === undefined) throw new AppError(status.BAD_REQUEST, "isActive must be a boolean!");
    isActive = parsed;
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : undefined;
  return setActiveStatus(formula, isActive, actor, context, reason);
};

/**
 * DELETE /:id — soft-retire by default ("Soft delete").
 * ?hard=true permanently removes the record only when no FeedRecommendation
 * references it; otherwise 409.
 */
const deleteFormula = async (ref: string, query: TPayload, context: TAuditContext) => {
  const actor = await getActor(context.actorUserId);
  const formula = await findFormulaByRef(ref);
  const hard = parseBoolean(query.hard) === true;
  const usage = await countFormulaUsage(formula._id);

  if (!hard) {
    const retired = await setActiveStatus(formula, false, actor, context);
    return { mode: "retired" as const, formula: retired, usage };
  }
  if (usage.total > 0) {
    throw new AppError(
      status.CONFLICT,
      `Cannot permanently delete: formula is referenced by ${usage.feedRecommendations} feed recommendation(s). Retire it instead.`,
    );
  }

  const oldData = snapshot(formula);
  await FeedFormulaModel.deleteOne({ _id: formula._id });
  await audit(context, formula._id, AuditActions.DELETE, "Formula Deleted", { oldData });
  return { mode: "deleted" as const, formula: null, usage };
};

export const FeedFormulaServices = {
  createFormula,
  getAllFormulas,
  getFormulaLookup,
  getFormulaMeta,
  getFormulaStats,
  getFormula,
  getFormulaVersions,
  getFormulaUsage,
  getFormulaAuditLogs,
  previewComposition,
  matchFormulas,
  updateFormula,
  cloneVersion,
  setDefault,
  toggleActive,
  deleteFormula,
};
