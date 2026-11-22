// MilkRecord (Model 10) — the ACTUAL milk produced by one animal in one milking session.
// Field names follow the final DB schema ("Business Logics.md"): `quality` (not
// `qualityStatus`), sessions Morning / Afternoon / Evening / Night, units liter / ml.
import { AnimalReproductiveStatuses } from "../animal/animal.constants.js";
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";

export const MilkingSessions = {
  MORNING: "Morning",
  AFTERNOON: "Afternoon",
  EVENING: "Evening",
  NIGHT: "Night",
} as const;

//chronological order inside one day
export const MILKING_SESSION_ORDER: Record<string, number> = {
  [MilkingSessions.MORNING]: 1,
  [MilkingSessions.AFTERNOON]: 2,
  [MilkingSessions.EVENING]: 3,
  [MilkingSessions.NIGHT]: 4,
};

export const MilkUnits = {
  LITER: "liter",
  ML: "ml",
} as const;

//liters per 1 unit — the ONE place unit normalization is defined (spec §13)
export const MILK_UNIT_TO_LITERS: Record<string, number> = {
  [MilkUnits.LITER]: 1,
  [MilkUnits.ML]: 0.001,
};

export const MilkQualities = {
  EXCELLENT: "Excellent",
  GOOD: "Good",
  AVERAGE: "Average",
  POOR: "Poor",
  REJECTED: "Rejected",
} as const;

export const MilkingMethods = {
  MANUAL: "Manual",
  MILKING_MACHINE: "Milking Machine",
  AUTOMATIC: "Automatic",
} as const;

const { OWNER, MANAGER, WORKER, VETERINARIAN, ACCOUNTANT } = FarmMemberRoles;

/**
 * Farm-role permissions (DO.md route table + final schema CRUD table).
 * Every active member reads. Workers log milkings; Veterinarian / Accountant read only.
 * PUT is a controlled correction (Owner / Manager); DELETE is Owner only and voids
 * by default (hard delete only for duplicate / accidental entries).
 */
export const MilkRecordPermissions = {
  READ: [OWNER, MANAGER, WORKER, VETERINARIAN, ACCOUNTANT],
  CREATE: [OWNER, MANAGER, WORKER],
  UPDATE: [OWNER, MANAGER],
  //quick "mark as Rejected / re-grade" without a full correction
  GRADE: [OWNER, MANAGER],
  DELETE: [OWNER],
  //change history + voided records
  AUDIT: [OWNER, MANAGER],
} as const;

//reproductive states that cannot produce milk — logging is blocked (spec §31)
export const NON_MILKING_REPRODUCTIVE_STATUSES: string[] = [AnimalReproductiveStatuses.CALF];
//anything other than Lactating is allowed with a warning (spec §32, §79)
export const LACTATING_STATUS: string = AnimalReproductiveStatuses.LACTATING;

//DELETE modes: void keeps the row as history; hard removes a duplicate / accidental entry
export const MilkDeleteModes = {
  VOID: "void",
  HARD: "hard",
} as const;

export const SummaryPeriods = {
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
} as const;

//sanity caps — a single session of a single animal (in liters after normalization)
export const MAX_SESSION_LITERS = 80;
//composition ranges (percent). Generous caps that only reject typos; not a lab standard.
export const COMPOSITION_LIMITS = {
  fatPercentage: { min: 0, max: 15 },
  proteinPercentage: { min: 0, max: 10 },
  snfPercentage: { min: 0, max: 15 },
} as const;

export const MAX_BACKDATE_DAYS = 365;
//tolerance for client/server time-zone differences when rejecting future dates
export const FUTURE_TOLERANCE_HOURS = 24;
export const MAX_TEXT_LENGTH = 1000;
export const MAX_LIST_LIMIT = 100;
export const MAX_BULK_ENTRIES = 200;
export const DEFAULT_SUMMARY_DAYS = 30;
export const MAX_SUMMARY_DAYS = 366;
export const TOP_PRODUCERS_LIMIT = 5;
//a day's total below this % of the animal's recent average raises a "production drop" warning
export const PRODUCTION_DROP_PERCENT = 30;

//fields a client may never send — the server derives them
export const SERVER_CALCULATED_FIELDS = [
  "farmId",
  "quantityInLiters",
  "withdrawalFlag",
  "withdrawalDetails",
  "isVoided",
  "voidedAt",
  "voidedBy",
  "voidReason",
] as const;
