// FeedIngredient enums (Model 06). Values follow the final DB schema in
// `.opencode/Business Logics.md` and are stored as-is.
// The final schema explicitly drops "ton" and "bag" as units.
export const FeedIngredientUnits = {
  KG: "kg",
  G: "g",
  LITER: "liter",
  ML: "ml",
  PIECE: "piece",
} as const;

export const FeedIngredientCategories = {
  ROUGHAGE: "Roughage",
  CONCENTRATE: "Concentrate",
  PROTEIN_SUPPLEMENT: "Protein Supplement",
  MINERAL: "Mineral",
  VITAMIN: "Vitamin",
  ADDITIVE: "Additive",
} as const;

export const FEED_INGREDIENT_CODE_PREFIX = "ING";

// Reference units for the nutrition fields (final schema). Exposed via /meta so the
// UI labels values consistently; energy must never mix units across ingredients.
export const FeedIngredientNutritionUnits = {
  dryMatterPercentage: "%",
  crudeProtein: "%",
  crudeFiber: "%",
  energy: "Mcal/kg",
  calcium: "%",
  phosphorus: "%",
} as const;

// Nutrition values whose change must be audited as "Ingredient Nutrition Changed".
export const FEED_INGREDIENT_NUTRITION_FIELDS = [
  "dryMatterPercentage",
  "crudeProtein",
  "crudeFiber",
  "energy",
  "calcium",
  "phosphorus",
] as const;

// Nutrition fields that are percentages and therefore capped at 100.
export const FEED_INGREDIENT_PERCENT_FIELDS = [
  "dryMatterPercentage",
  "crudeProtein",
  "crudeFiber",
  "calcium",
  "phosphorus",
] as const;

// Required by the final schema; calcium / phosphorus / availability are optional.
export const FEED_INGREDIENT_REQUIRED_NUMERIC_FIELDS = [
  "dryMatterPercentage",
  "crudeProtein",
  "crudeFiber",
  "energy",
  "pricePerUnit",
] as const;

export const FEED_INGREDIENT_OPTIONAL_NUMERIC_FIELDS = [
  "calcium",
  "phosphorus",
  "availability",
] as const;

// Collections that may hold a reference to an ingredient. The owning modules are
// not built yet, so they are queried by raw collection name (a missing collection
// simply counts 0). Keep these paths in sync when those models land.
export const FEED_INGREDIENT_REFERENCE_SOURCES = [
  { key: "feedFormulas", collection: "feedformulas", path: "ingredients.ingredientId" },
  { key: "feedRecommendations", collection: "feedrecommendations", path: "recommendedItems.ingredientId" },
  { key: "feedRecords", collection: "feedrecords", path: "items.ingredientId" },
  { key: "inventories", collection: "inventories", path: "referenceId" },
] as const;
