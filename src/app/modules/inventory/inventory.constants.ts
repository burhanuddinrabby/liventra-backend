// Inventory (Model 19) + Inventory_Transaction (Model 20) enums, from the final DB
// schema in `.opencode/Business Logics.md`. Values are display strings stored as-is.
//
// The persistence layer (model + utils) is also consumed by FeedRecord, Treatment and
// Vaccination, which move stock through `applyStockChange()` and write ledger rows.
// This module adds the farm-facing Inventory / Inventory_Transaction API on top.
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";

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

/**
 * Stock movement direction. The final schema has no `transactionDirection` field
 * (spec 20 §115–118), so direction is derived from `transactionType` through
 * `TRANSACTION_DIRECTIONS` below. `Adjustment` and `Return` are the two types that
 * can go either way, so this module stores the resolved direction on those rows as
 * explicit metadata (`quantity` itself always stays positive, per §118).
 */
export const StockDirections = {
  IN: "In",
  OUT: "Out",
} as const;

/**
 * Direction map (spec 20 §116). `null` = ambiguous, the caller must say which way.
 * `Return` defaults to **In** because FeedRecord / Treatment / Vaccination already
 * write `Return` rows when they give consumed stock back; a supplier return is an
 * explicit `direction: "Out"`.
 */
export const TRANSACTION_DIRECTIONS: Record<string, "In" | "Out" | null> = {
  [InventoryTransactionTypes.PURCHASE]: StockDirections.IN,
  [InventoryTransactionTypes.CONSUMPTION]: StockDirections.OUT,
  [InventoryTransactionTypes.VACCINATION_USAGE]: StockDirections.OUT,
  [InventoryTransactionTypes.TREATMENT_USAGE]: StockDirections.OUT,
  [InventoryTransactionTypes.DAMAGE]: StockDirections.OUT,
  [InventoryTransactionTypes.EXPIRED]: StockDirections.OUT,
  [InventoryTransactionTypes.ADJUSTMENT]: null,
  [InventoryTransactionTypes.RETURN]: StockDirections.IN,
};

//types whose direction the client must state explicitly
export const DIRECTIONAL_TRANSACTION_TYPES = [
  InventoryTransactionTypes.ADJUSTMENT,
  InventoryTransactionTypes.RETURN,
] as const;

/**
 * Usage rows are written by the clinical / feeding workflows, never by hand:
 * posting them manually would leave a stock movement with no source document.
 */
export const WORKFLOW_ONLY_TRANSACTION_TYPES = [
  InventoryTransactionTypes.VACCINATION_USAGE,
  InventoryTransactionTypes.TREATMENT_USAGE,
] as const;

//manual transaction types the inventory-transaction endpoint accepts
export const MANUAL_TRANSACTION_TYPES = [
  InventoryTransactionTypes.PURCHASE,
  InventoryTransactionTypes.CONSUMPTION,
  InventoryTransactionTypes.DAMAGE,
  InventoryTransactionTypes.EXPIRED,
  InventoryTransactionTypes.ADJUSTMENT,
  InventoryTransactionTypes.RETURN,
] as const;

//reference types a manual transaction may carry (the rest belong to workflows)
export const MANUAL_REFERENCE_TYPES = [
  InventoryReferenceTypes.MANUAL,
  InventoryReferenceTypes.PURCHASE,
  InventoryReferenceTypes.EXPENSE,
] as const;

//itemType → master catalog that referenceId must point at (others have no master)
export const ITEM_TYPE_MASTERS = {
  [InventoryItemTypes.FEED]: "FeedIngredient",
  [InventoryItemTypes.MEDICINE]: "Medicine",
  [InventoryItemTypes.VACCINE]: "Vaccine",
} as const;

//INV-2026-000001 (atomic per-year counter)
export const INVENTORY_CODE_PREFIX = "INV";
export const INVENTORY_CODE_PATTERN = /^INV-\d{4}-\d{6}$/i;

//TRX-2026-000001 (atomic per-year counter)
export const INVENTORY_TRANSACTION_NO_PREFIX = "TRX";
export const TRANSACTION_NO_PATTERN = /^TRX-\d{4}-\d{6}$/i;

/**
 * Category suggestions per itemType. The final schema keeps `category` a free string
 * (spec 19 §19: the listed values are examples, not an exhaustive enum), so these are
 * served by `GET /inventory/meta` for the UI dropdown and never enforced.
 */
export const INVENTORY_CATEGORY_SUGGESTIONS: Record<string, readonly string[]> = {
  [InventoryItemTypes.FEED]: ["Roughage", "Concentrate", "Green Fodder", "Dry Fodder", "Mineral", "Supplement", "Silage"],
  [InventoryItemTypes.MEDICINE]: ["Antibiotic", "Injection", "Dewormer", "Painkiller", "Vitamin", "Hormone", "Antiseptic"],
  [InventoryItemTypes.VACCINE]: ["Injection", "Live Vaccine", "Killed Vaccine"],
  [InventoryItemTypes.EQUIPMENT]: ["Milking", "Feeding", "Housing", "Tools", "Safety"],
  [InventoryItemTypes.CLEANING_SUPPLY]: ["Cleaning", "Disinfectant", "Detergent"],
  [InventoryItemTypes.OTHER]: ["General"],
};

const { OWNER, MANAGER, WORKER, VETERINARIAN, ACCOUNTANT } = FarmMemberRoles;

/**
 * Inventory + Inventory_Transaction route permissions (DO.md route table and
 * spec 20 §87–89 / §141).
 *  - every active member reads stock, ledger, dashboards and transactions
 *  - Owner / Manager register items, correct metadata, deactivate and reverse
 *  - Workers may record operational Consumption only (they feed and clean)
 *  - Accountants may record Purchase / Return (they handle supplier paperwork)
 *  - only Owner reaches DELETE (and both deletes are guarded, see the services)
 */
export const InventoryPermissions = {
  READ: [OWNER, MANAGER, WORKER, VETERINARIAN, ACCOUNTANT],
  CREATE: [OWNER, MANAGER],
  UPDATE: [OWNER, MANAGER],
  TOGGLE_ACTIVE: [OWNER, MANAGER],
  DELETE: [OWNER],
  //manual price correction is an owner decision (spec 19 §34)
  PRICE_CORRECTION: [OWNER],
  SYNC_STATUS: [OWNER, MANAGER],
  AUDIT: [OWNER, MANAGER, ACCOUNTANT],
  TRANSACTION_READ: [OWNER, MANAGER, WORKER, VETERINARIAN, ACCOUNTANT],
  TRANSACTION_REVERSE: [OWNER, MANAGER],
  TRANSACTION_DELETE: [OWNER],
} as const;

/** Which farm roles may post each manual transaction type (spec 20 §89). */
export const TRANSACTION_TYPE_PERMISSIONS: Record<string, readonly string[]> = {
  [InventoryTransactionTypes.PURCHASE]: [OWNER, MANAGER, ACCOUNTANT],
  [InventoryTransactionTypes.CONSUMPTION]: [OWNER, MANAGER, WORKER, VETERINARIAN],
  [InventoryTransactionTypes.DAMAGE]: [OWNER, MANAGER],
  [InventoryTransactionTypes.EXPIRED]: [OWNER, MANAGER],
  [InventoryTransactionTypes.ADJUSTMENT]: [OWNER, MANAGER],
  [InventoryTransactionTypes.RETURN]: [OWNER, MANAGER, ACCOUNTANT],
};

//field limits
export const MAX_ITEM_NAME = 120;
export const MAX_CATEGORY = 60;
export const MAX_SUPPLIER_NAME = 120;
export const MAX_STORAGE_LOCATION = 120;
export const MAX_REMARKS = 1000;
export const MAX_SHORT_TEXT = 200;

//numeric guardrails (quantities are stored with 4-decimal rounding)
export const MAX_STOCK_QUANTITY = 1_000_000;
export const MAX_UNIT_PRICE = 10_000_000;
export const MAX_TOTAL_AMOUNT = 1_000_000_000;

//paging
export const MAX_LIST_LIMIT = 100;
export const MAX_LEDGER_LIMIT = 200;

//how far a transactionDate may be backdated / post-dated (spec 20 §32, §80)
export const MAX_BACKDATE_DAYS = 365;
export const FUTURE_TOLERANCE_HOURS = 24;

//expiry-warning windows offered by the dashboard and the ?expiringDays filter
export const DEFAULT_EXPIRING_DAYS = 30;
export const MAX_EXPIRING_DAYS = 365;
export const EXPIRY_WARNING_WINDOWS = [7, 15, 30, 60, 90] as const;

//money rounding (spec 20 §44: never keep raw floating point money)
export const MONEY_DECIMALS = 2;
export const QUANTITY_DECIMALS = 4;

//how many ledger rows the item detail response previews
export const DETAIL_LEDGER_PREVIEW = 10;

//dashboard lists are capped so one farm with thousands of rows cannot stall the call
export const DASHBOARD_LIST_LIMIT = 20;

//total amount must match quantity * unitPrice within this tolerance (float safety)
export const TOTAL_AMOUNT_TOLERANCE = 0.05;

//status priority used when deriving the operational status (spec 19 §49, §87)
export const STATUS_PRIORITY = [
  InventoryStatuses.INACTIVE,
  InventoryStatuses.EXPIRED,
  InventoryStatuses.OUT_OF_STOCK,
  InventoryStatuses.LOW_STOCK,
  InventoryStatuses.AVAILABLE,
] as const;

//statuses an item may be consumed from
export const CONSUMABLE_STATUSES = [
  InventoryStatuses.AVAILABLE,
  InventoryStatuses.LOW_STOCK,
] as const;

//list sort fields the client may ask for (any other value is rejected)
export const INVENTORY_SORT_FIELDS = [
  "itemName",
  "currentStock",
  "expiryDate",
  "createdAt",
  "updatedAt",
  "status",
  "itemType",
] as const;

export const TRANSACTION_SORT_FIELDS = [
  "transactionDate",
  "createdAt",
  "quantity",
  "totalAmount",
  "transactionType",
] as const;

//Inventory fields a PUT may change (spec 19 §120 "Update"; currentStock excluded)
export const UPDATABLE_INVENTORY_FIELDS = [
  "itemName",
  "category",
  "minimumStock",
  "maximumStock",
  "reorderLevel",
  "supplierName",
  "storageLocation",
  "expiryDate",
  "remarks",
] as const;

//never accepted from the client on an Inventory body
export const SERVER_MANAGED_INVENTORY_FIELDS = [
  "inventoryCode",
  "farmId",
  "status",
  "createdBy",
  "updatedBy",
  "createdAt",
  "updatedAt",
  "_id",
] as const;

//never accepted from the client on an Inventory_Transaction body
export const SERVER_MANAGED_TRANSACTION_FIELDS = [
  "transactionNo",
  "farmId",
  "performedBy",
  "createdAt",
  "updatedAt",
  "_id",
] as const;

//PUT may not touch stock or identity; these produce a clear 400 instead of silence
export const LOCKED_INVENTORY_FIELDS = ["currentStock", "itemType", "referenceId", "unit"] as const;
