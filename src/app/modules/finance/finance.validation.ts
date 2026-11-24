import z from "zod";
import {
  MAX_AMOUNT,
  MAX_DESCRIPTION,
  MAX_INVOICE,
  MAX_PARTY,
  MAX_QUANTITY,
  MAX_REASON,
  PaymentMethods,
} from "./finance.constants.js";

// validateRequest discards the parsed result, so these schemas only reject bad requests
// early; the services re-parse every field. Bodies are .strict(): numbers, farmId, status
// changes, createdBy, updatedBy and attachment paths are never accepted from the client.

export const enumOf = (values: Record<string, string> | readonly string[]) =>
  z.enum((Array.isArray(values) ? [...values] : Object.values(values)) as [string, ...string[]]);

export const fields = {
  amount: z.number().positive().max(MAX_AMOUNT),
  quantity: z.number().positive().max(MAX_QUANTITY),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}/, { message: "must be YYYY-MM-DD" }),
  paymentMethod: enumOf(PaymentMethods),
  party: z.string().trim().max(MAX_PARTY),
  phone: z.string().trim().regex(/^(\+?[0-9][0-9 -]{5,19})?$/, { message: "Enter a valid phone number" }),
  invoice: z.string().trim().max(MAX_INVOICE),
  description: z.string().trim().max(MAX_DESCRIPTION),
  reason: z.string().trim().max(MAX_REASON),
  //Mongo _id or a display number
  reference: z.string().trim().min(1).max(40),
};

const settleBody = {
  paymentMethod: fields.paymentMethod,
  paymentDate: fields.day.optional(),
  remarks: fields.reason.optional(),
};

export const payValidation = z.object({ body: z.object({ ...settleBody, paidTo: fields.party.optional() }).strict() });
export const receiveValidation = z.object({
  body: z.object({ ...settleBody, customerName: fields.party.optional() }).strict(),
});
export const cancelValidation = z.object({
  body: z.object({ reason: fields.reason.min(3, { message: "reason is required (at least 3 characters)!" }) }).strict(),
});
