import { InventoryItemTypes } from "../inventory/inventory.constants.js";

// Expense (Model 21) enums, from the final DB schema.
export const ExpenseCategories = {
  FEED_PURCHASE: "Feed Purchase",
  MEDICINE_PURCHASE: "Medicine Purchase",
  VACCINE_PURCHASE: "Vaccine Purchase",
  SALARY: "Salary",
  VETERINARY_SERVICE: "Veterinary Service",
  ELECTRICITY: "Electricity",
  WATER: "Water",
  TRANSPORTATION: "Transportation",
  EQUIPMENT: "Equipment",
  REPAIR: "Repair",
  MAINTENANCE: "Maintenance",
  MISCELLANEOUS: "Miscellaneous",
} as const;

export const ExpenseReferenceTypes = {
  INVENTORY_TRANSACTION: "InventoryTransaction",
  TREATMENT: "Treatment",
  MANUAL: "Manual",
  SALARY: "Salary",
  OTHER: "Other",
} as const;

export const ExpenseStatuses = { PENDING: "Pending", PAID: "Paid", CANCELLED: "Cancelled" } as const;

//EXP-2026-000001 (atomic per-year counter)
export const EXPENSE_NO_PREFIX = "EXP";
export const EXPENSE_NO_PATTERN = /^EXP-\d{4}-\d{6}$/i;

//what a purchase of each stock type is booked as (first = default)
export const ITEM_TYPE_CATEGORIES: Record<string, readonly string[]> = {
  [InventoryItemTypes.FEED]: [ExpenseCategories.FEED_PURCHASE],
  [InventoryItemTypes.MEDICINE]: [ExpenseCategories.MEDICINE_PURCHASE],
  [InventoryItemTypes.VACCINE]: [ExpenseCategories.VACCINE_PURCHASE],
  [InventoryItemTypes.EQUIPMENT]: [ExpenseCategories.EQUIPMENT],
  [InventoryItemTypes.CLEANING_SUPPLY]: [ExpenseCategories.MAINTENANCE, ExpenseCategories.MISCELLANEOUS],
  [InventoryItemTypes.OTHER]: [ExpenseCategories.MISCELLANEOUS, ExpenseCategories.EQUIPMENT, ExpenseCategories.MAINTENANCE],
};

//stock purchases belong to the purchase workflow, so they are linked to a ledger row
export const STOCK_PURCHASE_CATEGORIES: readonly string[] = [
  ExpenseCategories.FEED_PURCHASE,
  ExpenseCategories.MEDICINE_PURCHASE,
  ExpenseCategories.VACCINE_PURCHASE,
];

//categories a treatment bill may be booked under
export const TREATMENT_CATEGORIES: readonly string[] = [
  ExpenseCategories.VETERINARY_SERVICE,
  ExpenseCategories.MEDICINE_PURCHASE,
  ExpenseCategories.TRANSPORTATION,
  ExpenseCategories.MISCELLANEOUS,
];
