import mongoose from "mongoose";
import type { ClientSession } from "mongoose";
import { RECOMMENDATION_NO_PREFIX } from "./feedRecommendation.constants.js";
import { RecommendationCounterModel } from "./feedRecommendation.model.js";
import {
  ANIMAL_PURPOSE_TO_FORMULA_PURPOSE,
  FeedFormulaPurposes,
  FeedFormulaStages,
  REPRODUCTIVE_STATUS_TO_STAGE,
} from "../feedFormula/feedFormula.constants.js";

/**
 * Next recommendationNo, e.g. REC-2026-000001. Uses an atomic per-year counter
 * (findOneAndUpdate + $inc) instead of last-row+1, so concurrent generations can
 * never receive the same number. Gaps are possible (failed saves) and harmless.
 */
export const generateRecommendationNo = async (now: Date = new Date()): Promise<string> => {
  const year = now.getFullYear();
  const counter = await RecommendationCounterModel.findOneAndUpdate(
    { _id: `feedRecommendation-${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  return `${RECOMMENDATION_NO_PREFIX}-${year}-${String(counter?.seq ?? 1).padStart(6, "0")}`;
};

//REC-2026-000001 (case-insensitive) — used to tell a recommendationNo from a Mongo _id
export const RECOMMENDATION_NO_PATTERN = /^REC-\d{4}-\d{6}$/i;

export const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const round = (value: number, digits = 3): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

//completed months between birthDate and now (null when unknown / in the future)
export const ageInMonths = (birthDate?: Date | null, now: Date = new Date()): number | null => {
  if (!birthDate) return null;
  const birth = new Date(birthDate);
  if (Number.isNaN(birth.getTime()) || birth > now) return null;
  let months = (now.getFullYear() - birth.getFullYear()) * 12 + (now.getMonth() - birth.getMonth());
  if (now.getDate() < birth.getDate()) months -= 1;
  return Math.max(months, 0);
};

/**
 * Animal → FeedFormula stage (rule v1.0). Calf/Heifer/Lactating/Dry map 1:1;
 * Pregnant → Breeding; Open females → Breeding (Beef → Growing);
 * males → Calf under 6 months, Breeding bulls → Breeding, otherwise Growing.
 */
export const deriveStage = (animal: {
  gender?: string;
  purpose?: string;
  reproductiveStatus?: string;
  ageMonths: number | null;
}): string => {
  const direct = REPRODUCTIVE_STATUS_TO_STAGE[animal.reproductiveStatus ?? ""];
  if (direct) return direct;
  if (animal.ageMonths !== null && animal.ageMonths < 6) return FeedFormulaStages.CALF;
  if (animal.reproductiveStatus === "Pregnant") return FeedFormulaStages.BREEDING;
  if (animal.gender === "Male") {
    return animal.purpose === "Breeding" ? FeedFormulaStages.BREEDING : FeedFormulaStages.GROWING;
  }
  return animal.purpose === "Beef" ? FeedFormulaStages.GROWING : FeedFormulaStages.BREEDING;
};

/** Animal.purpose → FeedFormula purpose; Dual Purpose follows the lactation state. */
export const derivePurpose = (animal: { purpose?: string; stage: string }): string => {
  const direct = ANIMAL_PURPOSE_TO_FORMULA_PURPOSE[animal.purpose ?? ""];
  if (direct) return direct;
  if (animal.stage === FeedFormulaStages.LACTATING) return FeedFormulaPurposes.MILK_PRODUCTION;
  if (animal.stage === FeedFormulaStages.DRY) return FeedFormulaPurposes.MAINTENANCE;
  return FeedFormulaPurposes.GROWTH;
};

//"Transaction numbers are only allowed on a replica set member or mongos" (standalone mongod)
const isTransactionUnsupported = (error: unknown) => {
  const err = error as { code?: number; message?: string };
  return (
    err?.code === 20 ||
    /Transaction numbers are only allowed|replica set|does not support transactions/i.test(
      err?.message ?? "",
    )
  );
};

/**
 * Runs `work` inside a MongoDB transaction. On a standalone server (no replica
 * set) transactions are unavailable, so `work` runs without a session and the
 * caller must apply its own compensation (see createRecommendation).
 */
export const runInTransaction = async <T>(
  // eslint-disable-next-line no-unused-vars
  work: (session: ClientSession | null) => Promise<T>,
): Promise<T> => {
  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result as T;
  } catch (error) {
    if (isTransactionUnsupported(error)) return work(null);
    throw error;
  } finally {
    await session.endSession();
  }
};
