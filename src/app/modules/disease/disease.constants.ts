// Disease enums (Model 14). Values follow the final DB schema in
// `.opencode/Business Logics.md` and are stored as-is.
export const DiseaseCategories = {
  VIRAL: "Viral",
  BACTERIAL: "Bacterial",
  PARASITIC: "Parasitic",
  METABOLIC: "Metabolic",
  NUTRITIONAL: "Nutritional",
  REPRODUCTIVE: "Reproductive",
  OTHER: "Other",
} as const;

export const DiseaseSeverities = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  CRITICAL: "Critical",
} as const;

//example: DIS-00001 (final schema format)
export const DISEASE_CODE_PREFIX = "DIS";

//size guards for the master record (keeps typos / pasted essays out of the catalog)
export const DISEASE_LIMITS = {
  maxNameLength: 150,
  maxListItems: 50,
  maxListItemLength: 150,
  maxPreventionLength: 2000,
  maxDescriptionLength: 5000,
  maxRecommendedVaccines: 50,
  maxSymptomQuery: 20,
} as const;

//fields whose change alters health workflows; audited with a specific event label (spec §48/§69)
export const DISEASE_CLINICAL_FIELDS = [
  "diseaseName",
  "category",
  "symptoms",
  "causes",
  "prevention",
  "severity",
  "contagious",
  "recommendedVaccineIds",
] as const;

//filler words ignored when building a name's initials ("Foot and Mouth Disease" → FMD)
export const DISEASE_NAME_STOP_WORDS = new Set(["and", "of", "the", "in", "a", "an", "&"]);

// Collections that may hold a reference to a disease. Treatment is not built yet, so it is
// queried by raw collection name (a missing collection counts 0). Both the finalized
// single `diseaseId` and the older `diseaseIds[]` shape are checked.
export const DISEASE_REFERENCE_SOURCES = [
  {
    key: "treatments",
    collection: "treatments",
    filter: (id: unknown) => ({ $or: [{ diseaseId: id }, { diseaseIds: id }] }),
  },
  {
    key: "vaccines",
    collection: "vaccines",
    filter: (id: unknown) => ({ targetDiseaseIds: id }),
  },
] as const;

//shown with every symptom search result (spec §16/§44 clinical safety rule)
export const SYMPTOM_SEARCH_DISCLAIMER =
  "Reference lookup only — symptoms overlap across diseases. This is not a diagnosis; confirm with a veterinarian.";
