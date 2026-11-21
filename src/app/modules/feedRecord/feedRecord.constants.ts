// FeedRecord (Model 09) — what was ACTUALLY fed to one animal in one feeding session.
// Field names follow the new model in DO.md (feedingSession, totalFeedQuantity, remarks).
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";
import { FeedRecommendationStatuses } from "../feedRecommendation/feedRecommendation.constants.js";
import { AnimalHealthStatuses } from "../animal/animal.constants.js";

export const FeedingSessions = {
  MORNING: "Morning",
  AFTERNOON: "Afternoon",
  EVENING: "Evening",
  NIGHT: "Night",
} as const;

//chronological order inside one day (used for sorting daily summaries)
export const FEEDING_SESSION_ORDER: Record<string, number> = {
  [FeedingSessions.MORNING]: 1,
  [FeedingSessions.AFTERNOON]: 2,
  [FeedingSessions.EVENING]: 3,
  [FeedingSessions.NIGHT]: 4,
};

const { OWNER, MANAGER, WORKER, VETERINARIAN, ACCOUNTANT } = FarmMemberRoles;

/**
 * Farm-role permissions (DO.md route table + final schema CRUD table).
 * Every active member reads. Veterinarian / Accountant are read-only.
 * PUT is a controlled correction (Owner / Manager); DELETE is a voiding reversal (Owner).
 */
export const FeedRecordPermissions = {
  READ: [OWNER, MANAGER, WORKER, VETERINARIAN, ACCOUNTANT],
  CREATE: [OWNER, MANAGER, WORKER],
  UPDATE: [OWNER, MANAGER],
  DELETE: [OWNER],
  //log a feeding although farm stock is short (stock is drawn down to 0, never negative)
  OVERRIDE_STOCK: [OWNER, MANAGER],
  //enter an actual price different from the catalog reference price
  OVERRIDE_PRICE: [OWNER, MANAGER],
  //change history + voided records
  AUDIT: [OWNER, MANAGER],
} as const;

//a feeding may follow an official plan; Superseded is allowed for backdated entries
export const LINKABLE_RECOMMENDATION_STATUSES: string[] = [
  FeedRecommendationStatuses.CONFIRMED,
  FeedRecommendationStatuses.EXPERT_APPROVED,
  FeedRecommendationStatuses.SUPERSEDED,
];

//feeding is allowed but the response carries a warning (spec §43)
export const FEEDING_WARNING_HEALTH_STATUSES: string[] = [
  AnimalHealthStatuses.SICK,
  AnimalHealthStatuses.UNDER_TREATMENT,
  AnimalHealthStatuses.QUARANTINE,
];

export const MAX_ITEMS_PER_RECORD = 30;
//sanity cap per line, in the line's own unit
export const MAX_ITEM_QUANTITY = 100_000;
export const MAX_UNIT_PRICE = 1_000_000;
//backdated entries are allowed (spec §46–47) but not arbitrarily old
export const MAX_BACKDATE_DAYS = 365;
//tolerance for client/server time-zone differences when rejecting future dates
export const FUTURE_TOLERANCE_HOURS = 24;
export const MAX_TEXT_LENGTH = 1000;
export const MAX_LIST_LIMIT = 100;
//adherence variance band treated as "on plan"
export const ADHERENCE_TOLERANCE_PERCENT = 10;
//days covered by /stats and the animal daily summary when no range is given
export const DEFAULT_SUMMARY_DAYS = 30;
export const MAX_SUMMARY_DAYS = 366;

//fields a client may never send — the server calculates or snapshots them
export const SERVER_CALCULATED_FIELDS = [
  "totalFeedQuantity",
  "totalCost",
  "isVoided",
  "voidedAt",
  "voidedBy",
  "voidReason",
  "farmId",
] as const;
