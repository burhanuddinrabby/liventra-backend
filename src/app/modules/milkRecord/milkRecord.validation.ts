import z from "zod";
import {
  COMPOSITION_LIMITS,
  MAX_BULK_ENTRIES,
  MAX_TEXT_LENGTH,
  MilkDeleteModes,
  MilkingMethods,
  MilkingSessions,
  MilkQualities,
  MilkUnits,
} from "./milkRecord.constants.js";

// validateRequest discards the parsed result, so these schemas only reject bad
// requests early; milkRecord.services.ts re-parses every field it uses.
// Bodies are .strict(): server-derived fields (quantityInLiters, withdrawalFlag,
// isVoided, farmId…) are never accepted.

const objectIdString = (field: string) =>
  z.string().regex(/^[a-f\d]{24}$/i, { message: `${field} must be a valid ObjectId` });

//Mongo _id or the farm animal code (AN-000001)
const animalRef = z.string().trim().min(1).max(40);
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/, { message: "recordDate must be YYYY-MM-DD" });
const text = z.string().trim().max(MAX_TEXT_LENGTH);
const percent = (field: keyof typeof COMPOSITION_LIMITS) =>
  z
    .number({ message: `${field} must be a number` })
    .min(COMPOSITION_LIMITS[field].min)
    .max(COMPOSITION_LIMITS[field].max)
    //null / omitted = not measured (never 0)
    .nullable()
    .optional();

const session = z.enum(Object.values(MilkingSessions));
const unit = z.enum(Object.values(MilkUnits));
const quality = z.enum(Object.values(MilkQualities)).nullable().optional();
const method = z.enum(Object.values(MilkingMethods)).nullable().optional();
const quantity = z.number({ message: "quantity must be a number" }).min(0, { message: "quantity cannot be negative" });

const measurement = {
  fatPercentage: percent("fatPercentage"),
  proteinPercentage: percent("proteinPercentage"),
  snfPercentage: percent("snfPercentage"),
  quality,
  //DO.md name; alias of `quality`
  qualityStatus: quality,
  milkingMethod: method,
  remarks: text.nullable().optional(),
};

const createBody = z
  .object({
    animalId: animalRef,
    recordDate: calendarDate,
    milkingSession: session,
    quantity,
    unit: unit.optional(),
    //FarmMember _id; omitted => the caller
    recordedBy: objectIdString("recordedBy").optional(),
    ...measurement,
  })
  .strict();

const createValidation = z.object({ body: createBody });

const bulkValidation = z.object({
  body: z
    .object({
      recordDate: calendarDate,
      milkingSession: session,
      milkingMethod: method,
      unit: unit.optional(),
      recordedBy: objectIdString("recordedBy").optional(),
      dryRun: z.boolean().optional(),
      entries: z
        .array(
          z
            .object({
              animalId: animalRef,
              quantity,
              unit: unit.optional(),
              recordedBy: objectIdString("recordedBy").optional(),
              ...measurement,
            })
            .strict(),
        )
        .min(1, { message: "Add at least one animal" })
        .max(MAX_BULK_ENTRIES),
    })
    .strict(),
});

const updateValidation = z.object({
  body: z
    .object({
      //accepted only when unchanged (immutable); the service explains why
      animalId: animalRef.optional(),
      recordDate: calendarDate.optional(),
      milkingSession: session.optional(),
      quantity: quantity.optional(),
      unit: unit.optional(),
      recordedBy: objectIdString("recordedBy").optional(),
      ...measurement,
      //why the record is corrected (stored in the audit log)
      reason: text.optional(),
    })
    .strict()
    .refine(
      (b) =>
        [
          "recordDate",
          "milkingSession",
          "quantity",
          "unit",
          "recordedBy",
          "fatPercentage",
          "proteinPercentage",
          "snfPercentage",
          "quality",
          "qualityStatus",
          "milkingMethod",
          "remarks",
        ].some((k) => k in b),
      { message: "Send at least one field to correct" },
    ),
});

const qualityValidation = z.object({
  body: z
    .object({ quality, qualityStatus: quality, reason: text.optional() })
    .strict()
    .refine((b) => "quality" in b || "qualityStatus" in b, { message: "quality is required" }),
});

const deleteValidation = z.object({
  body: z
    .object({ mode: z.enum(Object.values(MilkDeleteModes)).optional(), reason: text.optional() })
    .strict()
    .optional(),
});

export const milkRecordValidations = {
  createValidation,
  bulkValidation,
  updateValidation,
  qualityValidation,
  deleteValidation,
};
