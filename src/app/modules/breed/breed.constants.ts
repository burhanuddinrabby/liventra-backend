export const BreedCategories = {
  INDIGENOUS: "Indigenous",
  CROSSBREED: "Crossbreed",
  EXOTIC: "Exotic",
} as const;

export const BreedPurposes = {
  DAIRY: "Dairy",
  BEEF: "Beef",
  DUAL_PURPOSE: "Dual Purpose",
  BREEDING: "Breeding",
} as const;

// heatTolerance and diseaseResistance share the same allowed values
export const ResistanceLevels = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
} as const;

export const Temperaments = {
  CALM: "Calm",
  MODERATE: "Moderate",
  AGGRESSIVE: "Aggressive",
} as const;

export const BREED_CODE_PREFIX = "BREED";
