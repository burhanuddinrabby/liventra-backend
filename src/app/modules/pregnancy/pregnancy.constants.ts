// Pregnancy (Model 18) enums. Values follow the final DB schema in
// `.opencode/Business Logics.md` and are stored as-is.
// Only the Breeding module writes Pregnancy rows today (confirmation / correction);
// the full Pregnancy routes (delivery, abortion, calving) are a later module.
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";

export const PregnancyStatuses = {
  PREGNANT: "Pregnant",
  DELIVERED: "Delivered",
  ABORTED: "Aborted",
  FAILED: "Failed",
} as const;

export const CalfGenders = {
  MALE: "Male",
  FEMALE: "Female",
  TWIN: "Twin",
} as const;

//PRG-2026-000001 (final schema example) — atomic per-year counter
export const PREGNANCY_NO_PREFIX = "PRG";
export const PREGNANCY_NO_PATTERN = /^PRG-\d{4}-\d{6}$/i;

/**
 * Average cattle gestation (days). Liventra animals are cattle (no species field),
 * so expectedCalvingDate = conceptionDate + CATTLE_GESTATION_DAYS unless the
 * caller records a vet-estimated date inside the allowed window below.
 */
export const CATTLE_GESTATION_DAYS = 283;
export const MIN_GESTATION_DAYS = 240;
export const MAX_GESTATION_DAYS = 320;

export const MAX_PREGNANCY_TEXT = 2000;

const { OWNER, MANAGER, WORKER, VETERINARIAN, ACCOUNTANT } = FarmMemberRoles;

/**
 * Pregnancy route permissions (DO.md route table).
 *  - every active member reads lists, history, detail and analytics
 *  - Owner / Manager / Vet create, deliver, record outcome and correct
 *  - only Owner deletes (and hard deletion is blocked for historical records)
 *  - change history / audit is Owner / Manager / Vet
 */
export const PregnancyPermissions = {
  READ: [OWNER, MANAGER, WORKER, VETERINARIAN, ACCOUNTANT],
  CREATE: [OWNER, MANAGER, VETERINARIAN],
  DELIVER: [OWNER, MANAGER, VETERINARIAN],
  OUTCOME: [OWNER, MANAGER, VETERINARIAN],
  UPDATE: [OWNER, MANAGER, VETERINARIAN],
  DELETE: [OWNER],
  AUDIT: [OWNER, MANAGER, VETERINARIAN],
} as const;

/**
 * Pregnancy status lifecycle transitions (spec §39).
 *  Pregnant → Delivered | Aborted | Failed   (normal outcomes)
 *  anything else → anything                  (not allowed)
 */
export const PREGNANCY_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  Pregnant: ["Delivered", "Aborted", "Failed"],
} as const;

//post-calving reproductive state for the mother (spec §79)
export const POST_CALVING_REPRODUCTIVE_STATUS = "Lactating";

//after abortion / failure with no newer cycle, the mother returns to Open
export const POST_OUTCOME_REPRODUCTIVE_STATUS = "Open";

//conception date must fall within this many days after the insemination date
export const MAX_CONCEPTION_AFTER_SERVICE_DAYS = 3;

//calf count / gender consistency rules
export const MIN_CALF_COUNT = 1;
export const MAX_CALF_COUNT = 10;

//remarks max length
export const MAX_REMARKS = MAX_PREGNANCY_TEXT;

//never accepted from the client
export const SERVER_MANAGED_FIELDS = [
  "pregnancyNo",
  "farmId",
  "createdBy",
  "createdAt",
  "updatedAt",
  "_id",
] as const;
