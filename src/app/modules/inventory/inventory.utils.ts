import type { ClientSession, Types } from "mongoose";
import {
  INVENTORY_CODE_PREFIX,
  INVENTORY_TRANSACTION_NO_PREFIX,
  InventoryItemTypes,
  InventoryStatuses,
  InventoryTransactionTypes,
  MONEY_DECIMALS,
  QUANTITY_DECIMALS,
  StockDirections,
  TRANSACTION_DIRECTIONS,
} from "./inventory.constants.js";
import type { TInventoryStatus, TStockDirection } from "./inventory.interface.js";
import { InventoryCounterModel, InventoryModel } from "./inventory.model.js";

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/** Quantity rounding (4 decimals) — one place so stock math never drifts. */
export const roundQuantity = (value: number) =>
  Math.round(value * 10 ** QUANTITY_DECIMALS) / 10 ** QUANTITY_DECIMALS;

/** Money rounding (2 decimals) — spec 20 §44: never store raw floating-point money. */
export const roundMoney = (value: number) =>
  Math.round(value * 10 ** MONEY_DECIMALS) / 10 ** MONEY_DECIMALS;

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
  options: {
    session: ClientSession | null;
    capAtZero?: boolean;
    updatedBy?: Types.ObjectId | null;
    /**
     * Allows an outflow on an Expired / Inactive row. Only the authorized disposal
     * workflows use it (transactionType `Expired`, and write-offs on a retired item):
     * normal consumption must keep failing on unusable stock.
     */
    allowUnusable?: boolean;
  },
): Promise<TStockChange | null> => {
  const amount = round4(delta);
  if (amount === 0) return { before: NaN, after: NaN, applied: 0 };

  const filter: Record<string, unknown> = { _id: inventoryId };
  if (amount < 0) {
    if (!options.allowUnusable) {
      filter.status = { $nin: [InventoryStatuses.EXPIRED, InventoryStatuses.INACTIVE] };
      //a row whose expiry has passed but whose stored status is still stale
      filter.$or = [{ expiryDate: null }, { expiryDate: { $exists: false } }, { expiryDate: { $gte: new Date() } }];
    }
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

/**
 * Next inventoryCode, e.g. INV-2026-000001. Atomic per-year counter (same pattern as
 * transactionNo), so two people registering an item at once never collide. The unique
 * index on `inventoryCode` is still the real guard — retry on duplicate key 11000.
 */
export const generateInventoryCode = async (now: Date = new Date()): Promise<string> => {
  const year = now.getFullYear();
  const counter = await InventoryCounterModel.findOneAndUpdate(
    { _id: `inventoryItem-${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  return `${INVENTORY_CODE_PREFIX}-${year}-${String(counter?.seq ?? 1).padStart(6, "0")}`;
};

/**
 * Operational status of a stock row, in the fixed priority of spec 19 §49/§87:
 *   Inactive → Expired → Out of Stock → Low Stock → Available
 * `inactive` is the administrative decision (the stored status), everything else is
 * derived from stock, thresholds and expiry. Keeping it in one function stops the UI
 * from inventing a conflicting status.
 */
export const deriveInventoryStatus = (
  row: {
    currentStock: number;
    minimumStock?: number;
    reorderLevel?: number;
    expiryDate?: Date | null;
    status?: string;
  },
  at: Date = new Date(),
): TInventoryStatus => {
  if (row.status === InventoryStatuses.INACTIVE) return InventoryStatuses.INACTIVE;
  if (row.expiryDate && new Date(row.expiryDate).getTime() < at.getTime()) {
    return InventoryStatuses.EXPIRED;
  }
  if (row.currentStock <= 0) return InventoryStatuses.OUT_OF_STOCK;
  //the low-stock line is the higher of reorderLevel / minimumStock (reorder first)
  const threshold = Math.max(row.reorderLevel ?? 0, row.minimumStock ?? 0);
  if (threshold > 0 && row.currentStock <= threshold) return InventoryStatuses.LOW_STOCK;
  return InventoryStatuses.AVAILABLE;
};

/**
 * Stock direction of a ledger row (spec 20 §115–117).
 * The stored `direction` wins when present (Adjustment / Return rows written by this
 * module); otherwise it comes from the transactionType map, where `Return` means
 * stock coming back **into** inventory — the convention FeedRecord / Treatment /
 * Vaccination already write when they undo a consumption.
 */
export const resolveDirection = (
  transactionType: string,
  storedDirection?: string | null,
): TStockDirection => {
  if (storedDirection === StockDirections.IN || storedDirection === StockDirections.OUT) {
    return storedDirection;
  }
  return TRANSACTION_DIRECTIONS[transactionType] ?? StockDirections.OUT;
};

/** Signed stock delta of a ledger row: +quantity for an inflow, -quantity for an outflow. */
export const signedDelta = (row: {
  transactionType: string;
  quantity: number;
  direction?: string | null;
}): number =>
  resolveDirection(row.transactionType, row.direction ?? null) === StockDirections.IN
    ? roundQuantity(row.quantity)
    : -roundQuantity(row.quantity);

/**
 * Weighted-average purchase price after an inflow (spec 19 §33, §58):
 *   (oldStock * oldAvg + purchaseQty * unitPrice) / (oldStock + purchaseQty)
 * Falls back to the new unitPrice when there is no previous stock or average.
 */
export const weightedAveragePrice = (
  oldStock: number,
  oldAverage: number | null | undefined,
  purchaseQuantity: number,
  unitPrice: number,
): number => {
  const total = oldStock + purchaseQuantity;
  if (total <= 0) return roundMoney(unitPrice);
  if (!oldAverage || oldStock <= 0) return roundMoney(unitPrice);
  return roundMoney((oldStock * oldAverage + purchaseQuantity * unitPrice) / total);
};

/**
 * Reorder recommendation (spec 19 §101): how much to buy to reach maximumStock, and
 * only once the item is at or below its reorder line. Calculated, never stored.
 */
export const recommendedReorderQuantity = (row: {
  currentStock: number;
  reorderLevel?: number;
  minimumStock?: number;
  maximumStock?: number;
}): number => {
  const threshold = Math.max(row.reorderLevel ?? 0, row.minimumStock ?? 0);
  if (threshold <= 0 || row.currentStock > threshold) return 0;
  const target = row.maximumStock && row.maximumStock > 0 ? row.maximumStock : threshold * 2;
  return roundQuantity(Math.max(0, target - row.currentStock));
};

/** Estimated value of a stock row (spec 19 §94). An estimate: it uses the average price. */
export const estimatedStockValue = (row: { currentStock: number; averagePurchasePrice?: number }): number =>
  roundMoney(row.currentStock * (row.averagePurchasePrice ?? 0));

//whole days from `at` until the expiry day (negative = already expired)
export const daysUntilExpiry = (expiryDate?: Date | null, at: Date = new Date()): number | null => {
  if (!expiryDate) return null;
  const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((day(new Date(expiryDate)) - day(at)) / (24 * 60 * 60 * 1000));
};

/** Ledger rows of one item in chronological order with a running balance (spec 20 §157). */
export const withRunningBalance = <
  T extends { transactionType: string; quantity: number; direction?: string | null },
>(
  rows: T[],
  openingBalance = 0,
): (T & { delta: number; balance: number })[] => {
  let balance = roundQuantity(openingBalance);
  return rows.map((row) => {
    const delta = signedDelta(row);
    balance = roundQuantity(balance + delta);
    return { ...row, delta, balance };
  });
};

//transaction types that reduce stock through loss rather than use (dashboard wastage)
export const WASTAGE_TYPES = [
  InventoryTransactionTypes.DAMAGE,
  InventoryTransactionTypes.EXPIRED,
] as const;
