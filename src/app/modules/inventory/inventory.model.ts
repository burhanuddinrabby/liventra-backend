import { model, Schema } from "mongoose";
import {
  InventoryItemTypes,
  InventoryReferenceTypes,
  InventoryStatuses,
  InventoryTransactionTypes,
  InventoryUnits,
  StockDirections,
} from "./inventory.constants.js";
import type { TInventory, TInventoryTransaction } from "./inventory.interface.js";

// Inventory (Model 19). currentStock may never go below zero (final schema rule
// "Stock can't be negative") and is changed only through InventoryTransaction.
const inventorySchema = new Schema<TInventory>(
  {
    inventoryCode: { type: String, required: true, unique: true, immutable: true, trim: true, uppercase: true },
    farmId: { type: Schema.Types.ObjectId, ref: "Farm", required: true, immutable: true },
    itemName: { type: String, required: true, trim: true, maxlength: 120 },
    itemType: { type: String, enum: Object.values(InventoryItemTypes), required: true },
    referenceId: { type: Schema.Types.ObjectId, default: null },
    category: { type: String, trim: true, maxlength: 60 },
    currentStock: { type: Number, required: true, min: 0, default: 0 },
    unit: { type: String, enum: Object.values(InventoryUnits), required: true },
    minimumStock: { type: Number, required: true, min: 0, default: 0 },
    maximumStock: { type: Number, required: true, min: 0, default: 0 },
    reorderLevel: { type: Number, required: true, min: 0, default: 0 },
    averagePurchasePrice: { type: Number, min: 0 },
    supplierName: { type: String, trim: true, maxlength: 120 },
    storageLocation: { type: String, trim: true, maxlength: 120 },
    expiryDate: { type: Date, default: null },
    status: {
      type: String,
      enum: Object.values(InventoryStatuses),
      required: true,
      default: InventoryStatuses.AVAILABLE,
    },
    remarks: { type: String, trim: true, maxlength: 1000 },
    createdBy: { type: Schema.Types.ObjectId, ref: "FarmMember", required: true, immutable: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "FarmMember", default: null },
  },
  { timestamps: true },
);

//FeedRecord stock lookup: the farm's stock row for a feed ingredient
inventorySchema.index({ farmId: 1, itemType: 1, referenceId: 1 });
inventorySchema.index({ farmId: 1, status: 1 });
//FeedIngredient /usage counts read this path
inventorySchema.index({ referenceId: 1 });
//farm list / detail-by-code lookups (spec 19 §122)
inventorySchema.index({ farmId: 1, inventoryCode: 1 });
inventorySchema.index({ farmId: 1, itemType: 1, status: 1 });
//expiry dashboards and the ?expiringDays filter
inventorySchema.index({ farmId: 1, expiryDate: 1 });
//item-name search inside one farm
inventorySchema.index({ farmId: 1, itemName: 1 });

export const InventoryModel = model<TInventory>("Inventory", inventorySchema);

// Inventory_Transaction (Model 20). A saved transaction is ledger evidence: every
// field is immutable and there is no update/delete path ("Transaction (never delete)").
// Mistakes are corrected with an offsetting row (POST /inventory-transactions/:id/reverse).
const inventoryTransactionSchema = new Schema<TInventoryTransaction>(
  {
    transactionNo: { type: String, required: true, unique: true, immutable: true, trim: true, uppercase: true },
    farmId: { type: Schema.Types.ObjectId, ref: "Farm", required: true, immutable: true },
    inventoryId: { type: Schema.Types.ObjectId, ref: "Inventory", required: true, immutable: true },
    transactionType: {
      type: String,
      enum: Object.values(InventoryTransactionTypes),
      required: true,
      immutable: true,
    },
    transactionDate: { type: Date, required: true, immutable: true },
    quantity: { type: Number, required: true, min: 0, immutable: true },
    //resolved In / Out; only stored for types whose direction is not fixed by the type
    direction: { type: String, enum: Object.values(StockDirections), immutable: true },
    unit: { type: String, enum: Object.values(InventoryUnits), immutable: true },
    unitPrice: { type: Number, min: 0, immutable: true },
    totalAmount: { type: Number, min: 0, immutable: true },
    referenceType: { type: String, enum: Object.values(InventoryReferenceTypes), immutable: true },
    referenceId: { type: Schema.Types.ObjectId, default: null, immutable: true },
    supplierName: { type: String, trim: true, immutable: true },
    remarks: { type: String, trim: true, maxlength: 1000, immutable: true },
    performedBy: { type: Schema.Types.ObjectId, ref: "FarmMember", required: true, immutable: true },
  },
  { timestamps: true },
);

//ledger of one source document (e.g. all stock movements of a FeedRecord)
inventoryTransactionSchema.index({ referenceType: 1, referenceId: 1 });
inventoryTransactionSchema.index({ farmId: 1, inventoryId: 1, transactionDate: -1 });
//transaction reports and the farm-wide ledger list (spec 20 §106)
inventoryTransactionSchema.index({ farmId: 1, transactionType: 1, transactionDate: -1 });
inventoryTransactionSchema.index({ farmId: 1, transactionDate: -1 });
inventoryTransactionSchema.index({ farmId: 1, performedBy: 1, transactionDate: -1 });

export const InventoryTransactionModel = model<TInventoryTransaction>(
  "InventoryTransaction",
  inventoryTransactionSchema,
);

// Atomic per-year sequence for transactionNo (stock movements happen concurrently).
type TInventoryCounter = { _id: string; seq: number };

const inventoryCounterSchema = new Schema<TInventoryCounter>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);

export const InventoryCounterModel = model<TInventoryCounter>("InventoryCounter", inventoryCounterSchema);
