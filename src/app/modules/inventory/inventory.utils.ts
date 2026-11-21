import type { ClientSession, Types } from "mongoose";
import {
  INVENTORY_TRANSACTION_NO_PREFIX,
  InventoryItemTypes,
  InventoryStatuses,
} from "./inventory.constants.js";
import { InventoryCounterModel, InventoryModel } from "./inventory.model.js";

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * Next transactionNo, e.g. TRX-2026-000001. Atomic per-year counter, so concurrent
 * stock movements never share a number. Gaps (rolled-back transactions) are harmless.
 * The counter runs outside any transaction on purpose: a write conflict on the
 * counter document must not abort the caller's business transaction.
 */
export const generateTransactionNo = async (now: Date = new Date()): Promise<string> => {
  const year = now.getFullYear();
  const counter = await InventoryCounterModel.findOneAndUpdate(
    { _id: `inventoryTransaction-${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  return `${INVENTORY_TRANSACTION_NO_PREFIX}-${year}-${String(counter?.seq ?? 1).padStart(6, "0")}`;
};

//rows that can no longer be consumed from (spec: "Expired items cannot be used in feeding")
export const isUnusableInventory = (row: { status?: string; expiryDate?: Date | null }, at = new Date()) =>
  row.status === InventoryStatuses.EXPIRED ||
  row.status === InventoryStatuses.INACTIVE ||
  (!!row.expiryDate && new Date(row.expiryDate) < at);

/** The farm's Feed stock row for one FeedIngredient (null => the ingredient is not stocked). */
export const findFeedInventory = (
  farmId: Types.ObjectId,
  ingredientId: Types.ObjectId,
  session: ClientSession | null = null,
) =>
  InventoryModel.findOne({ farmId, itemType: InventoryItemTypes.FEED, referenceId: ingredientId })
    //prefer a usable row when several exist (e.g. an old Inactive one)
    .sort({ status: 1, updatedAt: -1 })
    .session(session)
    .lean();

export type TStockChange = {
  //stock before / after the change, in the inventory row's unit
  before: number;
  after: number;
  //absolute amount actually moved (may be less than requested for a capped decrease)
  applied: number;
};

/**
 * Atomically moves stock on one inventory row and recomputes its status
 * (Out of Stock at 0, Low Stock at/below reorderLevel, else Available).
 *
 *  - delta > 0 adds stock (Return), delta < 0 removes it (Consumption).
 *  - A decrease never makes stock negative: without `capAtZero` it only matches when
 *    enough stock exists (returns null otherwise); with `capAtZero` it removes what
 *    is on hand (authorized insufficient-stock override).
 *  - Expired / Inactive rows keep their status; decreases on them are refused.
 * One pipeline update, so concurrent feedings cannot oversell the same stock.
 */
export const applyStockChange = async (
  inventoryId: Types.ObjectId,
  delta: number,
  options: { session: ClientSession | null; capAtZero?: boolean; updatedBy?: Types.ObjectId | null },
): Promise<TStockChange | null> => {
  const amount = round4(delta);
  if (amount === 0) return { before: NaN, after: NaN, applied: 0 };

  const filter: Record<string, unknown> = { _id: inventoryId };
  if (amount < 0) {
    filter.status = { $nin: [InventoryStatuses.EXPIRED, InventoryStatuses.INACTIVE] };
    if (!options.capAtZero) filter.currentStock = { $gte: -amount };
  }

  const before = await InventoryModel.findOneAndUpdate(
    filter,
    [
      {
        $set: {
          currentStock: { $round: [{ $max: [0, { $add: ["$currentStock", amount] }] }, 4] },
          updatedAt: "$$NOW",
          ...(options.updatedBy ? { updatedBy: options.updatedBy } : {}),
        },
      },
      {
        $set: {
          status: {
            $switch: {
              branches: [
                {
                  case: { $in: ["$status", [InventoryStatuses.EXPIRED, InventoryStatuses.INACTIVE]] },
                  then: "$status",
                },
                { case: { $lte: ["$currentStock", 0] }, then: InventoryStatuses.OUT_OF_STOCK },
                { case: { $lte: ["$currentStock", "$reorderLevel"] }, then: InventoryStatuses.LOW_STOCK },
              ],
              default: InventoryStatuses.AVAILABLE,
            },
          },
        },
      },
    ],
    { returnDocument: "before", updatePipeline: true, session: options.session },
  ).lean();
  if (!before) return null;

  const after = round4(Math.max(0, before.currentStock + amount));
  return { before: before.currentStock, after, applied: round4(Math.abs(after - before.currentStock)) };
};
