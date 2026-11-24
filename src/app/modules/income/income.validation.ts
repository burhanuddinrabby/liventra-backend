import z from "zod";
import { cancelValidation, enumOf, fields, receiveValidation } from "../finance/finance.validation.js";
import { ANIMAL_CATEGORIES, IncomeCategories, IncomeUnits, MANUAL_CATEGORIES } from "./income.constants.js";

//Pending or Received at creation; Cancelled only through PATCH /:id/cancel
const openStatus = z.enum(["Pending", "Received"]);

const common = {
  incomeDate: fields.day.optional(),
  paymentMethod: fields.paymentMethod.optional(),
  customerName: fields.party.optional(),
  customerPhone: fields.phone.optional(),
  invoiceNumber: fields.invoice.optional(),
  description: fields.description.optional(),
  status: openStatus.optional(),
  confirmDuplicate: z.boolean().optional(),
};

//quantity × unitPrice; a different `amount` is an Owner-only override with a reason
const priced = {
  quantity: fields.quantity,
  unitPrice: fields.amount,
  amount: fields.amount.optional(),
  overrideReason: fields.reason.optional(),
};

const createIncomeValidation = z.object({
  body: z
    .object({
      incomeCategory: enumOf(MANUAL_CATEGORIES),
      amount: fields.amount.optional(),
      quantity: fields.quantity.optional(),
      unit: enumOf(IncomeUnits).optional(),
      unitPrice: fields.amount.optional(),
      overrideReason: fields.reason.optional(),
      ...common,
    })
    .strict(),
});

const milkSaleValidation = z.object({
  body: z
    .object({ milkRecordId: fields.reference.optional(), unit: enumOf([IncomeUnits.LITER, IncomeUnits.KG]), ...priced, ...common })
    .strict(),
});

const animalSaleValidation = z.object({
  body: z
    .object({
      animalId: fields.reference,
      incomeCategory: enumOf(ANIMAL_CATEGORIES).optional(),
      amount: fields.amount,
      //false = deal agreed, the animal stays Active for now
      markAsSold: z.boolean().optional(),
      //book the missing income of an animal that is already Sold (Owner / Manager)
      backfill: z.boolean().optional(),
      ...common,
    })
    .strict(),
});

const breedingServiceValidation = z.object({
  body: z.object({ breedingId: fields.reference, amount: fields.amount, ...common }).strict(),
});

const updateIncomeValidation = z.object({
  body: z
    .object({
      customerName: fields.party.nullable().optional(),
      customerPhone: fields.phone.nullable().optional(),
      invoiceNumber: fields.invoice.nullable().optional(),
      description: fields.description.nullable().optional(),
      //financial corrections: reason required
      amount: fields.amount.optional(),
      quantity: fields.quantity.optional(),
      unitPrice: fields.amount.optional(),
      incomeCategory: enumOf(IncomeCategories).optional(),
      incomeDate: fields.day.optional(),
      paymentMethod: fields.paymentMethod.optional(),
      reason: fields.reason.optional(),
    })
    .strict(),
});

export const incomeValidations = {
  createIncomeValidation,
  milkSaleValidation,
  animalSaleValidation,
  breedingServiceValidation,
  updateIncomeValidation,
  receiveValidation,
  cancelValidation,
};
