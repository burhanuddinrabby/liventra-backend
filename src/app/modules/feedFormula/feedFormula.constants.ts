// FeedFormula enums (Model 07). Values follow the final DB schema in
// `.opencode/Business Logics.md` and are stored as-is (display strings).
export const FeedFormulaStages = {
  CALF: "Calf",
  GROWING: "Growing",
  HEIFER: "Heifer",
  LACTATING: "Lactating",
  DRY: "Dry",
  BREEDING: "Breeding",
} as const;

export const FeedFormulaPurposes = {
  MAINTENANCE: "Maintenance",
  BREEDING: "Breeding",
  GROWTH: "Growth",
  MILK_PRODUCTION: "Milk Production",
} as const;

export const FeedFormulaSeasons = {
  SUMMER: "Summer",
  WINTER: "Winter",
  RAINY: "Rainy",
  ALL_SEASON: "All Season",
} as const;

export const FEED_FORMULA_CODE_PREFIX = "FF";

//formulation basis: `percentage` is the share of the total as-fed mix, so the
//percentages of one formula must sum to 100 (± tolerance for rounding)
export const PERCENTAGE_TOTAL = 100;
export const PERCENTAGE_SUM_TOLERANCE = 0.5;
//each stated percentage must agree with its quantity share of the mix (percentage points)
export const PERCENTAGE_QUANTITY_TOLERANCE = 2;

export const MAX_FORMULA_INGREDIENTS = 50;

/**
 * Centralized unit conversion. Formula lines may use a unit different from the
 * ingredient's master unit only when it converts within the same dimension.
 * `toBase` converts to kg (mass) / liter (volume); volumes are treated as
 * 1 kg/L for mass-based nutrition (documented approximation, water density).
 * `piece` is countable and never converts to mass.
 */
export const UnitConversions = {
  kg: { dimension: "mass", toBase: 1 },
  g: { dimension: "mass", toBase: 0.001 },
  liter: { dimension: "volume", toBase: 1 },
  ml: { dimension: "volume", toBase: 0.001 },
  piece: { dimension: "count", toBase: 1 },
} as const;

//reference units of the calculated formula-level values (exposed via /meta)
export const FeedFormulaNutritionUnits = {
  dryMatter: "kg DM/day",
  crudeProtein: "% of DM",
  energy: "Mcal/kg DM",
  estimatedDailyCost: "BDT/day",
  targetWeightRange: "kg",
  targetMilkYield: "L/day",
  targetADG: "kg/day",
} as const;

/**
 * Fields whose change alters the scientific rule. Changing any of them on a
 * formula already used by FeedRecommendation snapshots creates a new version
 * instead of overwriting it (historical traceability).
 */
export const FEED_FORMULA_SCIENTIFIC_FIELDS = [
  "breedId",
  "stage",
  "purpose",
  "season",
  "targetWeightRange",
  "targetMilkYield",
  "targetADG",
  "ingredients",
  "ruleVersion",
] as const;

//descriptive fields that may always be edited in place
export const FEED_FORMULA_METADATA_FIELDS = ["formulaName", "description"] as const;

// Collections that hold a reference to a formula, queried by raw collection name
// (a missing collection counts 0). `feedrecommendations` = FeedRecommendationModel.
export const FEED_FORMULA_REFERENCE_SOURCES = [
  { key: "feedRecommendations", collection: "feedrecommendations", path: "formulaId" },
] as const;

//Animal.reproductiveStatus values that map 1:1 to a formula stage (used by /match)
export const REPRODUCTIVE_STATUS_TO_STAGE: Record<string, string> = {
  Calf: FeedFormulaStages.CALF,
  Heifer: FeedFormulaStages.HEIFER,
  Lactating: FeedFormulaStages.LACTATING,
  Dry: FeedFormulaStages.DRY,
};

//Animal.purpose → formula purpose (Dual Purpose is ambiguous and is not mapped)
export const ANIMAL_PURPOSE_TO_FORMULA_PURPOSE: Record<string, string> = {
  Dairy: FeedFormulaPurposes.MILK_PRODUCTION,
  Beef: FeedFormulaPurposes.GROWTH,
  Breeding: FeedFormulaPurposes.BREEDING,
};

/**
 * Bangladesh season used by /match when the caller sends none (month 0-based):
 * Summer Mar–Jun, Rainy Jul–Oct, Winter Nov–Feb.
 */
export const seasonForMonth = (month: number): string => {
  if (month >= 2 && month <= 5) return FeedFormulaSeasons.SUMMER;
  if (month >= 6 && month <= 9) return FeedFormulaSeasons.RAINY;
  return FeedFormulaSeasons.WINTER;
};
