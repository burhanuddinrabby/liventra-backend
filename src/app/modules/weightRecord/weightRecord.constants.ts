// WeightRecord (Model 11) — one body-weight measurement of one animal at one point
// in time. Field names follow the final DB schema ("Business Logics.md"): weight,
// weightUnit kg | lb, measurementMethod Digital Scale / Manual Scale / Estimated /
// Smart Device, averageDailyGain (kg/day), measuredBy (FarmMember).
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";

export const WeightUnits = {
  KG: "kg",
  LB: "lb",
} as const;

//kilograms per 1 unit — the ONE place unit normalization is defined (spec §11–12)
export const WEIGHT_UNIT_TO_KG: Record<string, number> = {
  [WeightUnits.KG]: 1,
  [WeightUnits.LB]: 0.453592,
};

export const MeasurementMethods = {
  DIGITAL_SCALE: "Digital Scale",
  MANUAL_SCALE: "Manual Scale",
  ESTIMATED: "Estimated",
  SMART_DEVICE: "Smart Device",
} as const;

//methods that are direct / instrument-based (spec §27, §47). Estimated measurements
//are kept but always flagged so they never silently look equally reliable.
export const DIRECT_MEASUREMENT_METHODS: readonly string[] = [
  MeasurementMethods.DIGITAL_SCALE,
  MeasurementMethods.MANUAL_SCALE,
  MeasurementMethods.SMART_DEVICE,
];

const { OWNER, MANAGER, WORKER, VETERINARIAN, ACCOUNTANT } = FarmMemberRoles;

/**
 * Farm-role permissions (DO.md route table + final schema CRUD table).
 * Every active member reads; Owner / Manager / Worker log measurements;
 * PUT is a controlled correction (Owner / Manager); DELETE is Owner only and
 * voids by default (hard delete only for duplicate / accidental entries).
 */
export const WeightRecordPermissions = {
  READ: [OWNER, MANAGER, WORKER, VETERINARIAN, ACCOUNTANT],
  CREATE: [OWNER, MANAGER, WORKER],
  UPDATE: [OWNER, MANAGER],
  DELETE: [OWNER],
  //change history + voided records
  AUDIT: [OWNER, MANAGER],
} as const;

//DELETE modes: void keeps the row as history; hard removes a duplicate / accidental entry
export const WeightDeleteModes = {
  VOID: "void",
  HARD: "hard",
} as const;

//growth summary windows
export const SummaryPeriods = {
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
} as const;

//sanity cap — one animal's body weight in kg after normalization. Generous on purpose:
//it only rejects obvious typos (e.g. 1800 instead of 180), not a species limit.
export const MAX_WEIGHT_KG = 2000;
export const MAX_WEIGHT_LB = MAX_WEIGHT_KG / WEIGHT_UNIT_TO_KG[WeightUnits.LB]!;

//backdated entries are explicitly allowed (spec §36); ten years is a safe ceiling
export const MAX_BACKDATE_DAYS = 3650;
//tolerance for client/server time-zone differences when rejecting future dates
export const FUTURE_TOLERANCE_HOURS = 24;

//a weight older than this many days is "stale" for feed planning (spec §60–61)
export const DEFAULT_STALE_DAYS = 30;
export const MAX_STALE_DAYS = 730;

//a single-interval change this large raises a typo / scale-error warning (spec §48–49)
export const ABNORMAL_CHANGE_PERCENT = 25;
//same-day measurements are allowed, but a repeated reading is flagged (spec §50)
export const DUPLICATE_DAY_WARNING = true;

export const MAX_TEXT_LENGTH = 1000;
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 20;
export const MAX_SUMMARY_ANIMALS = 1000;
export const OVERDUE_LIST_LIMIT = 20;
export const DEFAULT_SUMMARY_DAYS = 90;
export const MAX_SUMMARY_DAYS = 730;

//fields a client may never send — the server derives them
export const SERVER_CALCULATED_FIELDS = [
  "farmId",
  "weightInKg",
  "averageDailyGain",
  "isVoided",
  "voidedAt",
  "voidedBy",
  "voidReason",
] as const;
