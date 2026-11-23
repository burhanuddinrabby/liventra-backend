import z from "zod";
import { BreedingMethods, MAX_SHORT_TEXT, MAX_TEXT_LENGTH, PregnancyResults } from "./breeding.constants.js";

// validateRequest discards the parsed result, so these schemas only reject bad
// requests early; breeding.services.ts re-parses every field it uses.
// Bodies are .strict(): breedingNo, farmId, createdBy, pregnancyResult (on create /
// update) and timestamps are never accepted.

//Mongo _id or a display code (AN-000001)
const reference = z.string().trim().min(1).max(40);
const calendarDate = (field: string) =>
  z.string().regex(/^\d{4}-\d{2}-\d{2}/, { message: `${field} must be YYYY-MM-DD` });
const text = z.string().trim().max(MAX_TEXT_LENGTH);
const shortText = z.string().trim().max(MAX_SHORT_TEXT);
const method = z.enum(Object.values(BreedingMethods) as [string, ...string[]]);

const createValidation = z.object({
  body: z
    .object({
      animalId: reference,
      heatDetectedDate: calendarDate("heatDetectedDate"),
      inseminationDate: z.union([calendarDate("inseminationDate"), z.null()]).optional(),
      breedingMethod: method,
      bullId: z.union([reference, z.null()]).optional(),
      semenBatchNo: z.union([shortText, z.null()]).optional(),
      technicianName: shortText.min(2, { message: "technicianName is required" }),
      //defaults to service date + 35 days
      expectedPregnancyCheckDate: calendarDate("expectedPregnancyCheckDate").optional(),
      remarks: text.optional(),
      //acknowledge the possible-duplicate warning and save anyway
      confirmDuplicate: z.boolean().optional(),
    })
    .strict(),
});

const resultValidation = z.object({
  body: z
    .object({
      pregnancyResult: z.enum(Object.values(PregnancyResults) as [string, ...string[]]),
      //Confirmed: defaults to inseminationDate
      conceptionDate: calendarDate("conceptionDate").optional(),
      //Confirmed: defaults to conceptionDate + 283 days
      expectedCalvingDate: calendarDate("expectedCalvingDate").optional(),
      //day the examination was done (no schema field — kept in remarks / audit)
      checkDate: calendarDate("checkDate").optional(),
      //acknowledge a confirmation before expectedPregnancyCheckDate (externally verified)
      earlyCheck: z.boolean().optional(),
      remarks: text.optional(),
      //required for corrections (Failed → Confirmed / Pending, Confirmed → Failed)
      reason: text.optional(),
    })
    .strict(),
});

const updateValidation = z.object({
  body: z
    .object({
      heatDetectedDate: calendarDate("heatDetectedDate").optional(),
      inseminationDate: z.union([calendarDate("inseminationDate"), z.null()]).optional(),
      breedingMethod: method.optional(),
      bullId: z.union([reference, z.null()]).optional(),
      semenBatchNo: z.union([shortText, z.null()]).optional(),
      technicianName: shortText.min(2).optional(),
      expectedPregnancyCheckDate: calendarDate("expectedPregnancyCheckDate").optional(),
      remarks: text.optional(),
      //why the record is being corrected (required for dates / method / bull)
      reason: text.optional(),
    })
    .strict(),
});

export const breedingValidations = {
  createValidation,
  resultValidation,
  updateValidation,
};
