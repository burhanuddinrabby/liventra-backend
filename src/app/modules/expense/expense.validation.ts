import z from "zod";
import { cancelValidation, enumOf, fields, payValidation } from "../finance/finance.validation.js";
import { InventoryItemTypes, InventoryUnits } from "../inventory/inventory.constants.js";
import { ExpenseCategories, ExpenseReferenceTypes } from "./expense.constants.js";

//Pending or Paid at creation; Cancelled only through PATCH /:id/cancel
const openStatus = z.enum(["Pending", "Paid"]);

const common = {
  expenseDate: fields.day.optional(),
  paymentMethod: fields.paymentMethod.optional(),
  paidTo: fields.party.optional(),
  invoiceNumber: fields.invoice.optional(),
  description: fields.description.optional(),
  status: openStatus.optional(),
  //save although a similar entry exists (the server answers 409 first)
  confirmDuplicate: z.boolean().optional(),
};

/** amount may be omitted only for an InventoryTransaction (taken from the purchase). */
const createExpenseValidation = z.object({
  body: z
    .object({
      expenseCategory: enumOf(ExpenseCategories).optional(),
      amount: fields.amount.optional(),
      referenceType: enumOf(ExpenseReferenceTypes).optional(),
      referenceId: fields.reference.optional(),
      ...common,
    })
    .strict(),
});

/** Either inventoryId (restock) or newItem (first purchase of something) is required. */
const purchaseValidation = z.object({
  body: z
    .object({
      inventoryId: fields.reference.optional(),
      newItem: z
        .object({
          itemName: z.string().trim().min(1).max(120).optional(),
          itemType: enumOf(InventoryItemTypes),
          unit: enumOf(InventoryUnits),
          referenceId: fields.reference.optional(),
          category: z.string().trim().max(60).optional(),
          storageLocation: z.string().trim().max(120).optional(),
          minimumStock: z.number().min(0).optional(),
          reorderLevel: z.number().min(0).optional(),
          maximumStock: z.number().min(0).optional(),
          confirmDuplicate: z.boolean().optional(),
        })
        .strict()
        .optional(),
      quantity: fields.quantity,
      unitPrice: fields.amount,
      expiryDate: fields.day.optional(),
      expenseCategory: enumOf(ExpenseCategories).optional(),
      ...common,
    })
    .strict(),
});

const updateExpenseValidation = z.object({
  body: z
    .object({
      paidTo: fields.party.nullable().optional(),
      invoiceNumber: fields.invoice.nullable().optional(),
      description: fields.description.nullable().optional(),
      //financial corrections: reason required
      amount: fields.amount.optional(),
      expenseCategory: enumOf(ExpenseCategories).optional(),
      expenseDate: fields.day.optional(),
      paymentMethod: fields.paymentMethod.optional(),
      reason: fields.reason.optional(),
    })
    .strict(),
});

export const expenseValidations = {
  createExpenseValidation,
  purchaseValidation,
  updateExpenseValidation,
  payValidation,
  cancelValidation,
};
