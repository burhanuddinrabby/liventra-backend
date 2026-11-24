import type { Types } from "mongoose";
import type {
  InventoryItemTypes,
  InventoryReferenceTypes,
  InventoryStatuses,
  InventoryTransactionTypes,
  InventoryUnits,
  StockDirections,
} from "./inventory.constants.js";

export type TInventoryItemType = (typeof InventoryItemTypes)[keyof typeof InventoryItemTypes];
export type TInventoryUnit = (typeof InventoryUnits)[keyof typeof InventoryUnits];
export type TInventoryStatus = (typeof InventoryStatuses)[keyof typeof InventoryStatuses];
export type TInventoryTransactionType =
  (typeof InventoryTransactionTypes)[keyof typeof InventoryTransactionTypes];
export type TInventoryReferenceType =
  (typeof InventoryReferenceTypes)[keyof typeof InventoryReferenceTypes];
export type TStockDirection = (typeof StockDirections)[keyof typeof StockDirections];

// Inventory (Model 19) — current stock of one farm item
export type TInventory = {
  inventoryCode: string;
  farmId: Types.ObjectId;
  itemName: string;
  itemType: TInventoryItemType;
  //FeedIngredient / Medicine / Vaccine _id, by itemType; null for items with no master
  referenceId?: Types.ObjectId | null;
  category?: string;
  //changed only through InventoryTransaction rows, never edited directly
  currentStock: number;
  unit: TInventoryUnit;
  minimumStock: number;
  maximumStock: number;
  reorderLevel: number;
  averagePurchasePrice?: number;
  supplierName?: string;
  storageLocation?: string;
  expiryDate?: Date | null;
  status: TInventoryStatus;
  remarks?: string;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
};

// Inventory_Transaction (Model 20) — append-only stock ledger
export type TInventoryTransaction = {
  transactionNo: string;
  farmId: Types.ObjectId;
  inventoryId: Types.ObjectId;
  transactionType: TInventoryTransactionType;
  transactionDate: Date;
  //always positive; transactionType (+ direction for Adjustment / Return) gives the sign
  quantity: number;
  /**
   * Resolved stock direction. The final schema has no direction field, so it stays
   * optional: rows written before this module (and by FeedRecord / Treatment /
   * Vaccination) carry none and are read through `resolveDirection()`, which falls
   * back to the transactionType map.
   */
  direction?: TStockDirection;
  unit?: TInventoryUnit;
  unitPrice?: number;
  totalAmount?: number;
  referenceType?: TInventoryReferenceType;
  referenceId?: Types.ObjectId | null;
  supplierName?: string;
  remarks?: string;
  //FarmMember _id of the person who caused the stock change
  performedBy: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
};

//an Inventory row with its identity, as returned by lean() reads
export type TInventoryDoc = TInventory & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export type TInventoryTransactionDoc = TInventoryTransaction & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};
