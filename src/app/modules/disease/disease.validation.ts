import z from "zod";
import { DISEASE_LIMITS, DiseaseCategories, DiseaseSeverities } from "./disease.constants.js";

// validateRequest discards the parsed result, so these schemas only reject bad
// requests early; disease.services.ts re-whitelists, trims, de-duplicates and runs
// the reference checks on the raw body.

const objectIdString = z
  .string()
  .regex(/^[a-f\d]{24}$/i, { message: "must contain valid Vaccine ObjectIds" });

const stringList = (field: string) =>
  z
    .array(
      z
        .string({ message: `${field} items must be strings` })
        .trim()
        .min(1, { message: `${field} items cannot be empty` })
        .max(DISEASE_LIMITS.maxListItemLength),
      { message: `${field} must be an array of strings` },
    )
    .max(DISEASE_LIMITS.maxListItems, { message: `${field} cannot exceed ${DISEASE_LIMITS.maxListItems} items` });

const fields = {
  diseaseName: z
    .string({ message: "Disease name is required" })
    .trim()
    .min(2, { message: "Disease name must be at least 2 characters" })
    .max(DISEASE_LIMITS.maxNameLength),
  category: z.enum(Object.values(DiseaseCategories), {
    message: `category must be one of: ${Object.values(DiseaseCategories).join(", ")}`,
  }),
  symptoms: stringList("symptoms"),
  causes: stringList("causes"),
  prevention: z.string().trim().max(DISEASE_LIMITS.maxPreventionLength),
  severity: z.enum(Object.values(DiseaseSeverities), {
    message: `severity must be one of: ${Object.values(DiseaseSeverities).join(", ")}`,
  }),
  contagious: z.boolean({ message: "contagious must be a boolean" }),
  recommendedVaccineIds: z.array(objectIdString).max(DISEASE_LIMITS.maxRecommendedVaccines),
  description: z.string().trim().max(DISEASE_LIMITS.maxDescriptionLength),
  syncVaccineTargets: z.boolean({ message: "syncVaccineTargets must be a boolean" }),
  confirmDuplicate: z.boolean({ message: "confirmDuplicate must be a boolean" }),
};

//diseaseCode is system-generated and isActive is owned by /toggle-active
const createDiseaseValidation = z.object({
  body: z.object({
    diseaseName: fields.diseaseName,
    category: fields.category,
    symptoms: fields.symptoms.min(1, { message: "At least one symptom is required" }),
    causes: fields.causes.optional(),
    prevention: fields.prevention.optional(),
    severity: fields.severity,
    contagious: fields.contagious.optional(),
    recommendedVaccineIds: fields.recommendedVaccineIds.optional(),
    description: fields.description.optional(),
    syncVaccineTargets: fields.syncVaccineTargets.optional(),
    confirmDuplicate: fields.confirmDuplicate.optional(),
  }),
});

//PUT accepts any subset; null clears prevention / description
const updateDiseaseValidation = z.object({
  body: z.object({
    diseaseName: fields.diseaseName.optional(),
    category: fields.category.optional(),
    symptoms: fields.symptoms.min(1, { message: "At least one symptom is required" }).optional(),
    causes: fields.causes.optional(),
    prevention: fields.prevention.nullable().optional(),
    severity: fields.severity.optional(),
    contagious: fields.contagious.optional(),
    recommendedVaccineIds: fields.recommendedVaccineIds.optional(),
    description: fields.description.nullable().optional(),
    syncVaccineTargets: fields.syncVaccineTargets.optional(),
    confirmDuplicate: fields.confirmDuplicate.optional(),
  }),
});

//add ($addToSet) and/or remove ($pull) vaccine links without resending the whole list
const recommendedVaccinesValidation = z.object({
  body: z
    .object({
      add: fields.recommendedVaccineIds.optional(),
      remove: fields.recommendedVaccineIds.optional(),
      syncVaccineTargets: fields.syncVaccineTargets.optional(),
    })
    .refine((body) => (body.add?.length ?? 0) + (body.remove?.length ?? 0) > 0, {
      message: "Provide at least one vaccine id in add or remove",
      path: ["add"],
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

export const diseaseValidations = {
  createDiseaseValidation,
  updateDiseaseValidation,
  recommendedVaccinesValidation,
  toggleActiveValidation,
};
