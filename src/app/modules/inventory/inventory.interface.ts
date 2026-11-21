import type { Types } from "mongoose";
import type {
  InventoryItemTypes,
  InventoryReferenceTypes,
  InventoryStatuses,
  InventoryTransactionTypes,
  InventoryUnits,
} from "./inventory.constants.js";

export type TInventoryItemType = (typeof InventoryItemTypes)[keyof typeof InventoryItemTypes];
export type TInventoryUnit = (typeof InventoryUnits)[keyof typeof InventoryUnits];
export type TInventoryStatus = (typeof InventoryStatuses)[keyof typeof InventoryStatuses];
export type TInventoryTransactionType =
  (typeof InventoryTransactionTypes)[keyof typeof InventoryTransactionTypes];
export type TInventoryReferenceType =
  (typeof InventoryReferenceTypes)[keyof typeof InventoryReferenceTypes];

// Inventory (Model 19) — current stock of one farm item
export type TInventory = {
  inventoryCode: string;
  farmId: Types.ObjectId;
  itemName: string;
  itemType: TInventoryItemType;
  //FeedIngredient _id for Feed items (Medicine / Vaccine later)
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
  //always positive; transactionType gives the direction
  quantity: number;
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
