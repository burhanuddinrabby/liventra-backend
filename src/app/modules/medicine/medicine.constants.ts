// Medicine enums (Model 15). Values follow the final DB schema in
// `.opencode/Business Logics.md` and are stored as-is.
export const MedicineCategories = {
  ANTIBIOTIC: "Antibiotic",
  ANTHELMINTIC: "Anthelmintic",
  ANTIPYRETIC: "Antipyretic",
  VITAMIN: "Vitamin",
  MINERAL: "Mineral",
  PAIN_KILLER: "Pain Killer",
  HORMONE: "Hormone",
  SUPPLEMENT: "Supplement",
  OTHER: "Other",
} as const;

export const MedicineDosageForms = {
  INJECTION: "Injection",
  TABLET: "Tablet",
  BOLUS: "Bolus",
  POWDER: "Powder",
  LIQUID: "Liquid",
  SPRAY: "Spray",
  OINTMENT: "Ointment",
} as const;

export const MedicineAdministrationRoutes = {
  IM: "IM",
  IV: "IV",
  SC: "SC",
  ORAL: "Oral",
  TOPICAL: "Topical",
  INTRANASAL: "Intranasal",
} as const;

// Human labels for the route codes (served via /meta so the UI never hardcodes them)
export const MedicineAdministrationRouteLabels: Record<string, string> = {
  IM: "Intramuscular",
  IV: "Intravenous",
  SC: "Subcutaneous",
  Oral: "Oral",
  Topical: "Topical application",
  Intranasal: "Intranasal",
};

/**
 * Route <-> dosage-form compatibility matrix (spec §19/§23/§75).
 * Project catalog decision — served by GET /medicines/meta so the frontend uses the same rules.
 *  - Injection        -> IM / IV / SC
 *  - Tablet, Bolus    -> Oral
 *  - Powder           -> Oral, Topical (dusting) or IM / IV / SC after reconstitution
 *  - Liquid           -> Oral (drench), Topical (pour-on / dip), Intranasal (drops)
 *  - Spray            -> Topical, Intranasal
 *  - Ointment         -> Topical
 */
export const MEDICINE_ROUTE_COMPATIBILITY: Record<string, readonly string[]> = {
  Injection: ["IM", "IV", "SC"],
  Tablet: ["Oral"],
  Bolus: ["Oral"],
  Powder: ["Oral", "Topical", "IM", "IV", "SC"],
  Liquid: ["Oral", "Topical", "Intranasal"],
  Spray: ["Topical", "Intranasal"],
  Ointment: ["Topical"],
};

export const MEDICINE_CODE_PREFIX = "MED";

export const MEDICINE_LIMITS = {
  //upper bound that keeps obvious typos (7000 days) out of the catalog
  maxWithdrawalPeriodDays: 3650,
} as const;

// Product-identity fields. Once a medicine is referenced by Treatment / Inventory,
// changing one of these would silently re-interpret history, so the API refuses and
// asks for a new Medicine entry instead (spec §14/§70, DO.md "Identity Protection Rule").
export const MEDICINE_IDENTITY_FIELDS = [
  "genericName",
  "brandName",
  "manufacturer",
  "strength",
  "dosageForm",
] as const;

// Collections that may hold a reference to a medicine. Treatment (Model 16) and the
// Inventory API are not built yet, so they are queried by raw collection name
// (a missing collection counts 0). Keep these paths in sync when those modules land.
export const MEDICINE_REFERENCE_SOURCES = [
  {
    key: "treatments",
    collection: "treatments",
    filter: (id: unknown) => ({ "medicines.medicineId": id }),
  },
  {
    key: "inventories",
    collection: "inventories",
    filter: (id: unknown) => ({ itemType: "Medicine", referenceId: id }),
  },
] as const;
