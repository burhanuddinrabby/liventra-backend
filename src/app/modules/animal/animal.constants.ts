// Animal (Model 05) enums. Values are display strings and are stored as-is,
// the same convention as FarmStatuses / BreedPurposes.

export const AnimalGenders = {
  MALE: "Male",
  FEMALE: "Female",
} as const;

export const AnimalPurposes = {
  DAIRY: "Dairy",
  BEEF: "Beef",
  BREEDING: "Breeding",
  DUAL_PURPOSE: "Dual Purpose",
} as const;

export const AnimalLifeStatuses = {
  ACTIVE: "Active",
  SOLD: "Sold",
  DEAD: "Dead",
  TRANSFERRED: "Transferred",
  ARCHIVED: "Archived",
} as const;

export const AnimalHealthStatuses = {
  HEALTHY: "Healthy",
  SICK: "Sick",
  UNDER_TREATMENT: "Under Treatment",
  QUARANTINE: "Quarantine",
} as const;

export const AnimalReproductiveStatuses = {
  CALF: "Calf",
  HEIFER: "Heifer",
  OPEN: "Open",
  PREGNANT: "Pregnant",
  LACTATING: "Lactating",
  DRY: "Dry",
} as const;

//animalCode is unique within a farm: AN-000001, AN-000002, ...
export const ANIMAL_CODE_PREFIX = "AN";
//qrCode is unique system-wide, so it embeds the public farm code: QR-FARM-00001-AN-000001
export const ANIMAL_QR_PREFIX = "QR";

/**
 * Lifecycle transitions allowed through PATCH /:animalId/lifecycle.
 * Sold / Dead / Transferred are terminal — history is preserved and the record is read-only.
 * Archived can be reactivated (spec audit event "Animal Reactivated").
 */
export const AllowedLifeStatusTransitions: Record<string, readonly string[]> = {
  [AnimalLifeStatuses.ACTIVE]: [
    AnimalLifeStatuses.SOLD,
    AnimalLifeStatuses.DEAD,
    AnimalLifeStatuses.TRANSFERRED,
    AnimalLifeStatuses.ARCHIVED,
  ],
  [AnimalLifeStatuses.ARCHIVED]: [AnimalLifeStatuses.ACTIVE],
  [AnimalLifeStatuses.SOLD]: [],
  [AnimalLifeStatuses.DEAD]: [],
  [AnimalLifeStatuses.TRANSFERRED]: [],
};

//reproductive states that are biologically impossible for a male animal
export const FEMALE_ONLY_REPRODUCTIVE_STATUSES: readonly string[] = [
  AnimalReproductiveStatuses.HEIFER,
  AnimalReproductiveStatuses.PREGNANT,
  AnimalReproductiveStatuses.LACTATING,
  AnimalReproductiveStatuses.DRY,
];

//states that require a sexually mature animal (rejected when birthDate shows < MIN_MATURE_AGE_MONTHS)
export const MATURE_ONLY_REPRODUCTIVE_STATUSES: readonly string[] = [
  AnimalReproductiveStatuses.PREGNANT,
  AnimalReproductiveStatuses.LACTATING,
  AnimalReproductiveStatuses.DRY,
];
export const MIN_MATURE_AGE_MONTHS = 9;

//financial fields — hidden from Worker / Veterinarian ("Workers can't see the finances")
export const ANIMAL_FINANCIAL_FIELDS = ["purchasePrice", "supplierId"] as const;

//gallery upload limit per request (multer) and overall cap per animal
export const MAX_GALLERY_UPLOAD = 10;
export const MAX_GALLERY_ITEMS = 50;
