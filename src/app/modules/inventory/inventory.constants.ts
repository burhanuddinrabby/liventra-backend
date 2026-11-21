// Inventory (Model 19) + Inventory_Transaction (Model 20) enums, from the final DB
// schema in `.opencode/Business Logics.md`. Values are display strings stored as-is.
//
// Only the persistence layer exists so far: the FeedRecord module needs it to deduct
// and restore stock atomically. The Inventory CRUD/purchase API is not built yet.

export const InventoryItemTypes = {
  FEED: "Feed",
  MEDICINE: "Medicine",
  VACCINE: "Vaccine",
  EQUIPMENT: "Equipment",
  CLEANING_SUPPLY: "Cleaning Supply",
  OTHER: "Other",
} as const;

export const InventoryUnits = {
  KG: "kg",
  G: "g",
  LITER: "liter",
  ML: "ml",
  PIECE: "piece",
  PACKET: "packet",
  BOX: "box",
  BOTTLE: "bottle",
} as const;

export const InventoryStatuses = {
  AVAILABLE: "Available",
  LOW_STOCK: "Low Stock",
  OUT_OF_STOCK: "Out of Stock",
  EXPIRED: "Expired",
  INACTIVE: "Inactive",
} as const;

export const InventoryTransactionTypes = {
  PURCHASE: "Purchase",
  CONSUMPTION: "Consumption",
  VACCINATION_USAGE: "Vaccination Usage",
  TREATMENT_USAGE: "Treatment Usage",
  DAMAGE: "Damage",
  EXPIRED: "Expired",
  ADJUSTMENT: "Adjustment",
  RETURN: "Return",
} as const;

export const InventoryReferenceTypes = {
  FEED_RECORD: "FeedRecord",
  TREATMENT: "Treatment",
  VACCINATION: "Vaccination",
  EXPENSE: "Expense",
  MANUAL: "Manual",
  PURCHASE: "Purchase",
} as const;

//TRX-2026-000001 (atomic per-year counter)
export const INVENTORY_TRANSACTION_NO_PREFIX = "TRX";
