import z from "zod";
import { MedicineAdministrationRoutes } from "../medicine/medicine.constants.js";
import {
  MAX_CONSUME_QUANTITY,
  MAX_DOSAGE,
  MAX_ESTIMATED_COST,
  MAX_MEDICINES,
  MAX_SHORT_TEXT,
  MAX_SYMPTOM_LENGTH,
  MAX_SYMPTOMS,
  MAX_TEXT_LENGTH,
  TreatmentDosageUnits,
  TreatmentStatuses,
} from "./treatment.constants.js";

// validateRequest discards the parsed result, so these schemas only reject bad
// requests early; treatment.services.ts re-parses every field it uses.
// Bodies are .strict(): treatmentNo, farmId, createdBy, completedDate (except via
// status) and timestamps are never accepted.

const objectIdString = (field: string) =>
  z.string().regex(/^[a-f\d]{24}$/i, { message: `${field} must be a valid ObjectId` });
//Mongo _id or a display code (AN-000001 / DIS-00001 / MED-00001)
const reference = z.string().trim().min(1).max(40);
const calendarDate = (field: string) =>
  z.string().regex(/^\d{4}-\d{2}-\d{2}/, { message: `${field} must be YYYY-MM-DD` });
const text = z.string().trim().max(MAX_TEXT_LENGTH);

const medicineLine = z
  .object({
    medicineId: reference,
    dosage: z.number({ message: "dosage must be a number" }).positive({ message: "dosage must be greater than 0" }).max(MAX_DOSAGE),
    dosageUnit: z.enum(Object.values(TreatmentDosageUnits) as [string, ...string[]]),
    frequency: z.string().trim().min(1, { message: "frequency is required" }).max(MAX_SHORT_TEXT),
    duration: z.string().trim().min(1, { message: "duration is required" }).max(MAX_SHORT_TEXT),
    administrationRoute: z.enum(Object.values(MedicineAdministrationRoutes) as [string, ...string[]]),
    instructions: text.optional(),
  })
  .strict();

const symptoms = z.array(z.string().trim().min(1).max(MAX_SYMPTOM_LENGTH)).max(MAX_SYMPTOMS);
const medicines = z.array(medicineLine).max(MAX_MEDICINES);
const estimatedCost = z.number({ message: "estimatedCost must be a number" }).min(0).max(MAX_ESTIMATED_COST);

const createValidation = z.object({
  body: z
    .object({
      animalId: reference,
      diseaseId: reference,
      diagnosisDate: calendarDate("diagnosisDate"),
      symptoms: symptoms.optional(),
      //FarmMember _id; defaults to the caller
      treatedBy: objectIdString("treatedBy").optional(),
      medicines: medicines.min(1, { message: "Add at least one medicine" }),
      estimatedCost: z.union([estimatedCost, z.null()]).optional(),
      followUpDate: z.union([calendarDate("followUpDate"), z.null()]).optional(),
      remarks: text.optional(),
      //acknowledge the possible-duplicate warning and save anyway
      confirmDuplicate: z.boolean().optional(),
    })
    .strict(),
});

const statusValidation = z.object({
  body: z
    .object({
      status: z.enum(Object.values(TreatmentStatuses) as [string, ...string[]]),
      //Recovered: defaults to today
      completedDate: calendarDate("completedDate").optional(),
      //outcome note / referral details / cancellation or reopen reason
      remarks: text.optional(),
      //Cancelled with stock already drawn: true = return to stock, false = keep as used
      restoreStock: z.boolean().optional(),
    })
    .strict(),
});

const consumeValidation = z.object({
  body: z
    .object({
      //omit to draw every prescribed line once (default quantity = dosage when units match)
      items: z
        .array(
          z
            .object({
              //medicines[] line _id, or the medicineId of the line
              lineId: objectIdString("lineId").optional(),
              medicineId: reference.optional(),
              //stock used, in the inventory row's unit
              quantity: z.number().positive().max(MAX_CONSUME_QUANTITY).optional(),
              //pick a specific stock row (otherwise FEFO)
              inventoryId: objectIdString("inventoryId").optional(),
            })
            .strict(),
        )
        .min(1)
        .max(MAX_MEDICINES)
        .optional(),
      remarks: text.optional(),
    })
    .strict(),
});

const updateValidation = z.object({
  body: z
    .object({
      diseaseId: reference.optional(),
      diagnosisDate: calendarDate("diagnosisDate").optional(),
      symptoms: symptoms.optional(),
      treatedBy: objectIdString("treatedBy").optional(),
      medicines: medicines.min(1).optional(),
      estimatedCost: z.union([estimatedCost, z.null()]).optional(),
      followUpDate: z.union([calendarDate("followUpDate"), z.null()]).optional(),
      remarks: text.optional(),
      //why a clinical field (disease / medicines / dates) is being corrected
      reason: text.optional(),
    })
    .strict(),
});

const deleteValidation = z.object({
  body: z.object({ reason: text.optional() }).strict().optional(),
});

export const treatmentValidations = {
  createValidation,
  statusValidation,
  consumeValidation,
  updateValidation,
  deleteValidation,
};
