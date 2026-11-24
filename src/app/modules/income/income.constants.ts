// Income (Model 22) enums, from the final DB schema.
export const IncomeCategories = {
  MILK_SALE: "Milk Sale",
  ANIMAL_SALE: "Animal Sale",
  CALF_SALE: "Calf Sale",
  MANURE_SALE: "Manure Sale",
  BREEDING_SERVICE: "Breeding Service",
  INSURANCE_CLAIM: "Insurance Claim",
  GOVERNMENT_SUBSIDY: "Government Subsidy",
  OTHER: "Other",
} as const;

export const IncomeReferenceTypes = {
  MILK_RECORD: "MilkRecord",
  ANIMAL: "Animal",
  BREEDING: "Breeding",
  MANUAL: "Manual",
} as const;

export const IncomeUnits = { LITER: "Liter", KG: "Kg", PIECE: "Piece", SERVICE: "Service" } as const;

export const IncomeStatuses = { PENDING: "Pending", RECEIVED: "Received", CANCELLED: "Cancelled" } as const;

//INC-2026-000001 (atomic per-year counter)
export const INCOME_NO_PREFIX = "INC";
export const INCOME_NO_PATTERN = /^INC-\d{4}-\d{6}$/i;

//POST /incomes; the others have their own workflow
export const MANUAL_CATEGORIES: readonly string[] = [
  IncomeCategories.MANURE_SALE,
  IncomeCategories.INSURANCE_CLAIM,
  IncomeCategories.GOVERNMENT_SUBSIDY,
  IncomeCategories.OTHER,
];

export const ANIMAL_CATEGORIES: readonly string[] = [IncomeCategories.ANIMAL_SALE, IncomeCategories.CALF_SALE];

//which units make sense per category (empty = no quantity at all)
export const CATEGORY_UNITS: Record<string, readonly string[]> = {
  [IncomeCategories.MILK_SALE]: [IncomeUnits.LITER, IncomeUnits.KG],
  [IncomeCategories.ANIMAL_SALE]: [IncomeUnits.PIECE],
  [IncomeCategories.CALF_SALE]: [IncomeUnits.PIECE],
  [IncomeCategories.MANURE_SALE]: [IncomeUnits.KG],
  [IncomeCategories.BREEDING_SERVICE]: [IncomeUnits.SERVICE],
  [IncomeCategories.INSURANCE_CLAIM]: [],
  [IncomeCategories.GOVERNMENT_SUBSIDY]: [],
  [IncomeCategories.OTHER]: Object.values(IncomeUnits),
};
