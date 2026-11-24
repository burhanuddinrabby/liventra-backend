import z from "zod";
import {
  InventoryItemTypes,
  InventoryTransactionTypes,
  InventoryUnits,
  MANUAL_REFERENCE_TYPES,
  MAX_CATEGORY,
  MAX_ITEM_NAME,
  MAX_REMARKS,
  MAX_SHORT_TEXT,
  MAX_STOCK_QUANTITY,
  MAX_STORAGE_LOCATION,
  MAX_SUPPLIER_NAME,
  MAX_TOTAL_AMOUNT,
  MAX_UNIT_PRICE,
  StockDirections,
} from "./inventory.constants.js";

// validateRequest discards the parsed result, so these schemas only reject bad
// requests early; inventory.services.ts re-parses and whitelists every field it uses.
// Bodies are .strict(): inventoryCode, transactionNo, farmId, status, createdBy,
// performedBy, timestamps and _id are never accepted from the client.

//Mongo _id or a display code (INV-YYYY-NNNNNN / TRX-YYYY-NNNNNN)
const reference = z.string().trim().min(1).max(40);
const calendarDate = (field: string) =>
  z.string().regex(/^\d{4}-\d{2}-\d{2}/, { message: `${field} must be YYYY-MM-DD` });
const quantity = z.number().min(0).max(MAX_STOCK_QUANTITY);
const money = z.number().min(0).max(MAX_UNIT_PRICE);
const text = z.string().trim().max(MAX_REMARKS);
const shortText = z.string().trim().max(MAX_SHORT_TEXT);
const itemType = z.enum(Object.values(InventoryItemTypes) as [string, ...string[]]);
const unit = z.enum(Object.values(InventoryUnits) as [string, ...string[]]);
const transactionType = z.enum(Object.values(InventoryTransactionTypes) as [string, ...string[]]);
const manualReferenceType = z.enum(MANUAL_REFERENCE_TYPES as unknown as [string, ...string[]]);
const direction = z.enum(Object.values(StockDirections) as [string, ...string[]]);

/**
 * POST /farms/:farmId/inventory — register a stock item.
 *  - itemType + unit are required; referenceId is required for Feed / Medicine /
 *    Vaccine (the polymorphic master) and refused for the other item types
 *  - itemName defaults to the linked master record's name
 *  - currentStock > 0 also writes the opening Inventory_Transaction, so the opening
 *    fields describe where that stock came from
 *  - confirmDuplicate: keep a second row for the same item on purpose (another batch)
 */
const createInventoryValidation = z.object({
  body: z
    .object({
      itemName: z.string().trim().min(1).max(MAX_ITEM_NAME).optional(),
      itemType: itemType,
      //FeedIngredient / Medicine / Vaccine _id, by itemType
      referenceId: reference.optional(),
      category: z.string().trim().max(MAX_CATEGORY).optional(),
      currentStock: quantity.optional(),
      unit: unit,
      minimumStock: quantity.optional(),
      maximumStock: quantity.optional(),
      reorderLevel: quantity.optional(),
      supplierName: z.string().trim().max(MAX_SUPPLIER_NAME).optional(),
      storageLocation: z.string().trim().max(MAX_STORAGE_LOCATION).optional(),
      expiryDate: calendarDate("expiryDate").optional(),
      remarks: text.optional(),
      //opening stock history (only valid together with currentStock > 0)
      openingTransactionType: z
        .enum([InventoryTransactionTypes.PURCHASE, InventoryTransactionTypes.ADJUSTMENT])
        .optional(),
      openingUnitPrice: money.optional(),
      openingTransactionDate: calendarDate("openingTransactionDate").optional(),
      openingRemarks: text.optional(),
      confirmDuplicate: z.boolean().optional(),
    })
    .strict(),
});

/**
 * PUT /farms/:farmId/inventory/:id — administrative metadata only.
 * currentStock / unit / itemType / referenceId are intentionally absent: stock moves
 * only through Inventory_Transaction, and the rest is the item's identity.
 * averagePurchasePrice is an Owner-only correction and then `reason` is required.
 */
const updateInventoryValidation = z.object({
  body: z
    .object({
      itemName: z.string().trim().min(1).max(MAX_ITEM_NAME).optional(),
      category: z.string().trim().max(MAX_CATEGORY).nullable().optional(),
      minimumStock: quantity.optional(),
      maximumStock: quantity.optional(),
      reorderLevel: quantity.optional(),
      supplierName: z.string().trim().max(MAX_SUPPLIER_NAME).nullable().optional(),
      storageLocation: z.string().trim().max(MAX_STORAGE_LOCATION).nullable().optional(),
      expiryDate: calendarDate("expiryDate").nullable().optional(),
      remarks: text.nullable().optional(),
      averagePurchasePrice: money.optional(),
      //why the item was corrected (required with averagePurchasePrice)
      reason: shortText.optional(),
    })
    .strict(),
});

/**
 * PATCH /farms/:farmId/inventory/:id/toggle-active
 *  - active: true | false to set it explicitly; omitted flips the current state
 *  - reason: required when deactivating (the item stops accepting movements)
 */
const toggleActiveValidation = z.object({
  body: z
    .object({
      active: z.boolean().optional(),
      reason: shortText.optional(),
    })
    .strict(),
});

/**
 * POST /farms/:farmId/inventory-transactions — record a stock movement.
 *  - transactionType: Purchase | Consumption | Damage | Expired | Adjustment | Return
 *    (Vaccination Usage / Treatment Usage are written by their own workflows)
 *  - quantity is always positive; direction is required for Adjustment (or send
 *    physicalCount and the server derives the difference) and optional for Return
 *  - unitPrice is required for Purchase; totalAmount is verified when sent
 *  - expiryDate may ride along with an inflow that restocks the item
 */
const createTransactionValidation = z.object({
  body: z
    .object({
      inventoryId: reference,
      transactionType: transactionType,
      transactionDate: calendarDate("transactionDate").optional(),
      quantity: quantity.optional(),
      //stock reconciliation shortcut for Adjustment: the counted physical stock
      physicalCount: quantity.optional(),
      direction: direction.optional(),
      unit: unit.optional(),
      unitPrice: money.optional(),
      totalAmount: z.number().min(0).max(MAX_TOTAL_AMOUNT).optional(),
      referenceType: manualReferenceType.optional(),
      //only with referenceType "Expense"
      referenceId: reference.optional(),
      supplierName: z.string().trim().max(MAX_SUPPLIER_NAME).optional(),
      remarks: text.optional(),
      //a restocking inflow may also refresh the item's expiry date
      expiryDate: calendarDate("expiryDate").optional(),
    })
    .strict(),
});

/**
 * POST /farms/:farmId/inventory-transactions/:id/reverse — compensating correction.
 *  - reason: required (it goes into the reversal's remarks and the AuditLog)
 *  - reversalType: Adjustment (default) or Return (goods went back to the supplier)
 */
const reverseTransactionValidation = z.object({
  body: z
    .object({
      reason: shortText.min(3, { message: "reason is required to reverse a transaction (at least 3 characters)!" }),
      reversalType: z
        .enum([InventoryTransactionTypes.ADJUSTMENT, InventoryTransactionTypes.RETURN])
        .optional(),
      transactionDate: calendarDate("transactionDate").optional(),
    })
    .strict(),
});

export const inventoryValidations = {
  createInventoryValidation,
  updateInventoryValidation,
  toggleActiveValidation,
  createTransactionValidation,
  reverseTransactionValidation,
};
