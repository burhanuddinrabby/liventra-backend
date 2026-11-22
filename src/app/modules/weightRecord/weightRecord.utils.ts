import { DAY_MS, round } from "../feedRecord/feedRecord.utils.js";
import { MeasurementMethods, WEIGHT_UNIT_TO_KG } from "./weightRecord.constants.js";

// Generic parsing helpers (isBlank, parseEnum, parseNumber, parseCalendarDate, paging…)
// are shared with the FeedRecord / MilkRecord modules so production logs behave alike.
export {
  DAY_MS,
  dayKey,
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
  round,
} from "../feedRecord/feedRecord.utils.js";
export type { TPayload } from "../feedRecord/feedRecord.utils.js";

/** Centralized unit normalization (spec §11–12): every calculation is in kg. */
export const toKg = (weight: number, unit: string): number =>
  round(weight * (WEIGHT_UNIT_TO_KG[unit] ?? 1), 3);

/** kg → the unit the user reads (only used for display hints, never for storage). */
export const fromKg = (weightInKg: number, unit: string): number =>
  round(weightInKg / (WEIGHT_UNIT_TO_KG[unit] ?? 1), 3);

/**
 * Average Daily Gain between two measurements (spec §20–26).
 * Days are whole calendar days; a same-day pair has no meaningful interval and
 * returns null. Zero is valid, negative is allowed (weight loss is real data).
 */
export const calculateAdg = (currentKg: number, previousKg: number, days: number): number | null => {
  if (!Number.isFinite(days) || days <= 0) return null;
  return round((currentKg - previousKg) / days, 3);
};

/** Whole days between two calendar dates (UTC midnights). */
export const daysBetween = (later: Date, earlier: Date): number =>
  Math.round((new Date(later).getTime() - new Date(earlier).getTime()) / DAY_MS);

/** Percentage change between two weights; null when the previous weight is 0. */
export const percentChange = (currentKg: number, previousKg: number): number | null =>
  previousKg > 0 ? round(((currentKg - previousKg) / previousKg) * 100, 1) : null;

/** "Estimated" measurements are kept but always flagged (spec §17, §27). */
export const isEstimatedMethod = (method: string): boolean => method === MeasurementMethods.ESTIMATED;
