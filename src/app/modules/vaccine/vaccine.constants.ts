// Vaccine enums (Model 12). Values follow the final DB schema in
// `.opencode/Business Logics.md` and are stored as-is.
export const VaccineCategories = {
  VIRAL: "Viral",
  BACTERIAL: "Bacterial",
  PARASITIC: "Parasitic",
  COMBINED: "Combined",
} as const;

export const VaccineDosageUnits = {
  ML: "ml",
  MG: "mg",
  TABLET: "tablet",
  DOSE: "dose",
} as const;

export const VaccineAdministrationRoutes = {
  IM: "IM",
  SC: "SC",
  IV: "IV",
  ORAL: "Oral",
  NASAL: "Nasal",
} as const;

// Human labels for the route codes (served via /meta so the UI never hardcodes them)
export const VaccineAdministrationRouteLabels: Record<string, string> = {
  IM: "Intramuscular",
  SC: "Subcutaneous",
  IV: "Intravenous",
  Oral: "Oral administration",
  Nasal: "Nasal administration",
};

export const VACCINE_CODE_PREFIX = "VAC";

// Upper bounds that keep obviously wrong values (typos like 18000 days) out of the catalog.
export const VACCINE_LIMITS = {
  maxDosage: 10000,
  maxMinimumAgeMonths: 600,
  maxIntervalDays: 3650,
} as const;

// Fields whose change alters the vaccination protocol. They are audited with a
// specific event label (spec §75) and only affect future Vaccination events.
export const VACCINE_PROTOCOL_FIELDS = [
  "dosage",
  "dosageUnit",
  "administrationRoute",
  "minimumAge",
  "boosterRequired",
  "boosterAfterDays",
  "repeatIntervalDays",
  "storageTemperature",
] as const;

// Collections that may hold a reference to a vaccine. Vaccination / Disease are not
// built yet, so they are queried by raw collection name (a missing collection counts 0).
// Keep these paths in sync when those models land.
export const VACCINE_REFERENCE_SOURCES = [
  { key: "vaccinations", collection: "vaccinations", filter: (id: unknown) => ({ vaccineId: id }) },
  {
    key: "diseases",
    collection: "diseases",
    filter: (id: unknown) => ({ recommendedVaccineIds: id }),
  },
  {
    key: "inventories",
    collection: "inventories",
    filter: (id: unknown) => ({ itemType: "Vaccine", referenceId: id }),
  },
] as const;

// Raw collection that holds Disease documents (Model 14, not implemented yet).
export const DISEASE_COLLECTION = "diseases";
