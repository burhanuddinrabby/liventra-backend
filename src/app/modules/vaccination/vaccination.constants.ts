// Vaccination (Model 13) — one animal-level immunization event (planned or administered).
// Values follow the final DB schema in `.opencode/Business Logics.md` and are stored as-is.
import { AnimalHealthStatuses } from "../animal/animal.constants.js";
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";

export const VaccinationStatuses = {
  SCHEDULED: "Scheduled",
  COMPLETED: "Completed",
  MISSED: "Missed",
  CANCELLED: "Cancelled",
} as const;

//VACLOG-2026-000001 (final schema example) — atomic per-year counter
export const VACCINATION_NO_PREFIX = "VACLOG";
export const VACCINATION_NO_PATTERN = /^VACLOG-\d{4}-\d{6}$/i;

const { OWNER, MANAGER, WORKER, VETERINARIAN, ACCOUNTANT } = FarmMemberRoles;

/**
 * Farm-role permissions (DO.md route table; final schema CRUD table for reads).
 *  - every active member reads
 *  - Owner / Manager / Vet / Worker schedule and record (complete) doses
 *  - Owner / Manager / Vet mark Missed / Cancelled and correct records
 *  - only Owner / Manager may reverse a Completed dose (restores stock)
 *  - only Owner deletes, and only unexecuted Scheduled / Cancelled drafts
 */
export const VaccinationPermissions = {
  READ: [OWNER, MANAGER, WORKER, VETERINARIAN, ACCOUNTANT],
  CREATE: [OWNER, MANAGER, VETERINARIAN, WORKER],
  COMPLETE: [OWNER, MANAGER, VETERINARIAN, WORKER],
  CHANGE_STATUS: [OWNER, MANAGER, VETERINARIAN],
  UPDATE: [OWNER, MANAGER, VETERINARIAN],
  REVERSE_COMPLETED: [OWNER, MANAGER],
  DELETE: [OWNER],
  AUDIT: [OWNER, MANAGER, VETERINARIAN],
} as const;

//statuses PATCH /:id/status may move a record to
export const MANUAL_STATUS_TARGETS = [VaccinationStatuses.MISSED, VaccinationStatuses.CANCELLED] as const;

//records that count as an "event that happened or will happen" for duplicate detection
export const DUPLICATE_CHECK_STATUSES: string[] = [VaccinationStatuses.SCHEDULED, VaccinationStatuses.COMPLETED];

//only unexecuted drafts may be hard-deleted (Completed already touched stock/history)
export const DELETABLE_STATUSES: string[] = [VaccinationStatuses.SCHEDULED, VaccinationStatuses.CANCELLED];

//vaccination is allowed but the response carries a warning (spec §96)
export const VACCINATION_WARNING_HEALTH_STATUSES: string[] = [
  AnimalHealthStatuses.SICK,
  AnimalHealthStatuses.UNDER_TREATMENT,
  AnimalHealthStatuses.QUARANTINE,
];

export const MAX_TEXT_LENGTH = 1000;
export const MAX_BATCH_LENGTH = 60;
export const MAX_LIST_LIMIT = 100;
//historical (backdated) doses may be entered, but not arbitrarily old
export const MAX_BACKDATE_DAYS = 3650;
//a dose can be planned at most this far ahead
export const MAX_SCHEDULE_AHEAD_DAYS = 730;
//tolerance for client/server time-zone differences when rejecting future dates
export const FUTURE_TOLERANCE_HOURS = 24;
//default/maximum reminder window for upcoming doses
export const DEFAULT_UPCOMING_DAYS = 14;
export const MAX_UPCOMING_DAYS = 365;
//sanity cap for a manually entered quantity of stock used for one dose
export const MAX_QUANTITY_USED = 1000;
//cap of the animal history endpoint (one animal rarely has more)
export const MAX_ANIMAL_HISTORY = 500;

//fields a client may never send — the server generates or derives them
export const SERVER_MANAGED_FIELDS = ["vaccinationNo", "farmId", "createdBy", "createdAt", "updatedAt"] as const;
