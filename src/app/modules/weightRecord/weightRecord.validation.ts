import z from "zod";
import {
  MAX_TEXT_LENGTH,
  MAX_WEIGHT_KG,
  MAX_WEIGHT_LB,
  MeasurementMethods,
  WeightDeleteModes,
  WeightUnits,
} from "./weightRecord.constants.js";

// validateRequest discards the parsed result, so these schemas only reject bad
// requests early; weightRecord.services.ts re-parses every field it uses.
// Bodies are .strict(): server-derived fields (weightInKg, averageDailyGain,
// isVoided, farmId…) are never accepted.

const objectIdString = (field: string) =>
  z.string().regex(/^[a-f\d]{24}$/i, { message: `${field} must be a valid ObjectId` });

//Mongo _id or the farm animal code (AN-000001)
const animalRef = z.string().trim().min(1).max(40);
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/, { message: "recordedDate must be YYYY-MM-DD" });
const text = z.string().trim().max(MAX_TEXT_LENGTH);
const unit = z.enum(Object.values(WeightUnits));
const method = z.enum(Object.values(MeasurementMethods));
//the cap depends on the unit; the service applies the exact per-unit maximum
const weight = z
  .number({ message: "weight must be a number" })
  .gt(0, { message: "weight must be greater than 0" })
  .max(MAX_WEIGHT_LB, { message: `weight cannot exceed ${MAX_WEIGHT_KG} kg (${MAX_WEIGHT_LB} lb)` });

const createBody = z
  .object({
    animalId: animalRef,
    recordedDate: calendarDate,
    weight,
    weightUnit: unit.optional(),
    measurementMethod: method,
    //FarmMember _id; omitted => the caller
    measuredBy: objectIdString("measuredBy").optional(),
    remarks: text.nullable().optional(),
  })
  .strict();

const createValidation = z.object({ body: createBody });

const updateValidation = z.object({
  body: z
    .object({
      //accepted only when unchanged (immutable); the service explains why
      animalId: animalRef.optional(),
      recordedDate: calendarDate.optional(),
      weight: weight.optional(),
      weightUnit: unit.optional(),
      measurementMethod: method.optional(),
      measuredBy: objectIdString("measuredBy").optional(),
      remarks: text.nullable().optional(),
      //why the record is corrected (stored in the audit log)
      reason: text.optional(),
    })
    .strict()
    .refine(
      (b) =>
        [
          "recordedDate",
          "weight",
          "weightUnit",
          "measurementMethod",
          "measuredBy",
          "remarks",
        ].some((k) => k in b),
      { message: "Send at least one field to correct" },
    ),
});

const deleteValidation = z.object({
  body: z
    .object({ mode: z.enum(Object.values(WeightDeleteModes)).optional(), reason: text.optional() })
    .strict()
    .optional(),
});

export const weightRecordValidations = {
  createValidation,
  updateValidation,
  deleteValidation,
};
