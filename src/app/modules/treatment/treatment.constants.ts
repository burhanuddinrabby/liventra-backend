// Treatment (Model 16) — one animal-specific clinical episode (diagnosis → medicines → outcome).
// Values follow the final DB schema in `.opencode/Business Logics.md` and are stored as-is.
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";

export const TreatmentStatuses = {
  ONGOING: "Ongoing",
  RECOVERED: "Recovered",
  REFERRED: "Referred",
  CANCELLED: "Cancelled",
} as const;

//TRT-2026-000001 (final schema example) — atomic per-year counter
export const TREATMENT_NO_PREFIX = "TRT";
export const TREATMENT_NO_PATTERN = /^TRT-\d{4}-\d{6}$/i;

const { OWNER, MANAGER, WORKER, VETERINARIAN, ACCOUNTANT } = FarmMemberRoles;

/**
 * Farm-role permissions (DO.md route table; the final schema CRUD table is stricter
 * for Worker — DO.md is the newer instruction and lets Workers open episodes and
 * record medicine usage, but never change outcome / correct / delete).
 *  - every active member reads
 *  - Owner / Manager / Vet / Worker open an episode and draw medicine from stock
 *  - Owner / Manager / Vet change status and correct an episode
 *  - only Owner / Manager reopen a closed (Recovered / Referred) episode
 *  - only Owner deletes, and only unexecuted erroneous entries
 */
export const TreatmentPermissions = {
  READ: [OWNER, MANAGER, WORKER, VETERINARIAN, ACCOUNTANT],
  CREATE: [OWNER, MANAGER, VETERINARIAN, WORKER],
  CONSUME_INVENTORY: [OWNER, MANAGER, VETERINARIAN, WORKER],
  CHANGE_STATUS: [OWNER, MANAGER, VETERINARIAN],
  UPDATE: [OWNER, MANAGER, VETERINARIAN],
  REOPEN: [OWNER, MANAGER],
  DELETE: [OWNER],
  AUDIT: [OWNER, MANAGER, VETERINARIAN],
} as const;

//farm roles that may be recorded as `treatedBy` (Accountant does not treat animals)
export const TREATED_BY_ROLES: string[] = [OWNER, MANAGER, VETERINARIAN, WORKER];
//prescription-only medicines (Medicine.prescriptionRequired) need an authorized prescriber
export const PRESCRIBER_ROLES: string[] = [OWNER, MANAGER, VETERINARIAN];

/**
 * Allowed lifecycle transitions through PATCH /:id/status (spec §52–53).
 *  Ongoing   → Recovered | Referred | Cancelled
 *  Referred  → Recovered | Ongoing (reopen) | Cancelled
 *  Recovered → Ongoing (controlled reopen only — Owner / Manager, audited)
 *  Cancelled → terminal (open a new episode instead)
 */
export const TREATMENT_TRANSITIONS: Record<string, readonly string[]> = {
  Ongoing: ["Recovered", "Referred", "Cancelled"],
  Referred: ["Recovered", "Ongoing", "Cancelled"],
  Recovered: ["Ongoing"],
  Cancelled: [],
};

//moving back to Ongoing from these is a "reopen" (REOPEN permission + reason)
export const REOPEN_FROM: string[] = [TreatmentStatuses.RECOVERED, TreatmentStatuses.REFERRED];

//statuses where the episode is still clinically open (animal is not cleared)
export const OPEN_STATUSES: string[] = [TreatmentStatuses.ONGOING, TreatmentStatuses.REFERRED];

//statuses whose medicines can be drawn from stock (Cancelled episodes never consume)
export const CONSUMABLE_STATUSES: string[] = [
  TreatmentStatuses.ONGOING,
  TreatmentStatuses.RECOVERED,
  TreatmentStatuses.REFERRED,
];

//only these may be hard-deleted — and only when no stock movement exists
export const DELETABLE_STATUSES: string[] = [TreatmentStatuses.ONGOING, TreatmentStatuses.CANCELLED];

/** Treatment dose units (spec §33). Stored as-is in medicines[].dosageUnit. */
export const TreatmentDosageUnits = {
  ML: "ml",
  MG: "mg",
  G: "g",
  TABLET: "tablet",
  BOLUS: "bolus",
  SACHET: "sachet",
  DOSE: "dose",
  APPLICATION: "application",
} as const;

/**
 * Dose unit ↔ Medicine.dosageForm compatibility (spec §33 "unit should be compatible
 * with the selected Medicine/dosage form"). Served by GET /meta so the form uses it.
 */
export const DOSAGE_UNIT_COMPATIBILITY: Record<string, readonly string[]> = {
  Injection: ["ml", "mg", "dose"],
  Tablet: ["tablet", "mg"],
  Bolus: ["bolus", "mg", "g"],
  Powder: ["g", "mg", "sachet", "dose", "ml"],
  Liquid: ["ml", "dose"],
  Spray: ["application", "ml", "dose"],
  Ointment: ["application", "g"],
};

//suggested values for the free-text frequency / duration fields (UI datalist only)
export const FREQUENCY_SUGGESTIONS = [
  "Once daily",
  "Twice daily",
  "Every 8 hours",
  "Every 12 hours",
  "Every 48 hours",
  "Single dose",
  "As directed",
];
export const DURATION_SUGGESTIONS = ["1 day", "3 days", "5 days", "7 days", "10 days", "14 days", "Until follow-up"];

export const MAX_TEXT_LENGTH = 1000;
export const MAX_SHORT_TEXT = 60;
export const MAX_SYMPTOMS = 30;
export const MAX_SYMPTOM_LENGTH = 100;
export const MAX_MEDICINES = 15;
export const MAX_DOSAGE = 100_000;
export const MAX_ESTIMATED_COST = 10_000_000;
export const MAX_CONSUME_QUANTITY = 100_000;
export const MAX_LIST_LIMIT = 100;
//backdated entries are allowed, but not arbitrarily old
export const MAX_BACKDATE_DAYS = 3650;
//a follow-up can be planned at most this far ahead
export const MAX_FOLLOW_UP_AHEAD_DAYS = 365;
//tolerance for client/server time-zone differences when rejecting future dates
export const FUTURE_TOLERANCE_HOURS = 24;
//default / maximum window for the follow-up dashboard
export const DEFAULT_FOLLOW_UP_DAYS = 7;
export const MAX_FOLLOW_UP_DAYS = 90;
//withdrawal look-back: treatments diagnosed earlier than this cannot still restrict
export const WITHDRAWAL_LOOKBACK_DAYS = 400;
export const MAX_ANIMAL_HISTORY = 500;
//"recently completed" window for the duplicate warning
export const DUPLICATE_WINDOW_DAYS = 3;

//fields a client may never send — the server generates or derives them
export const SERVER_MANAGED_FIELDS = [
  "treatmentNo",
  "farmId",
  "createdBy",
  "createdAt",
  "updatedAt",
  "completedDate",
] as const;
