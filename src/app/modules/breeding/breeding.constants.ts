// Breeding (Model 17) — one heat-cycle / insemination event for a female animal.
// Values follow the final DB schema in `.opencode/Business Logics.md` and are stored as-is.
import { AnimalReproductiveStatuses } from "../animal/animal.constants.js";
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";

export const BreedingMethods = {
  ARTIFICIAL_INSEMINATION: "Artificial Insemination",
  NATURAL_MATING: "Natural Mating",
  EMBRYO_TRANSFER: "Embryo Transfer",
} as const;

export const PregnancyResults = {
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  FAILED: "Failed",
} as const;

//BRD-2026-000001 (final schema example) — atomic per-year counter
export const BREEDING_NO_PREFIX = "BRD";
export const BREEDING_NO_PATTERN = /^BRD-\d{4}-\d{6}$/i;

const { OWNER, MANAGER, WORKER, VETERINARIAN, ACCOUNTANT } = FarmMemberRoles;

/**
 * Farm-role permissions (DO.md route table). The final schema CRUD table is stricter
 * (Worker: no create, "limited" read; no hard delete). DO.md is the newer, explicit
 * instruction: Workers may log a breeding event, and the Owner may remove an
 * unconfirmed erroneous entry (never one with a linked Pregnancy).
 *  - every active member reads lists, history and analytics
 *  - Owner / Manager / Vet / Worker log a breeding event
 *  - Owner / Manager / Vet record the pregnancy-check result and correct records
 *  - only Owner deletes; change history is Owner / Manager / Vet ("limited" Worker read)
 */
export const BreedingPermissions = {
  READ: [OWNER, MANAGER, WORKER, VETERINARIAN, ACCOUNTANT],
  CREATE: [OWNER, MANAGER, VETERINARIAN, WORKER],
  RECORD_RESULT: [OWNER, MANAGER, VETERINARIAN],
  UPDATE: [OWNER, MANAGER, VETERINARIAN],
  DELETE: [OWNER],
  AUDIT: [OWNER, MANAGER, VETERINARIAN],
} as const;

/**
 * Pregnancy-check result transitions through PATCH /:id/pregnancy-result.
 *  Pending   → Confirmed | Failed           (normal check)
 *  Failed    → Confirmed | Pending          (correction — reason required)
 *  Confirmed → Failed                       (correction — reason required; the linked
 *                                            Pregnancy is closed as Failed in the same
 *                                            atomic unit, only while it is still Pregnant)
 */
export const RESULT_TRANSITIONS: Record<string, readonly string[]> = {
  Pending: ["Confirmed", "Failed"],
  Failed: ["Confirmed", "Pending"],
  Confirmed: ["Failed"],
};

/**
 * Farm reproductive policy (spec §13: configurable, not a universal veterinary rule).
 *  - BLOCKED: never bred (Calf is immature, Pregnant is already carrying)
 *  - ELIGIBLE: normal breeding states
 *  - CAUTION: allowed but answered with a warning (Dry cows are normally in late pregnancy)
 */
export const BLOCKED_REPRODUCTIVE_STATUSES: readonly string[] = [
  AnimalReproductiveStatuses.CALF,
  AnimalReproductiveStatuses.PREGNANT,
];
export const ELIGIBLE_REPRODUCTIVE_STATUSES: readonly string[] = [
  AnimalReproductiveStatuses.HEIFER,
  AnimalReproductiveStatuses.OPEN,
  AnimalReproductiveStatuses.LACTATING,
];
export const CAUTION_REPRODUCTIVE_STATUSES: readonly string[] = [AnimalReproductiveStatuses.DRY];

//minimum breeding age (months) when birthDate is known
export const MIN_BREEDING_AGE_MONTHS = 12;
//minimum bull age (months) for Natural Mating when birthDate is known (warning only)
export const MIN_BULL_AGE_MONTHS = 12;

//default expectedPregnancyCheckDate = service (or heat) date + this many days
export const DEFAULT_PREGNANCY_CHECK_DAYS = 35;
//a pregnancy check cannot be scheduled sooner / later than this after service
export const MIN_PREGNANCY_CHECK_DAYS = 14;
export const MAX_PREGNANCY_CHECK_DAYS = 120;
//heat → service gap allowed (days): heat is normally 0–2 days before insemination
export const MAX_HEAT_TO_SERVICE_DAYS = 7;
//the earliest day after service a pregnancy can be confirmed (ultrasound / blood test)
export const MIN_CONFIRM_DAYS = 21;
//same-animal records within ±this many days are flagged as possible duplicates
export const DUPLICATE_WINDOW_DAYS = 3;
//historical entry limit
export const MAX_BACKDATE_DAYS = 730;
//clock-skew tolerance for "not in the future" checks
export const FUTURE_TOLERANCE_HOURS = 14;
//default window for /pregnancy-checks "upcoming"
export const DEFAULT_CHECK_WINDOW_DAYS = 7;
export const MAX_CHECK_WINDOW_DAYS = 90;

export const MAX_TEXT_LENGTH = 2000;
export const MAX_SHORT_TEXT = 100;
export const MAX_LIST_LIMIT = 100;
export const MAX_ANIMAL_HISTORY = 200;

//never accepted from the client
export const SERVER_MANAGED_FIELDS = ["breedingNo", "farmId", "createdBy", "createdAt", "updatedAt", "_id"] as const;
