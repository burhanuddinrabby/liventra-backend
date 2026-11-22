import z from "zod";
import {
  MAX_BATCH_LENGTH,
  MAX_QUANTITY_USED,
  MAX_TEXT_LENGTH,
  VaccinationStatuses,
} from "./vaccination.constants.js";

// validateRequest discards the parsed result, so these schemas only reject bad
// requests early; vaccination.services.ts re-parses every field it uses.
// Bodies are .strict(): vaccinationNo, farmId, createdBy and timestamps are never
// accepted, and nextDueDate is derived on create/complete.

const objectIdString = (field: string) =>
  z.string().regex(/^[a-f\d]{24}$/i, { message: `${field} must be a valid ObjectId` });

//Mongo _id or a display code (AN-000001 / VAC-00001)
const reference = z.string().trim().min(1).max(40);
const calendarDate = (field: string) =>
  z.string().regex(/^\d{4}-\d{2}-\d{2}/, { message: `${field} must be YYYY-MM-DD` });
const text = z.string().trim().max(MAX_TEXT_LENGTH);
const batchNumber = z.string().trim().min(1, { message: "batchNumber cannot be empty" }).max(MAX_BATCH_LENGTH);
const quantityUsed = z
  .number({ message: "quantityUsed must be a number" })
  .positive({ message: "quantityUsed must be greater than 0" })
  .max(MAX_QUANTITY_USED);

const createBody = z
  .object({
    animalId: reference,
    vaccineId: reference,
    //defaults to Scheduled
    status: z.enum([VaccinationStatuses.SCHEDULED, VaccinationStatuses.COMPLETED]).optional(),
    vaccinationDate: calendarDate("vaccinationDate"),
    administeredBy: objectIdString("administeredBy").optional(),
    batchNumber: batchNumber.optional(),
    remarks: text.optional(),
    //stock used for this dose, in the inventory unit (Completed only)
    quantityUsed: quantityUsed.optional(),
  })
  .strict();

const createValidation = z.object({ body: createBody });
const previewValidation = z.object({ body: createBody });

const completeValidation = z.object({
  body: z
    .object({
      //actual administration date; defaults to today
      vaccinationDate: calendarDate("vaccinationDate").optional(),
      //FarmMember _id of the person who gave the dose (UI pre-fills the caller)
      administeredBy: objectIdString("administeredBy"),
      batchNumber,
      remarks: text.optional(),
      quantityUsed: quantityUsed.optional(),
    })
    .strict(),
});

const statusValidation = z.object({
  body: z
    .object({
      status: z.enum([VaccinationStatuses.MISSED, VaccinationStatuses.CANCELLED]),
      //reason for the miss / cancellation, stored in remarks
      remarks: z.string().trim().min(3, { message: "Give a reason (at least 3 characters)" }).max(MAX_TEXT_LENGTH),
      //optional follow-up Scheduled record (keeps the missed event as history)
      reschedule: z
        .object({
          vaccinationDate: calendarDate("reschedule.vaccinationDate"),
          remarks: text.optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
});

const updateValidation = z.object({
  body: z
    .object({
      vaccineId: reference.optional(),
      vaccinationDate: calendarDate("vaccinationDate").optional(),
      nextDueDate: z.union([calendarDate("nextDueDate"), z.null()]).optional(),
      administeredBy: objectIdString("administeredBy").optional(),
      batchNumber: z.union([batchNumber, z.null()]).optional(),
      remarks: text.optional(),
      quantityUsed: quantityUsed.optional(),
      //why a Completed record is being corrected (required for Completed)
      reason: text.optional(),
    })
    .strict(),
});

export const vaccinationValidations = {
  createValidation,
  previewValidation,
  completeValidation,
  statusValidation,
  updateValidation,
};
