import z from "zod";
import { UnitConversions } from "../feedFormula/feedFormula.constants.js";
import {
  FeedingSessions,
  MAX_ITEM_QUANTITY,
  MAX_ITEMS_PER_RECORD,
  MAX_TEXT_LENGTH,
  MAX_UNIT_PRICE,
} from "./feedRecord.constants.js";

// validateRequest discards the parsed result, so these schemas only reject bad
// requests early; feedRecord.services.ts re-parses every field it uses.
// Bodies are .strict(): client totals (items[].totalCost, totalFeedQuantity,
// totalCost) and ingredientName snapshots are never accepted — the server
// calculates/snapshots them.

const objectIdString = (field: string) =>
  z.string().regex(/^[a-f\d]{24}$/i, { message: `${field} must be a valid ObjectId` });

//Mongo _id or a display code (AN-000001 / REC-2026-000001)
const reference = z.string().trim().min(1).max(40);
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/, { message: "feedingDate must be YYYY-MM-DD" });
const text = z.string().trim().max(MAX_TEXT_LENGTH);

const item = z
  .object({
    ingredientId: objectIdString("ingredientId"),
    quantity: z
      .number({ message: "quantity must be a number" })
      .positive({ message: "quantity must be greater than 0" })
      .max(MAX_ITEM_QUANTITY),
    unit: z.enum(Object.keys(UnitConversions) as [string, ...string[]]).optional(),
    //actual price per unit; differs from the catalog price only for Owner / Manager
    unitPrice: z.number({ message: "unitPrice must be a number" }).min(0, { message: "unitPrice cannot be negative" }).max(MAX_UNIT_PRICE).optional(),
  })
  .strict();

const items = z.array(item).min(1, { message: "Add at least one ingredient" }).max(MAX_ITEMS_PER_RECORD);

const flags = {
  //Owner / Manager: draw stock down to 0 when it is short
  allowInsufficientStock: z.boolean().optional(),
  //log a second feeding for the same animal, day and session
  allowDuplicateSession: z.boolean().optional(),
};

const createBody = z
  .object({
    animalId: reference,
    recommendationId: reference.nullable().optional(),
    feedingSession: z.enum(Object.values(FeedingSessions)),
    feedingDate: calendarDate,
    items,
    remarks: text.optional(),
    //FarmMember _id; omitted => the caller
    fedBy: objectIdString("fedBy").optional(),
    ...flags,
  })
  .strict();

const createValidation = z.object({ body: createBody });
const previewValidation = z.object({ body: createBody });

const updateValidation = z.object({
  body: z
    .object({
      //accepted only when unchanged (immutable); the service explains why
      animalId: reference.optional(),
      recommendationId: reference.nullable().optional(),
      feedingSession: z.enum(Object.values(FeedingSessions)).optional(),
      feedingDate: calendarDate.optional(),
      items: items.optional(),
      remarks: text.nullable().optional(),
      fedBy: objectIdString("fedBy").optional(),
      //why the record is corrected (stored in the audit log)
      reason: text.optional(),
      ...flags,
    })
    .strict()
    .refine(
      (b) =>
        ["recommendationId", "feedingSession", "feedingDate", "items", "remarks", "fedBy"].some((k) => k in b),
      { message: "Send at least one field to correct" },
    ),
});

const voidValidation = z.object({
  body: z.object({ reason: text.optional() }).strict().optional(),
});

export const feedRecordValidations = {
  createValidation,
  previewValidation,
  updateValidation,
  voidValidation,
};
