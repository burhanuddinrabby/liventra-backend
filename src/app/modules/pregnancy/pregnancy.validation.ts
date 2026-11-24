import z from "zod";
import {
  CalfGenders,
  MAX_REMARKS,
  PregnancyStatuses,
} from "./pregnancy.constants.js";

// validateRequest discards the parsed result, so these schemas only reject bad
// requests early; pregnancy.services.ts re-parses every field it uses.
// Bodies are .strict(): pregnancyNo, farmId, createdBy, createdAt, updatedAt,
// _id are never accepted from the client.

//Mongo _id or a display code (AN-000001 / PRG-YYYY-NNNNNN / BRD-YYYY-NNNNNN)
const reference = z.string().trim().min(1).max(40);
const calendarDate = (field: string) =>
  z.string().regex(/^\d{4}-\d{2}-\d{2}/, { message: `${field} must be YYYY-MM-DD` });
const text = z.string().trim().max(MAX_REMARKS);
const shortText = z.string().trim().max(100);
const pregnancyStatus = z.enum(Object.values(PregnancyStatuses) as [string, ...string[]]);
const calfGender = z.enum(Object.values(CalfGenders) as [string, ...string[]]);

/**
 * POST /farms/:farmId/pregnancies — create a pregnancy from a confirmed Breeding.
 *  - breedingId: the confirmed Breeding this pregnancy came from (required)
 *  - conceptionDate: optional, defaults to the breeding's insemination date
 *  - expectedCalvingDate: optional, defaults to conceptionDate + 283 days
 *  - remarks: optional
 */
const createValidation = z.object({
  body: z
    .object({
      breedingId: reference,
      //date the conception was recorded (defaults to inseminationDate)
      conceptionDate: calendarDate("conceptionDate").optional(),
      //vet-estimated due date, must be 240–320 days after conception
      expectedCalvingDate: calendarDate("expectedCalvingDate").optional(),
      remarks: text.optional(),
    })
    .strict(),
});

/**
 * PATCH /farms/:farmId/pregnancies/:id/deliver — record the calving.
 *  - actualCalvingDate: required (calendar day, must be after conception)
 *  - calfCount: required, 1–10
 *  - calfGender: required, Male | Female | Twin (Twin only when calfCount = 2)
 *  - remarks: optional
 */
const deliverValidation = z.object({
  body: z
    .object({
      //defaults to today when omitted
      actualCalvingDate: calendarDate("actualCalvingDate").optional(),
      calfCount: z
        .number()
        .int()
        .min(1, { message: "calfCount must be at least 1!" })
        .max(10, { message: "calfCount cannot exceed 10!" }),
      calfGender: calfGender,
      remarks: text.optional(),
    })
    .strict(),
});

/**
 * PATCH /farms/:farmId/pregnancies/:id/outcome — record an abortion or failure.
 *  - outcome: "Aborted" | "Failed" (required)
 *  - reason: required clinical reason (at least 3 chars)
 *  - remarks: optional extra notes
 */
const outcomeValidation = z.object({
  body: z
    .object({
      outcome: pregnancyStatus.refine(
        (val) => val === PregnancyStatuses.ABORTED || val === PregnancyStatuses.FAILED,
        { message: "outcome must be 'Aborted' or 'Failed'!" },
      ),
      reason: shortText.min(3, { message: "reason is required to record an outcome (at least 3 characters)!" }),
      remarks: text.optional(),
    })
    .strict(),
});

/**
 * PUT /farms/:farmId/pregnancies/:id — controlled correction of administrative fields.
 *  - conceptionDate, expectedCalvingDate, remarks — at least one required
 */
const updateValidation = z.object({
  body: z
    .object({
      conceptionDate: calendarDate("conceptionDate").optional(),
      expectedCalvingDate: calendarDate("expectedCalvingDate").optional(),
      remarks: text.optional(),
      //why the record is being corrected (required when dates change)
      reason: shortText.optional(),
    })
    .strict(),
});

export const pregnancyValidations = {
  createValidation,
  deliverValidation,
  outcomeValidation,
  updateValidation,
};
