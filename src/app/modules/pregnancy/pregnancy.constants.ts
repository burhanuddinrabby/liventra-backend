// Pregnancy (Model 18) enums. Values follow the final DB schema in
// `.opencode/Business Logics.md` and are stored as-is.
// Only the Breeding module writes Pregnancy rows today (confirmation / correction);
// the full Pregnancy routes (delivery, abortion, calving) are a later module.

export const PregnancyStatuses = {
  PREGNANT: "Pregnant",
  DELIVERED: "Delivered",
  ABORTED: "Aborted",
  FAILED: "Failed",
} as const;

export const CalfGenders = {
  MALE: "Male",
  FEMALE: "Female",
  TWIN: "Twin",
} as const;

//PRG-2026-000001 (final schema example) — atomic per-year counter
export const PREGNANCY_NO_PREFIX = "PRG";
export const PREGNANCY_NO_PATTERN = /^PRG-\d{4}-\d{6}$/i;

/**
 * Average cattle gestation (days). Liventra animals are cattle (no species field),
 * so expectedCalvingDate = conceptionDate + CATTLE_GESTATION_DAYS unless the
 * caller records a vet-estimated date inside the allowed window below.
 */
export const CATTLE_GESTATION_DAYS = 283;
export const MIN_GESTATION_DAYS = 240;
export const MAX_GESTATION_DAYS = 320;

export const MAX_PREGNANCY_TEXT = 2000;
