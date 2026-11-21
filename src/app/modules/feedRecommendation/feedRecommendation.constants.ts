// FeedRecommendation (Model 08) enums and rule-engine constants. Status values
// follow the final DB schema in `.opencode/Business Logics.md` and are stored as-is
// (display strings), the same convention as the other modules.
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";
import type { TFeedRecommendationStatus } from "./feedRecommendation.interface.js";

export const FeedRecommendationStatuses = {
  DRAFT: "Draft",
  CONFIRMED: "Confirmed",
  EXPERT_APPROVED: "Expert Approved",
  REJECTED: "Rejected",
  SUPERSEDED: "Superseded",
} as const;

const { DRAFT, CONFIRMED, EXPERT_APPROVED, REJECTED, SUPERSEDED } = FeedRecommendationStatuses;

//the "current plan" of an animal is its newest record in one of these statuses
export const ACTIVE_RECOMMENDATION_STATUSES: TFeedRecommendationStatus[] = [CONFIRMED, EXPERT_APPROVED];

//official records are historical evidence and can never be hard-deleted
export const OFFICIAL_RECOMMENDATION_STATUSES: TFeedRecommendationStatus[] = [
  CONFIRMED,
  EXPERT_APPROVED,
  SUPERSEDED,
  REJECTED,
];

//statuses a new record may be saved with (POST /feed-recommendations)
export const CREATABLE_STATUSES: readonly string[] = [DRAFT, CONFIRMED];

/**
 * PATCH /:id/status — farm lifecycle (Owner / Manager).
 * Superseded is never set by hand: it only happens when a newer record is confirmed.
 */
export const StatusTransitions: Record<string, readonly string[]> = {
  [DRAFT]: [CONFIRMED, REJECTED],
  [CONFIRMED]: [REJECTED],
  [EXPERT_APPROVED]: [],
  [REJECTED]: [],
  [SUPERSEDED]: [],
};

//PATCH /:id/review — optional expert validation (Owner / Manager / Veterinarian)
export const ReviewTransitions: Record<string, readonly string[]> = {
  [CONFIRMED]: [EXPERT_APPROVED, REJECTED],
};

const { OWNER, MANAGER, WORKER, VETERINARIAN } = FarmMemberRoles;

/**
 * Farm-role permissions (DO.md route table + Business Logics "CRUD Rules").
 * Reading is any active member of the farm.
 */
export const FeedRecommendationPermissions = {
  PREVIEW: [OWNER, MANAGER, WORKER, VETERINARIAN],
  CREATE: [OWNER, MANAGER],
  STATUS: [OWNER, MANAGER],
  //Veterinarian = the farm's "Expert"
  REVIEW: [OWNER, MANAGER, VETERINARIAN],
  DELETE: [OWNER],
  AUDIT: [OWNER, MANAGER, VETERINARIAN],
} as const;

//fields frozen at generation time; PATCH endpoints reject any attempt to send them
export const IMMUTABLE_SNAPSHOT_FIELDS = [
  "recommendationNo",
  "farmId",
  "animalId",
  "formulaId",
  "generatedAt",
  "inputSnapshot",
  "recommendedItems",
  "totalRecommendedDMI",
  "estimatedDailyCost",
  "explanation",
  "warnings",
  "ruleVersion",
  "createdBy",
] as const;

//REC-2026-000001 — per-year atomic sequence
export const RECOMMENDATION_NO_PREFIX = "REC";

/* -------------------------------------------------------------------------- */
/*                          Rule engine (version v1.0)                        */
/* -------------------------------------------------------------------------- */

/**
 * Version of the recommendation rules below. Bump it whenever a factor changes so
 * saved snapshots stay comparable by rule version (thesis evaluation, §69).
 */
export const RECOMMENDATION_RULE_VERSION = "v1.0";

/**
 * Daily dry-matter intake as a share of body weight (% BW), by formula stage.
 * Lactating animals additionally get MILK_DMI_PER_LITER kg DM per liter of milk.
 */
export const DMI_PERCENT_OF_BODY_WEIGHT: Record<string, number> = {
  Calf: 3.0,
  Growing: 2.75,
  Heifer: 2.5,
  Lactating: 2.5,
  Dry: 2.0,
  Breeding: 2.25,
};
export const MILK_DMI_PER_LITER = 0.1;
//extra kg DM/day per 1 kg/day of requested ADG above the formula's target ADG
export const ADG_DMI_PER_KG = 1.0;

//heat stress lowers intake in summer; cold raises maintenance needs in winter
export const SEASON_DMI_FACTOR: Record<string, number> = {
  Summer: 0.95,
  Rainy: 1.0,
  Winter: 1.05,
  "All Season": 1.0,
};

//formula quantities are scaled to the required DMI within these bounds
export const MIN_SCALE_FACTOR = 0.5;
export const MAX_SCALE_FACTOR = 2.0;

//minimum crude protein (% of DM) before a "Low Protein Diet" warning, by stage
export const MIN_CRUDE_PROTEIN: Record<string, number> = {
  Calf: 16,
  Growing: 14,
  Heifer: 12,
  Lactating: 14,
  Dry: 10,
  Breeding: 12,
};

//data-freshness checks (days)
export const STALE_WEIGHT_DAYS = 30;
export const MILK_LOOKBACK_DAYS = 7;

//health statuses that need a veterinary look before feeding changes
export const HEALTH_REVIEW_STATUSES: readonly string[] = ["Sick", "Under Treatment", "Quarantine"];

//not-yet-built modules are read by raw collection name (a missing collection = no data)
export const MILK_RECORD_COLLECTION = "milkrecords";
export const WEIGHT_RECORD_COLLECTION = "weightrecords";

export const MAX_TEXT_LENGTH = 1000;
export const MAX_LIST_LIMIT = 100;
