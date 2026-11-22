import z from "zod";
import {
  VACCINE_LIMITS,
  VaccineAdministrationRoutes,
  VaccineCategories,
  VaccineDosageUnits,
} from "./vaccine.constants.js";

// validateRequest discards the parsed result, so these schemas only reject bad
// requests early; vaccine.services.ts re-whitelists, coerces and runs the
// cross-field (booster) rules on the raw body.

const objectIdString = z
  .string()
  .regex(/^[a-f\d]{24}$/i, { message: "targetDiseaseIds must contain valid ObjectIds" });

const positiveDays = (field: string) =>
  z
    .number({ message: `${field} must be a number` })
    .int({ message: `${field} must be a whole number of days` })
    .min(1, { message: `${field} must be at least 1 day` })
    .max(VACCINE_LIMITS.maxIntervalDays);

const fields = {
  vaccineName: z
    .string({ message: "Vaccine name is required" })
    .trim()
    .min(2, { message: "Vaccine name must be at least 2 characters" })
    .max(150),
  shortCode: z
    .string({ message: "Short code is required" })
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/, {
      message: "shortCode must be 1-20 letters, digits or hyphens",
    }),
  targetDiseaseIds: z.array(objectIdString).max(50),
  manufacturer: z.string().trim().max(150),
  category: z.enum(Object.values(VaccineCategories)),
  dosage: z
    .number({ message: "dosage must be a number" })
    .positive({ message: "dosage must be greater than 0" })
    .max(VACCINE_LIMITS.maxDosage),
  dosageUnit: z.enum(Object.values(VaccineDosageUnits)),
  administrationRoute: z.enum(Object.values(VaccineAdministrationRoutes)),
  minimumAge: z
    .number({ message: "minimumAge must be a number (months)" })
    .min(0, { message: "minimumAge cannot be negative" })
    .max(VACCINE_LIMITS.maxMinimumAgeMonths),
  boosterRequired: z.boolean({ message: "boosterRequired must be a boolean" }),
  boosterAfterDays: positiveDays("boosterAfterDays"),
  repeatIntervalDays: positiveDays("repeatIntervalDays"),
  storageTemperature: z
    .string({ message: "storageTemperature is required" })
    .trim()
    .min(1, { message: "storageTemperature is required" })
    .max(50),
  description: z.string().trim().max(2000),
  isMandatory: z.boolean({ message: "isMandatory must be a boolean" }),
};

//vaccineCode is system-generated and isActive is owned by /toggle-active
const createVaccineValidation = z.object({
  body: z
    .object({
      vaccineName: fields.vaccineName,
      shortCode: fields.shortCode,
      targetDiseaseIds: fields.targetDiseaseIds.optional(),
      manufacturer: fields.manufacturer.optional(),
      category: fields.category,
      dosage: fields.dosage,
      dosageUnit: fields.dosageUnit,
      administrationRoute: fields.administrationRoute,
      minimumAge: fields.minimumAge.optional(),
      boosterRequired: fields.boosterRequired.optional(),
      boosterAfterDays: fields.boosterAfterDays.nullable().optional(),
      repeatIntervalDays: fields.repeatIntervalDays.nullable().optional(),
      storageTemperature: fields.storageTemperature,
      description: fields.description.optional(),
      isMandatory: fields.isMandatory.optional(),
    })
    .refine((body) => !body.boosterRequired || typeof body.boosterAfterDays === "number", {
      message: "boosterAfterDays is required when boosterRequired is true",
      path: ["boosterAfterDays"],
    }),
});

//PUT accepts any subset; null clears an optional field
const updateVaccineValidation = z.object({
  body: z.object({
    vaccineName: fields.vaccineName.optional(),
    shortCode: fields.shortCode.optional(),
    targetDiseaseIds: fields.targetDiseaseIds.optional(),
    manufacturer: fields.manufacturer.nullable().optional(),
    category: fields.category.optional(),
    dosage: fields.dosage.optional(),
    dosageUnit: fields.dosageUnit.optional(),
    administrationRoute: fields.administrationRoute.optional(),
    minimumAge: fields.minimumAge.nullable().optional(),
    boosterRequired: fields.boosterRequired.optional(),
    boosterAfterDays: fields.boosterAfterDays.nullable().optional(),
    repeatIntervalDays: fields.repeatIntervalDays.nullable().optional(),
    storageTemperature: fields.storageTemperature.optional(),
    description: fields.description.nullable().optional(),
    isMandatory: fields.isMandatory.optional(),
  }),
});

//omitting isActive flips the current value
const toggleActiveValidation = z.object({
  body: z
    .object({
      isActive: z.boolean({ message: "isActive must be a boolean" }).optional(),
      reason: z.string().trim().max(500).optional(),
    })
    .optional(),
});

export const vaccineValidations = {
  createVaccineValidation,
  updateVaccineValidation,
  toggleActiveValidation,
};
