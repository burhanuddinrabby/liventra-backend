import z from "zod";
import {
  MEDICINE_LIMITS,
  MedicineAdministrationRoutes,
  MedicineCategories,
  MedicineDosageForms,
} from "./medicine.constants.js";
import { STRENGTH_PATTERN } from "./medicine.utils.js";

// validateRequest discards the parsed result, so these schemas only reject bad
// requests early; medicine.services.ts re-whitelists, coerces and runs the
// cross-field rules (route/form compatibility, duplicates, identity protection).

const text = (field: string, min: number, max: number) =>
  z
    .string({ message: `${field} is required` })
    .trim()
    .min(min, { message: `${field} must be at least ${min} character(s)` })
    .max(max, { message: `${field} cannot exceed ${max} characters` });

const fields = {
  medicineName: text("medicineName", 2, 150),
  genericName: text("genericName", 2, 150),
  brandName: text("brandName", 1, 150),
  manufacturer: text("manufacturer", 2, 150),
  category: z.enum(Object.values(MedicineCategories)),
  dosageForm: z.enum(Object.values(MedicineDosageForms)),
  strength: text("strength", 1, 60).regex(STRENGTH_PATTERN, {
    message: 'strength must start with a number and a unit, e.g. "200 mg/ml", "500 mg" or "10%"',
  }),
  administrationRoute: z.enum(Object.values(MedicineAdministrationRoutes)),
  description: z.string().trim().max(2000),
  storageCondition: text("storageCondition", 2, 200),
  withdrawalPeriodDays: z
    .number({ message: "withdrawalPeriodDays must be a number" })
    .int({ message: "withdrawalPeriodDays must be a whole number of days" })
    .min(0, { message: "withdrawalPeriodDays cannot be negative" })
    .max(MEDICINE_LIMITS.maxWithdrawalPeriodDays),
  prescriptionRequired: z.boolean({ message: "prescriptionRequired must be a boolean" }),
};

//medicineCode is system-generated and isActive is owned by /toggle-active
const createMedicineValidation = z.object({
  body: z.object({
    medicineName: fields.medicineName,
    genericName: fields.genericName,
    brandName: fields.brandName.optional(),
    manufacturer: fields.manufacturer,
    category: fields.category,
    dosageForm: fields.dosageForm,
    strength: fields.strength,
    administrationRoute: fields.administrationRoute,
    description: fields.description.optional(),
    storageCondition: fields.storageCondition,
    withdrawalPeriodDays: fields.withdrawalPeriodDays,
    prescriptionRequired: fields.prescriptionRequired,
  }),
});

//PUT accepts any subset; null / "" clears brandName or description
const updateMedicineValidation = z.object({
  body: z.object({
    medicineName: fields.medicineName.optional(),
    genericName: fields.genericName.optional(),
    brandName: fields.brandName.or(z.literal("")).nullable().optional(),
    manufacturer: fields.manufacturer.optional(),
    category: fields.category.optional(),
    dosageForm: fields.dosageForm.optional(),
    strength: fields.strength.optional(),
    administrationRoute: fields.administrationRoute.optional(),
    description: fields.description.nullable().optional(),
    storageCondition: fields.storageCondition.optional(),
    withdrawalPeriodDays: fields.withdrawalPeriodDays.optional(),
    prescriptionRequired: fields.prescriptionRequired.optional(),
    //short note stored with the audit row ("label revision 2026")
    changeReason: z.string().trim().max(500).optional(),
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

//pre-check used by the create form; every field optional, only identity fields matter
const checkDuplicateValidation = z.object({
  body: z.object({
    medicineName: z.string().trim().max(150).optional(),
    genericName: z.string().trim().max(150).optional(),
    brandName: z.string().trim().max(150).optional(),
    manufacturer: z.string().trim().max(150).optional(),
    strength: z.string().trim().max(60).optional(),
    dosageForm: fields.dosageForm.optional(),
    excludeId: z.string().trim().max(50).optional(),
  }),
});

export const medicineValidations = {
  createMedicineValidation,
  updateMedicineValidation,
  toggleActiveValidation,
  checkDuplicateValidation,
};
