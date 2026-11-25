import status from "http-status";
import { isValidObjectId, Types } from "mongoose";
import type { ClientSession, PipelineStage } from "mongoose";
import { NotificationProducers } from "../notification/notification.producers.js";
import AppError from "../../errors/AppError.js";
import { AuditActions, AuditEntityTypes, AuditModules } from "../auditLog/auditLog.constants.js";
import type { TAuditAction } from "../auditLog/auditLog.interface.js";
import { AuditLogModel } from "../auditLog/auditLog.model.js";
import { recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext } from "../auditLog/auditLog.utils.js";
import { ExpenseModel } from "../expense/expense.model.js";
import { FarmStatuses } from "../farm/farm.constants.js";
import { FarmModel } from "../farm/farm.model.js";
import { FeedIngredientModel } from "../feedIngredient/feedIngredient.model.js";
import type { TFarmMemberRole } from "../farmMember/farmMember.interface.js";
import { FarmMemberServices } from "../farmMember/farmMember.service.js";
import {
  DAY_MS,
  escapeRegex,
  executeAtomically,
  isBlank,
  pageMeta,
  parseBoolean,
  parseCalendarDate,
  parseDateRange,
  parseEnum,
  parseEnumList,
  parseNumber,
  parsePaging,
} from "../feedRecord/feedRecord.utils.js";
import type { TPayload, TUndo } from "../feedRecord/feedRecord.utils.js";
import { MedicineModel } from "../medicine/medicine.model.js";
import { VaccineModel } from "../vaccine/vaccine.model.js";
import {
  CONSUMABLE_STATUSES,
  DASHBOARD_LIST_LIMIT,
  DEFAULT_EXPIRING_DAYS,
  DETAIL_LEDGER_PREVIEW,
  DIRECTIONAL_TRANSACTION_TYPES,
  EXPIRY_WARNING_WINDOWS,
  FUTURE_TOLERANCE_HOURS,
  INVENTORY_CATEGORY_SUGGESTIONS,
  INVENTORY_CODE_PATTERN,
  INVENTORY_SORT_FIELDS,
  InventoryItemTypes,
  InventoryPermissions,
  InventoryReferenceTypes,
  InventoryStatuses,
  InventoryTransactionTypes,
  InventoryUnits,
  ITEM_TYPE_MASTERS,
  LOCKED_INVENTORY_FIELDS,
  MANUAL_REFERENCE_TYPES,
  MANUAL_TRANSACTION_TYPES,
  MAX_BACKDATE_DAYS,
  MAX_CATEGORY,
  MAX_EXPIRING_DAYS,
  MAX_ITEM_NAME,
  MAX_LEDGER_LIMIT,
  MAX_LIST_LIMIT,
  MAX_REMARKS,
  MAX_SHORT_TEXT,
  MAX_STOCK_QUANTITY,
  MAX_STORAGE_LOCATION,
  MAX_SUPPLIER_NAME,
  MAX_TOTAL_AMOUNT,
  MAX_UNIT_PRICE,
  SERVER_MANAGED_INVENTORY_FIELDS,
  SERVER_MANAGED_TRANSACTION_FIELDS,
  StockDirections,
  TOTAL_AMOUNT_TOLERANCE,
  TRANSACTION_NO_PATTERN,
  TRANSACTION_SORT_FIELDS,
  TRANSACTION_TYPE_PERMISSIONS,
  UPDATABLE_INVENTORY_FIELDS,
  WORKFLOW_ONLY_TRANSACTION_TYPES,
} from "./inventory.constants.js";
import type {
  TInventoryDoc,
  TInventoryItemType,
  TInventoryReferenceType,
  TInventoryStatus,
  TInventoryTransactionDoc,
  TInventoryTransactionType,
  TInventoryUnit,
  TStockDirection,
} from "./inventory.interface.js";
import { InventoryModel, InventoryTransactionModel } from "./inventory.model.js";
import {
  applyStockChange,
  daysUntilExpiry,
  deriveInventoryStatus,
  estimatedStockValue,
  generateInventoryCode,
  generateTransactionNo,
  recommendedReorderQuantity,
  resolveDirection,
  roundMoney,
  roundQuantity,
  signedDelta,
  WASTAGE_TYPES,
  weightedAveragePrice,
  withRunningBalance,
} from "./inventory.utils.js";

const ITEM_TYPES = Object.values(InventoryItemTypes) as string[];
const UNITS = Object.values(InventoryUnits) as string[];
const STATUSES = Object.values(InventoryStatuses) as string[];
const TRANSACTION_TYPES = Object.values(InventoryTransactionTypes) as string[];
const REFERENCE_TYPES = Object.values(InventoryReferenceTypes) as string[];
const DIRECTIONS = Object.values(StockDirections) as string[];

const sessionOpts = (session: ClientSession | null) => (session ? { session } : {});

/**
 * Extra work done inside the stock unit of work, right after the ledger row is written
 * (the Expense purchase workflow books its linked expense here, so stock and money are
 * saved together or not at all).
 */
type TAfterTransaction = (
  // eslint-disable-next-line no-unused-vars
  transaction: TInventoryTransactionDoc,
  // eslint-disable-next-line no-unused-vars
  session: ClientSession | null,
  // eslint-disable-next-line no-unused-vars
  undo: TUndo,
) => Promise<void>;

/* -------------------------------------------------------------------------- */
/*                         Farm-scoped authorization                          */
/* -------------------------------------------------------------------------- */

type TAccess = {
  farmObjectId: Types.ObjectId;
  farmStatus: string;
  role: TFarmMemberRole;
  //FarmMember _id of the caller; null only for a super admin without a membership row
  memberObjectId: Types.ObjectId | null;
};

/** Active membership (super admin / Farm.ownerId act as Owner) + farm status. */
const resolveAccess = async (farmId: string, requesterUserId: string): Promise<TAccess> => {
  const access = await FarmMemberServices.resolveFarmAccess(farmId, requesterUserId);
  const role = FarmMemberServices.getActorRole(access);
  if (!role) throw new AppError(status.FORBIDDEN, "You are not an active member of this farm!");

  let memberObjectId = (access.membership?._id as Types.ObjectId | undefined) ?? null;
  if (!memberObjectId && access.isOwnerAccount) {
    //the owner account self-heals a missing Owner row so it can always sign stock movements
    const row = await FarmMemberServices.ensureOwnerMembership(access.farm._id, access.user._id);
    memberObjectId = (row?._id as Types.ObjectId | undefined) ?? null;
  }
  const farm = await FarmModel.findById(access.farm._id).select("status").lean();
  return {
    farmObjectId: access.farm._id,
    farmStatus: farm?.status ?? FarmStatuses.ACTIVE,
    role,
    memberObjectId,
  };
};

const can = (access: TAccess, allowed: readonly string[]) => allowed.includes(access.role);

const requireRole = (access: TAccess, allowed: readonly string[], action: string) => {
  if (!can(access, allowed)) {
    throw new AppError(status.FORBIDDEN, `Your farm role (${access.role}) is not allowed to ${action}!`);
  }
};

/** Setup / Suspended / Inactive farms cannot move stock (records stay readable). */
const requireWritableFarm = (access: TAccess) => {
  if (access.farmStatus !== FarmStatuses.ACTIVE) {
    throw new AppError(
      status.FORBIDDEN,
      `This farm is ${access.farmStatus} — inventory can only be changed on an Active farm!`,
    );
  }
};

//createdBy / performedBy are signed by a FarmMember row
const requireMemberRow = (access: TAccess): Types.ObjectId => {
  if (!access.memberObjectId) {
    throw new AppError(status.FORBIDDEN, "An active farm membership is required to change inventory!");
  }
  return access.memberObjectId;
};

const rejectServerFields = (body: TPayload, fields: readonly string[]) => {
  const sent = fields.filter((field) => field in body);
  if (sent.length) {
    throw new AppError(status.BAD_REQUEST, `${sent.join(", ")} cannot be sent — the server manages these values.`);
  }
};

/* -------------------------------------------------------------------------- */
/*                               Field parsing                                */
/* -------------------------------------------------------------------------- */

const parseText = (field: string, value: unknown, max = MAX_REMARKS): string | undefined => {
  if (isBlank(value)) return undefined;
  if (typeof value !== "string") throw new AppError(status.BAD_REQUEST, `${field} must be text!`);
  const text = value.trim().replace(/[ \t]+/g, " ");
  if (text.length > max) throw new AppError(status.BAD_REQUEST, `${field} cannot exceed ${max} characters!`);
  return text;
};

const requireReason = (field: string, value: unknown, action: string): string => {
  const text = parseText(field, value, MAX_SHORT_TEXT);
  if (!text || text.length < 3) {
    throw new AppError(status.BAD_REQUEST, `${field} is required to ${action} (at least 3 characters)!`);
  }
  return text;
};

const parseQuantity = (field: string, value: unknown, { allowZero = false } = {}): number =>
  roundQuantity(
    parseNumber(field, value, { min: 0, max: MAX_STOCK_QUANTITY, ...(allowZero ? {} : { exclusiveMin: true }) }),
  );

const parseMoney = (field: string, value: unknown, max = MAX_UNIT_PRICE): number =>
  roundMoney(parseNumber(field, value, { min: 0, max }));

const FUTURE_MS = FUTURE_TOLERANCE_HOURS * 60 * 60 * 1000;

/**
 * transactionDate (spec 20 §30–32): the business date of the movement, which may be
 * backdated (stock counted yesterday) but never invented far in the past or future.
 * `createdAt` keeps the real system time, so the two stay distinguishable.
 */
const parseTransactionDate = (value: unknown): Date => {
  if (isBlank(value)) return new Date();
  const date = parseCalendarDate("transactionDate", value);
  const now = Date.now();
  if (date.getTime() > now + FUTURE_MS) {
    throw new AppError(status.BAD_REQUEST, "transactionDate cannot be in the future!");
  }
  if (date.getTime() < now - MAX_BACKDATE_DAYS * DAY_MS) {
    throw new AppError(
      status.BAD_REQUEST,
      `transactionDate cannot be more than ${MAX_BACKDATE_DAYS} days in the past!`,
    );
  }
  return date;
};

/** expiryDate is a calendar day; a past date is accepted (it makes the row Expired). */
const parseExpiryDate = (value: unknown): Date | null =>
  isBlank(value) ? null : parseCalendarDate("expiryDate", value);

/* -------------------------------------------------------------------------- */
/*                      Master catalog (polymorphic ref)                      */
/* -------------------------------------------------------------------------- */

type TMasterRow = { _id: Types.ObjectId; name: string; code: string; isActive?: boolean };

const loadMaster = async (itemType: string, referenceId: Types.ObjectId): Promise<TMasterRow | null> => {
  if (itemType === InventoryItemTypes.FEED) {
    const row = await FeedIngredientModel.findById(referenceId).select("ingredientName ingredientCode isActive").lean();
    return row ? { _id: row._id, name: row.ingredientName, code: row.ingredientCode, isActive: row.isActive } : null;
  }
  if (itemType === InventoryItemTypes.MEDICINE) {
    const row = await MedicineModel.findById(referenceId).select("medicineName medicineCode isActive").lean();
    return row ? { _id: row._id, name: row.medicineName, code: row.medicineCode, isActive: row.isActive } : null;
  }
  if (itemType === InventoryItemTypes.VACCINE) {
    const row = await VaccineModel.findById(referenceId).select("vaccineName vaccineCode isActive").lean();
    return row ? { _id: row._id, name: row.vaccineName, code: row.vaccineCode, isActive: row.isActive } : null;
  }
  return null;
};

/**
 * Validates `referenceId` against the master collection that `itemType` demands
 * (spec 19 §17–18): Feed → FeedIngredient, Medicine → Medicine, Vaccine → Vaccine.
 * Equipment / Cleaning Supply / Other have no master catalog, so a referenceId there
 * is rejected instead of being silently stored as an unresolvable pointer.
 */
const resolveReference = async (
  itemType: string,
  value: unknown,
): Promise<{ referenceId: Types.ObjectId | null; master: TMasterRow | null }> => {
  const masterName = (ITEM_TYPE_MASTERS as Record<string, string | undefined>)[itemType];
  if (isBlank(value)) {
    if (masterName) {
      throw new AppError(
        status.BAD_REQUEST,
        `referenceId is required for ${itemType} stock — pick the ${masterName} this item comes from.`,
      );
    }
    return { referenceId: null, master: null };
  }
  if (!masterName) {
    throw new AppError(
      status.BAD_REQUEST,
      `${itemType} items have no master catalog — do not send referenceId (use itemName instead).`,
    );
  }
  if (typeof value !== "string" || !isValidObjectId(value)) {
    throw new AppError(status.BAD_REQUEST, `referenceId must be a valid ${masterName} id!`);
  }
  const referenceId = new Types.ObjectId(value);
  const master = await loadMaster(itemType, referenceId);
  if (!master) {
    throw new AppError(status.NOT_FOUND, `No ${masterName} found for the given referenceId!`);
  }
  if (master.isActive === false) {
    throw new AppError(
      status.UNPROCESSABLE_ENTITY,
      `${master.name} (${master.code}) is retired in the ${masterName} catalog and cannot be stocked.`,
    );
  }
  return { referenceId, master };
};

/* -------------------------------------------------------------------------- */
/*                                  Finders                                   */
/* -------------------------------------------------------------------------- */

/** Inventory reference: Mongo _id or INV-YYYY-NNNNNN, always farm-scoped. */
const findItem = async (access: TAccess, ref: string): Promise<TInventoryDoc> => {
  const value = String(ref ?? "").trim();
  if (!value) throw new AppError(status.BAD_REQUEST, "An inventory id or inventoryCode is required!");
  if (!isValidObjectId(value) && !INVENTORY_CODE_PATTERN.test(value)) {
    throw new AppError(status.BAD_REQUEST, "Use an inventory _id or an inventoryCode like INV-2026-000001!");
  }
  const filter: Record<string, unknown> = isValidObjectId(value)
    ? { _id: new Types.ObjectId(value) }
    : { inventoryCode: value.toUpperCase() };
  const doc = await InventoryModel.findOne({ ...filter, farmId: access.farmObjectId }).lean();
  if (!doc) throw new AppError(status.NOT_FOUND, "Inventory item not found in this farm!");
  return doc as TInventoryDoc;
};

/** Transaction reference: Mongo _id or TRX-YYYY-NNNNNN, always farm-scoped. */
const findTransaction = async (access: TAccess, ref: string): Promise<TInventoryTransactionDoc> => {
  const value = String(ref ?? "").trim();
  if (!value) throw new AppError(status.BAD_REQUEST, "A transaction id or transactionNo is required!");
  if (!isValidObjectId(value) && !TRANSACTION_NO_PATTERN.test(value)) {
    throw new AppError(status.BAD_REQUEST, "Use a transaction _id or a transactionNo like TRX-2026-000001!");
  }
  const filter: Record<string, unknown> = isValidObjectId(value)
    ? { _id: new Types.ObjectId(value) }
    : { transactionNo: value.toUpperCase() };
  const doc = await InventoryTransactionModel.findOne({ ...filter, farmId: access.farmObjectId }).lean();
  if (!doc) throw new AppError(status.NOT_FOUND, "Inventory transaction not found in this farm!");
  return doc as TInventoryTransactionDoc;
};

const MEMBER_POPULATE = { select: "role userId", populate: { path: "userId", select: "userId fullName" } };

const audit = async (
  context: TAuditContext | undefined,
  farmId: Types.ObjectId,
  entityId: Types.ObjectId,
  entityType: (typeof AuditEntityTypes)[keyof typeof AuditEntityTypes],
  action: TAuditAction,
  event: string,
  oldData: Record<string, unknown> | null,
  newData: Record<string, unknown> | null,
  changedFields: string[] = [],
) => {
  await recordAuditLog({
    context,
    farmId,
    entityType,
    entityId,
    action,
    module: AuditModules.INVENTORY,
    event,
    oldData,
    newData,
    changedFields,
  });
};

/** Audit trace of an attempt, for the Rolled Back row. */
const traceOf = (
  context: TAuditContext | undefined,
  farmId: Types.ObjectId,
  entityId: Types.ObjectId | null,
  action: TAuditAction,
  event: string,
) => ({ context, farmId, entityType: AuditEntityTypes.INVENTORY_TRANSACTION, entityId, action, module: AuditModules.INVENTORY, event });

/* -------------------------------------------------------------------------- */
/*                     Derived status / derived fields (DB)                   */
/* -------------------------------------------------------------------------- */

/**
 * Adds the derived operational fields to an aggregation so list filters, sorting and
 * pagination all agree with what the client sees. The status priority is the same as
 * `deriveInventoryStatus()` (spec 19 §49): Inactive → Expired → Out of Stock →
 * Low Stock → Available. Nothing here is stored.
 */
const derivedFieldsStage = (now: Date): PipelineStage[] => [
  {
    $addFields: {
      lowStockThreshold: { $max: ["$reorderLevel", "$minimumStock"] },
      isExpired: {
        $and: [{ $ne: ["$expiryDate", null] }, { $lt: ["$expiryDate", now] }],
      },
    },
  },
  {
    $addFields: {
      derivedStatus: {
        $switch: {
          branches: [
            { case: { $eq: ["$status", InventoryStatuses.INACTIVE] }, then: InventoryStatuses.INACTIVE },
            { case: "$isExpired", then: InventoryStatuses.EXPIRED },
            { case: { $lte: ["$currentStock", 0] }, then: InventoryStatuses.OUT_OF_STOCK },
            {
              case: {
                $and: [
                  { $gt: ["$lowStockThreshold", 0] },
                  { $lte: ["$currentStock", "$lowStockThreshold"] },
                ],
              },
              then: InventoryStatuses.LOW_STOCK,
            },
          ],
          default: InventoryStatuses.AVAILABLE,
        },
      },
      estimatedValue: {
        $round: [{ $multiply: ["$currentStock", { $ifNull: ["$averagePurchasePrice", 0] }] }, 2],
      },
      daysUntilExpiry: {
        $cond: [
          { $eq: [{ $ifNull: ["$expiryDate", null] }, null] },
          null,
          { $dateDiff: { startDate: now, endDate: "$expiryDate", unit: "day" } },
        ],
      },
    },
  },
  {
    $addFields: {
      //what to buy to get back to maximumStock, only once at/below the reorder line
      recommendedReorderQuantity: {
        $cond: [
          {
            $and: [
              { $ne: ["$derivedStatus", InventoryStatuses.INACTIVE] },
              { $gt: ["$lowStockThreshold", 0] },
              { $lte: ["$currentStock", "$lowStockThreshold"] },
            ],
          },
          {
            $round: [
              {
                $max: [
                  0,
                  {
                    $subtract: [
                      {
                        $cond: [
                          { $gt: ["$maximumStock", 0] },
                          "$maximumStock",
                          { $multiply: ["$lowStockThreshold", 2] },
                        ],
                      },
                      "$currentStock",
                    ],
                  },
                ],
              },
              4,
            ],
          },
          0,
        ],
      },
    },
  },
];

/** The same derived block for a single lean row (detail / after-write responses). */
const withDerived = <T extends TInventoryDoc>(row: T, now: Date = new Date()) => ({
  ...row,
  derivedStatus: deriveInventoryStatus(row, now),
  lowStockThreshold: Math.max(row.reorderLevel ?? 0, row.minimumStock ?? 0),
  estimatedValue: estimatedStockValue(row),
  daysUntilExpiry: daysUntilExpiry(row.expiryDate ?? null, now),
  recommendedReorderQuantity: recommendedReorderQuantity(row),
});

/**
 * Low-stock / out-of-stock alert payload for a movement (spec 19 §78–81).
 * Returned only when the movement **crosses** the threshold, so repeated consumption
 * below the line does not raise the same alert again (spec 19 §80 de-duplication).
 * The matching notification is written by NotificationProducers.stockChanged().
 */
const stockAlertFor = (
  before: TInventoryStatus,
  after: TInventoryStatus,
  item: { itemName: string; inventoryCode: string; currentStock: number; unit: string },
) => {
  const alarming: string[] = [InventoryStatuses.LOW_STOCK, InventoryStatuses.OUT_OF_STOCK];
  if (!alarming.includes(after) || before === after) return null;
  if (alarming.includes(before) && after === InventoryStatuses.LOW_STOCK) return null;
  return {
    level: after === InventoryStatuses.OUT_OF_STOCK ? ("critical" as const) : ("warning" as const),
    status: after,
    message:
      after === InventoryStatuses.OUT_OF_STOCK
        ? `${item.itemName} (${item.inventoryCode}) is out of stock.`
        : `${item.itemName} (${item.inventoryCode}) stock is at or below its reorder level (${item.currentStock} ${item.unit} left).`,
  };
};

/* -------------------------------------------------------------------------- */
/*                         Inventory — create an item                         */
/* -------------------------------------------------------------------------- */

/**
 * POST /farms/:farmId/inventory — register a stock item (spec 19 §55–56).
 *  - validates the polymorphic referenceId against the itemType's master catalog
 *  - generates an immutable inventoryCode (INV-YYYY-NNNNNN)
 *  - never creates stock without history: `currentStock > 0` also writes the opening
 *    Inventory_Transaction (Purchase when a price is given, otherwise Adjustment)
 *    inside one atomic unit of work
 *  - computes the initial status with the shared priority rule
 */
const createInventoryItem = async (
  farmId: string,
  requesterUserId: string,
  body: TPayload,
  context?: TAuditContext,
  afterTransaction?: TAfterTransaction,
) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, InventoryPermissions.CREATE, "register inventory items");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);
  rejectServerFields(body, SERVER_MANAGED_INVENTORY_FIELDS);

  const itemType = parseEnum("itemType", body.itemType, ITEM_TYPES) as TInventoryItemType;
  const unit = parseEnum("unit", body.unit, UNITS) as TInventoryUnit;
  const { referenceId, master } = await resolveReference(itemType, body.referenceId);

  //the master catalog name is the default item name so stock and catalog stay aligned
  const itemName = parseText("itemName", body.itemName, MAX_ITEM_NAME) ?? master?.name;
  if (!itemName) throw new AppError(status.BAD_REQUEST, "itemName is required!");

  const category = parseText("category", body.category, MAX_CATEGORY);
  const supplierName = parseText("supplierName", body.supplierName, MAX_SUPPLIER_NAME);
  const storageLocation = parseText("storageLocation", body.storageLocation, MAX_STORAGE_LOCATION);
  const remarks = parseText("remarks", body.remarks);
  const expiryDate = parseExpiryDate(body.expiryDate);

  const currentStock = isBlank(body.currentStock) ? 0 : parseQuantity("currentStock", body.currentStock, { allowZero: true });
  const minimumStock = isBlank(body.minimumStock) ? 0 : parseQuantity("minimumStock", body.minimumStock, { allowZero: true });
  const maximumStock = isBlank(body.maximumStock) ? 0 : parseQuantity("maximumStock", body.maximumStock, { allowZero: true });
  const reorderLevel = isBlank(body.reorderLevel) ? 0 : parseQuantity("reorderLevel", body.reorderLevel, { allowZero: true });

  //thresholds must describe a sane ladder: minimum ≤ reorder ≤ maximum (spec 19 §100)
  if (maximumStock > 0 && minimumStock > maximumStock) {
    throw new AppError(status.BAD_REQUEST, "minimumStock cannot be greater than maximumStock!");
  }
  if (maximumStock > 0 && reorderLevel > maximumStock) {
    throw new AppError(status.BAD_REQUEST, "reorderLevel cannot be greater than maximumStock!");
  }
  if (reorderLevel > 0 && minimumStock > reorderLevel) {
    throw new AppError(
      status.BAD_REQUEST,
      "minimumStock cannot be greater than reorderLevel — minimum is the critical floor, reorder is the earlier warning.",
    );
  }

  //opening stock metadata (only meaningful when currentStock > 0)
  const openingType = isBlank(body.openingTransactionType)
    ? isBlank(body.openingUnitPrice)
      ? InventoryTransactionTypes.ADJUSTMENT
      : InventoryTransactionTypes.PURCHASE
    : (parseEnum("openingTransactionType", body.openingTransactionType, [
        InventoryTransactionTypes.PURCHASE,
        InventoryTransactionTypes.ADJUSTMENT,
      ]) as TInventoryTransactionType);
  const openingUnitPrice = isBlank(body.openingUnitPrice) ? null : parseMoney("openingUnitPrice", body.openingUnitPrice);
  const openingDate = parseTransactionDate(body.openingTransactionDate);
  const openingRemarks = parseText("openingRemarks", body.openingRemarks);

  if (currentStock <= 0 && (openingUnitPrice !== null || !isBlank(body.openingTransactionType))) {
    throw new AppError(
      status.BAD_REQUEST,
      "Opening stock details were sent but currentStock is 0 — record the purchase through POST /inventory-transactions instead.",
    );
  }
  if (openingType === InventoryTransactionTypes.PURCHASE && currentStock > 0 && openingUnitPrice === null) {
    throw new AppError(status.BAD_REQUEST, "openingUnitPrice is required when the opening stock is a Purchase!");
  }

  //duplicate guard: the same catalog item / name may be stocked twice only on purpose
  const duplicateFilter: Record<string, unknown> = {
    farmId: access.farmObjectId,
    itemType,
    status: { $ne: InventoryStatuses.INACTIVE },
    ...(referenceId ? { referenceId } : { itemName: new RegExp(`^${escapeRegex(itemName)}$`, "i") }),
  };
  const duplicate = await InventoryModel.findOne(duplicateFilter).select("inventoryCode itemName expiryDate").lean();
  if (duplicate && !parseBoolean(body.confirmDuplicate)) {
    throw new AppError(
      status.CONFLICT,
      `${duplicate.itemName} is already stocked as ${duplicate.inventoryCode}. Add stock to that item, or resend with confirmDuplicate: true to keep a separate row (for example a different batch or expiry).`,
    );
  }

  const averagePurchasePrice =
    openingType === InventoryTransactionTypes.PURCHASE && openingUnitPrice !== null ? openingUnitPrice : undefined;

  const initialStatus = deriveInventoryStatus({ currentStock, minimumStock, reorderLevel, expiryDate });

  const created = await executeAtomically(async (session, undo) => {
    const inventoryCode = await generateInventoryCode();
    const [item] = await InventoryModel.create(
      [
        {
          inventoryCode,
          farmId: access.farmObjectId,
          itemName,
          itemType,
          referenceId,
          ...(category ? { category } : {}),
          currentStock,
          unit,
          minimumStock,
          maximumStock,
          reorderLevel,
          ...(averagePurchasePrice !== undefined ? { averagePurchasePrice } : {}),
          ...(supplierName ? { supplierName } : {}),
          ...(storageLocation ? { storageLocation } : {}),
          expiryDate,
          status: initialStatus,
          ...(remarks ? { remarks } : {}),
          createdBy: memberId,
        },
      ],
      sessionOpts(session),
    );
    if (!item) throw new AppError(status.INTERNAL_SERVER_ERROR, "Inventory item could not be created!");
    undo.push(() => InventoryModel.deleteOne({ _id: item._id }));

    //spec 19 §56: stock may never exist without a transaction explaining its origin
    let openingTransaction: TInventoryTransactionDoc | null = null;
    if (currentStock > 0) {
      const transactionNo = await generateTransactionNo();
      const [trx] = await InventoryTransactionModel.create(
        [
          {
            transactionNo,
            farmId: access.farmObjectId,
            inventoryId: item._id,
            transactionType: openingType,
            transactionDate: openingDate,
            quantity: currentStock,
            direction: StockDirections.IN,
            unit,
            ...(openingUnitPrice !== null ? { unitPrice: openingUnitPrice } : {}),
            ...(openingUnitPrice !== null ? { totalAmount: roundMoney(currentStock * openingUnitPrice) } : {}),
            referenceType:
              openingType === InventoryTransactionTypes.PURCHASE
                ? InventoryReferenceTypes.PURCHASE
                : InventoryReferenceTypes.MANUAL,
            ...(supplierName ? { supplierName } : {}),
            remarks: openingRemarks ?? `Opening stock of ${inventoryCode}`,
            performedBy: memberId,
          },
        ],
        sessionOpts(session),
      );
      if (!trx) throw new AppError(status.INTERNAL_SERVER_ERROR, "Opening stock transaction could not be created!");
      undo.push(() => InventoryTransactionModel.deleteOne({ _id: trx._id }));
      openingTransaction = trx.toObject() as TInventoryTransactionDoc;
      if (afterTransaction) await afterTransaction(openingTransaction, session, undo);
    }

    return { item: item.toObject() as TInventoryDoc, openingTransaction };
  }, {
    trace: traceOf(context, access.farmObjectId, null, AuditActions.CREATE, "Inventory Item Registered"),
    log: async (created) => {
      await audit(
        context,
        access.farmObjectId,
        created.item._id,
        AuditEntityTypes.INVENTORY,
        AuditActions.CREATE,
        "Inventory Item Registered",
        null,
        {
          inventoryCode: created.item.inventoryCode,
          itemName,
          itemType,
          unit,
          currentStock,
          minimumStock,
          reorderLevel,
          maximumStock,
          status: initialStatus,
          openingTransactionNo: created.openingTransaction?.transactionNo ?? null,
        },
      );
    },
  });

  await NotificationProducers.stockChanged(access.farmObjectId, { _id: created.item._id });

  return {
    item: withDerived(created.item),
    openingTransaction: created.openingTransaction,
    master: master ? { _id: master._id, name: master.name, code: master.code } : null,
  };
};

/* -------------------------------------------------------------------------- */
/*                          Inventory — list / filters                        */
/* -------------------------------------------------------------------------- */

/**
 * GET /farms/:farmId/inventory — farm-wide stock list.
 * Filters: itemType, category, status (derived), lowStock, expiringDays, expired,
 * supplierName, storageLocation, itemName/inventoryCode search, includeInactive.
 * Runs as one aggregation so the derived status can be filtered and sorted on.
 */
const getFarmInventory = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, InventoryPermissions.READ, "view inventory");

  const { page, limit, skip } = parsePaging(query, MAX_LIST_LIMIT, 10);
  const now = new Date();

  const match: Record<string, unknown> = { farmId: access.farmObjectId };

  if (!isBlank(query.itemType)) {
    match.itemType = { $in: parseEnumList("itemType", query.itemType, ITEM_TYPES) };
  }
  if (!isBlank(query.category)) {
    match.category = new RegExp(`^${escapeRegex(String(query.category).trim())}$`, "i");
  }
  if (!isBlank(query.supplierName)) {
    match.supplierName = new RegExp(escapeRegex(String(query.supplierName).trim()), "i");
  }
  if (!isBlank(query.storageLocation)) {
    match.storageLocation = new RegExp(escapeRegex(String(query.storageLocation).trim()), "i");
  }
  if (!isBlank(query.referenceId)) {
    if (!isValidObjectId(String(query.referenceId))) {
      throw new AppError(status.BAD_REQUEST, "referenceId must be a valid id!");
    }
    match.referenceId = new Types.ObjectId(String(query.referenceId));
  }

  //searchTerm: itemName / inventoryCode / supplier / storage location
  const searchTerm = typeof query.searchTerm === "string" ? query.searchTerm.trim() : "";
  if (searchTerm) {
    const rx = new RegExp(escapeRegex(searchTerm), "i");
    match.$or = [{ itemName: rx }, { inventoryCode: rx }, { supplierName: rx }, { storageLocation: rx }];
  }

  //derived-status filters run after the $addFields stages
  const postMatch: Record<string, unknown> = {};
  if (!isBlank(query.status)) {
    postMatch.derivedStatus = { $in: parseEnumList("status", query.status, STATUSES) };
  } else if (!parseBoolean(query.includeInactive)) {
    //Inactive items are archive rows: hidden unless asked for or filtered on explicitly
    postMatch.derivedStatus = { $ne: InventoryStatuses.INACTIVE };
  }
  if (parseBoolean(query.lowStock)) {
    postMatch.derivedStatus = {
      ...(postMatch.derivedStatus as object | undefined),
      $in: [InventoryStatuses.LOW_STOCK, InventoryStatuses.OUT_OF_STOCK],
    };
  }
  if (parseBoolean(query.expired)) {
    postMatch.derivedStatus = InventoryStatuses.EXPIRED;
  }
  if (!isBlank(query.expiringDays)) {
    const days = parseNumber("expiringDays", query.expiringDays, { min: 1, max: MAX_EXPIRING_DAYS });
    //expiring soon = still usable today, expired within the window
    postMatch.daysUntilExpiry = { $gte: 0, $lte: Math.floor(days) };
  }

  //sort: only whitelisted fields, "-field" for descending
  const sortRaw = typeof query.sort === "string" && query.sort.trim() ? query.sort.trim() : "itemName";
  const descending = sortRaw.startsWith("-");
  const sortField = descending ? sortRaw.slice(1) : sortRaw;
  if (!(INVENTORY_SORT_FIELDS as readonly string[]).includes(sortField)) {
    throw new AppError(
      status.BAD_REQUEST,
      `sort must be one of: ${INVENTORY_SORT_FIELDS.join(", ")} (prefix with - for descending)!`,
    );
  }
  const sortStage: Record<string, 1 | -1> = {
    [sortField === "status" ? "derivedStatus" : sortField]: descending ? -1 : 1,
    _id: 1,
  };

  const pipeline: PipelineStage[] = [
    { $match: match },
    ...derivedFieldsStage(now),
    ...(Object.keys(postMatch).length ? [{ $match: postMatch } as PipelineStage] : []),
    {
      $facet: {
        rows: [
          { $sort: sortStage },
          { $skip: skip },
          { $limit: limit },
          { $project: { __v: 0, isExpired: 0 } },
        ],
        total: [{ $count: "count" }],
        //farm-wide totals for the list header (not just the current page)
        totals: [
          {
            $group: {
              _id: null,
              items: { $sum: 1 },
              estimatedValue: { $sum: "$estimatedValue" },
              lowStock: {
                $sum: { $cond: [{ $eq: ["$derivedStatus", InventoryStatuses.LOW_STOCK] }, 1, 0] },
              },
              outOfStock: {
                $sum: { $cond: [{ $eq: ["$derivedStatus", InventoryStatuses.OUT_OF_STOCK] }, 1, 0] },
              },
              expired: {
                $sum: { $cond: [{ $eq: ["$derivedStatus", InventoryStatuses.EXPIRED] }, 1, 0] },
              },
            },
          },
        ],
      },
    },
  ];

  const [result] = await InventoryModel.aggregate(pipeline);
  const total = (result?.total?.[0]?.count as number | undefined) ?? 0;
  const totals = result?.totals?.[0] ?? { items: 0, estimatedValue: 0, lowStock: 0, outOfStock: 0, expired: 0 };

  return {
    meta: pageMeta(page, limit, total),
    data: (result?.rows ?? []) as TInventoryDoc[],
    summary: {
      matchedItems: totals.items,
      estimatedValue: roundMoney(totals.estimatedValue ?? 0),
      lowStock: totals.lowStock,
      outOfStock: totals.outOfStock,
      expired: totals.expired,
    },
  };
};

/* -------------------------------------------------------------------------- */
/*                           Inventory — form metadata                        */
/* -------------------------------------------------------------------------- */

/** GET /farms/:farmId/inventory/meta — enums + suggestions that drive the UI forms. */
const getInventoryMeta = async (farmId: string, requesterUserId: string) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, InventoryPermissions.READ, "view inventory metadata");

  //categories already in use by this farm, so the dropdown learns from real data
  const used = (await InventoryModel.distinct("category", { farmId: access.farmObjectId })) as (string | null)[];

  return {
    itemTypes: Object.values(InventoryItemTypes),
    units: Object.values(InventoryUnits),
    statuses: Object.values(InventoryStatuses),
    transactionTypes: Object.values(InventoryTransactionTypes),
    manualTransactionTypes: MANUAL_TRANSACTION_TYPES,
    workflowOnlyTransactionTypes: WORKFLOW_ONLY_TRANSACTION_TYPES,
    directionalTransactionTypes: DIRECTIONAL_TRANSACTION_TYPES,
    referenceTypes: Object.values(InventoryReferenceTypes),
    manualReferenceTypes: MANUAL_REFERENCE_TYPES,
    directions: Object.values(StockDirections),
    categorySuggestions: INVENTORY_CATEGORY_SUGGESTIONS,
    farmCategories: used.filter((value): value is string => !!value).sort(),
    itemTypeMasters: ITEM_TYPE_MASTERS,
    expiryWarningWindows: EXPIRY_WARNING_WINDOWS,
    defaultExpiringDays: DEFAULT_EXPIRING_DAYS,
    sortFields: { inventory: INVENTORY_SORT_FIELDS, transactions: TRANSACTION_SORT_FIELDS },
    limits: {
      maxItemName: MAX_ITEM_NAME,
      maxRemarks: MAX_REMARKS,
      maxQuantity: MAX_STOCK_QUANTITY,
      maxUnitPrice: MAX_UNIT_PRICE,
      maxBackdateDays: MAX_BACKDATE_DAYS,
      maxListLimit: MAX_LIST_LIMIT,
    },
    //what this caller may do, so the UI can hide the buttons it cannot use
    permissions: {
      role: access.role,
      canCreateItem: can(access, InventoryPermissions.CREATE),
      canUpdateItem: can(access, InventoryPermissions.UPDATE),
      canToggleActive: can(access, InventoryPermissions.TOGGLE_ACTIVE),
      canDeleteItem: can(access, InventoryPermissions.DELETE),
      canReverseTransaction: can(access, InventoryPermissions.TRANSACTION_REVERSE),
      canCorrectPrice: can(access, InventoryPermissions.PRICE_CORRECTION),
      canViewAuditLogs: can(access, InventoryPermissions.AUDIT),
      allowedTransactionTypes: MANUAL_TRANSACTION_TYPES.filter((type) =>
        (TRANSACTION_TYPE_PERMISSIONS[type] ?? []).includes(access.role),
      ),
    },
    farmWritable: access.farmStatus === FarmStatuses.ACTIVE,
  };
};

/**
 * GET /farms/:farmId/inventory/lookup — light picker list (id, code, name, unit,
 * stock, status) for the transaction form and any "choose a stock item" dropdown.
 */
const getInventoryLookup = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, InventoryPermissions.READ, "view inventory");

  const match: Record<string, unknown> = { farmId: access.farmObjectId };
  if (!isBlank(query.itemType)) {
    match.itemType = { $in: parseEnumList("itemType", query.itemType, ITEM_TYPES) };
  }
  const searchTerm = typeof query.searchTerm === "string" ? query.searchTerm.trim() : "";
  if (searchTerm) {
    const rx = new RegExp(escapeRegex(searchTerm), "i");
    match.$or = [{ itemName: rx }, { inventoryCode: rx }];
  }
  //the picker shows usable items only unless the caller wants archived rows too
  if (!parseBoolean(query.includeInactive)) match.status = { $ne: InventoryStatuses.INACTIVE };

  const now = new Date();
  const rows = await InventoryModel.find(match)
    .select("inventoryCode itemName itemType category currentStock unit minimumStock reorderLevel maximumStock averagePurchasePrice expiryDate status storageLocation")
    .sort({ itemName: 1 })
    .limit(MAX_LEDGER_LIMIT)
    .lean();

  return rows.map((row) => ({
    _id: row._id,
    inventoryCode: row.inventoryCode,
    itemName: row.itemName,
    itemType: row.itemType,
    category: row.category ?? null,
    currentStock: row.currentStock,
    unit: row.unit,
    reorderLevel: row.reorderLevel,
    maximumStock: row.maximumStock,
    averagePurchasePrice: row.averagePurchasePrice ?? null,
    storageLocation: row.storageLocation ?? null,
    expiryDate: row.expiryDate ?? null,
    status: deriveInventoryStatus(row, now),
    consumable: (CONSUMABLE_STATUSES as readonly string[]).includes(deriveInventoryStatus(row, now)),
  }));
};

/**
 * GET /farms/:farmId/inventory/master-options?itemType=Feed — the master catalog rows
 * the create form can link to, each flagged with whether this farm already stocks it.
 */
const getMasterOptions = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, InventoryPermissions.READ, "view inventory master options");

  const itemType = parseEnum("itemType", query.itemType, Object.keys(ITEM_TYPE_MASTERS)) as TInventoryItemType;
  const searchTerm = typeof query.searchTerm === "string" ? query.searchTerm.trim() : "";
  const rx = searchTerm ? new RegExp(escapeRegex(searchTerm), "i") : null;
  const limit = Math.min(Math.max(Math.floor(Number(query.limit)) || 50, 1), MAX_LIST_LIMIT);

  let rows: TMasterRow[];
  let extra: Map<string, Record<string, unknown>>;

  if (itemType === InventoryItemTypes.FEED) {
    const found = await FeedIngredientModel.find({
      isActive: true,
      ...(rx ? { $or: [{ ingredientName: rx }, { ingredientCode: rx }] } : {}),
    })
      .select("ingredientName ingredientCode category unit")
      .sort({ ingredientName: 1 })
      .limit(limit)
      .lean();
    rows = found.map((row) => ({ _id: row._id, name: row.ingredientName, code: row.ingredientCode }));
    extra = new Map(found.map((row) => [String(row._id), { category: row.category, unit: row.unit }]));
  } else if (itemType === InventoryItemTypes.MEDICINE) {
    const found = await MedicineModel.find({
      isActive: true,
      ...(rx ? { $or: [{ medicineName: rx }, { medicineCode: rx }, { genericName: rx }] } : {}),
    })
      .select("medicineName medicineCode category dosageForm strength")
      .sort({ medicineName: 1 })
      .limit(limit)
      .lean();
    rows = found.map((row) => ({ _id: row._id, name: row.medicineName, code: row.medicineCode }));
    extra = new Map(
      found.map((row) => [
        String(row._id),
        { category: row.category, dosageForm: row.dosageForm, strength: row.strength ?? null },
      ]),
    );
  } else {
    const found = await VaccineModel.find({
      isActive: true,
      ...(rx ? { $or: [{ vaccineName: rx }, { vaccineCode: rx }, { shortCode: rx }] } : {}),
    })
      .select("vaccineName vaccineCode category storageTemperature")
      .sort({ vaccineName: 1 })
      .limit(limit)
      .lean();
    rows = found.map((row) => ({ _id: row._id, name: row.vaccineName, code: row.vaccineCode }));
    extra = new Map(found.map((row) => [String(row._id), { category: row.category }]));
  }

  //which of these the farm already keeps in stock (so the UI can say "already stocked")
  const stocked = await InventoryModel.find({
    farmId: access.farmObjectId,
    itemType,
    referenceId: { $in: rows.map((row) => row._id) },
  })
    .select("referenceId inventoryCode itemName currentStock unit status")
    .lean();
  const stockedBy = new Map(stocked.map((row) => [String(row.referenceId), row]));

  return rows.map((row) => {
    const existing = stockedBy.get(String(row._id));
    return {
      _id: row._id,
      name: row.name,
      code: row.code,
      ...(extra.get(String(row._id)) ?? {}),
      stocked: !!existing,
      inventory: existing
        ? {
            _id: existing._id,
            inventoryCode: existing.inventoryCode,
            currentStock: existing.currentStock,
            unit: existing.unit,
            status: existing.status,
          }
        : null,
    };
  });
};

/* -------------------------------------------------------------------------- */
/*                      Inventory — dashboard / alerts                        */
/* -------------------------------------------------------------------------- */

/**
 * GET /farms/:farmId/inventory/dashboard-summary (spec 19 §96).
 * Operational cards + reorder intelligence, all calculated — nothing is stored:
 * active item count, low / out-of-stock / expired counts, expiring-soon items,
 * reorder recommendations (maximumStock − currentStock) and estimated valuation.
 */
const getDashboardSummary = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, InventoryPermissions.READ, "view the inventory dashboard");

  const now = new Date();
  const expiringDays = isBlank(query.expiringDays)
    ? DEFAULT_EXPIRING_DAYS
    : Math.floor(parseNumber("expiringDays", query.expiringDays, { min: 1, max: MAX_EXPIRING_DAYS }));

  const [cards] = await InventoryModel.aggregate([
    { $match: { farmId: access.farmObjectId } },
    ...derivedFieldsStage(now),
    {
      $facet: {
        counts: [
          {
            $group: {
              _id: "$derivedStatus",
              items: { $sum: 1 },
              estimatedValue: { $sum: "$estimatedValue" },
            },
          },
        ],
        byItemType: [
          {
            $group: {
              _id: "$itemType",
              items: { $sum: 1 },
              estimatedValue: { $sum: "$estimatedValue" },
              lowStock: { $sum: { $cond: [{ $eq: ["$derivedStatus", InventoryStatuses.LOW_STOCK] }, 1, 0] } },
              outOfStock: { $sum: { $cond: [{ $eq: ["$derivedStatus", InventoryStatuses.OUT_OF_STOCK] }, 1, 0] } },
            },
          },
          { $sort: { items: -1 } },
        ],
        reorder: [
          { $match: { derivedStatus: { $ne: InventoryStatuses.INACTIVE }, recommendedReorderQuantity: { $gt: 0 } } },
          { $sort: { derivedStatus: 1, currentStock: 1 } },
          { $limit: DASHBOARD_LIST_LIMIT },
          {
            $project: {
              inventoryCode: 1,
              itemName: 1,
              itemType: 1,
              unit: 1,
              currentStock: 1,
              minimumStock: 1,
              reorderLevel: 1,
              maximumStock: 1,
              derivedStatus: 1,
              recommendedReorderQuantity: 1,
              averagePurchasePrice: 1,
              supplierName: 1,
              //rough cost of the recommended purchase, when an average price exists
              estimatedReorderCost: {
                $round: [
                  { $multiply: ["$recommendedReorderQuantity", { $ifNull: ["$averagePurchasePrice", 0] }] },
                  2,
                ],
              },
            },
          },
        ],
        expiringSoon: [
          {
            $match: {
              derivedStatus: { $nin: [InventoryStatuses.INACTIVE, InventoryStatuses.EXPIRED] },
              daysUntilExpiry: { $gte: 0, $lte: expiringDays },
            },
          },
          { $sort: { daysUntilExpiry: 1 } },
          { $limit: DASHBOARD_LIST_LIMIT },
          {
            $project: {
              inventoryCode: 1,
              itemName: 1,
              itemType: 1,
              unit: 1,
              currentStock: 1,
              expiryDate: 1,
              daysUntilExpiry: 1,
              derivedStatus: 1,
              storageLocation: 1,
            },
          },
        ],
        expiredItems: [
          { $match: { derivedStatus: InventoryStatuses.EXPIRED } },
          { $sort: { expiryDate: 1 } },
          { $limit: DASHBOARD_LIST_LIMIT },
          {
            $project: {
              inventoryCode: 1,
              itemName: 1,
              itemType: 1,
              unit: 1,
              currentStock: 1,
              expiryDate: 1,
              daysUntilExpiry: 1,
              estimatedValue: 1,
            },
          },
        ],
      },
    },
  ]);

  const counts = new Map<string, { items: number; estimatedValue: number }>(
    ((cards?.counts ?? []) as { _id: string; items: number; estimatedValue: number }[]).map((row) => [
      row._id,
      { items: row.items, estimatedValue: row.estimatedValue },
    ]),
  );
  const countOf = (statusValue: string) => counts.get(statusValue)?.items ?? 0;
  const inactiveItems = countOf(InventoryStatuses.INACTIVE);
  const totalItems = [...counts.values()].reduce((sum, row) => sum + row.items, 0);
  const activeItems = totalItems - inactiveItems;
  //valuation counts active stock only: archived rows are not part of operational value
  const estimatedStockValueTotal = [...counts.entries()]
    .filter(([key]) => key !== InventoryStatuses.INACTIVE)
    .reduce((sum, [, row]) => sum + (row.estimatedValue ?? 0), 0);

  //recent movements for the dashboard feed
  const recentTransactions = await InventoryTransactionModel.find({ farmId: access.farmObjectId })
    .sort({ transactionDate: -1, createdAt: -1 })
    .limit(DASHBOARD_LIST_LIMIT)
    .select("transactionNo inventoryId transactionType transactionDate quantity unit direction totalAmount referenceType supplierName remarks")
    .populate("inventoryId", "inventoryCode itemName itemType unit")
    .lean();

  //30-day movement totals so the dashboard can show flow, not just balances
  const windowStart = new Date(now.getTime() - 30 * DAY_MS);
  const flow = await InventoryTransactionModel.aggregate([
    { $match: { farmId: access.farmObjectId, transactionDate: { $gte: windowStart } } },
    {
      $group: {
        _id: "$transactionType",
        quantity: { $sum: "$quantity" },
        amount: { $sum: { $ifNull: ["$totalAmount", 0] } },
        movements: { $sum: 1 },
      },
    },
  ]);
  const flowOf = (type: string) => flow.find((row) => row._id === type) ?? { quantity: 0, amount: 0, movements: 0 };

  return {
    asOf: now,
    cards: {
      totalItems,
      activeItems,
      inactiveItems,
      available: countOf(InventoryStatuses.AVAILABLE),
      lowStock: countOf(InventoryStatuses.LOW_STOCK),
      outOfStock: countOf(InventoryStatuses.OUT_OF_STOCK),
      expired: countOf(InventoryStatuses.EXPIRED),
      expiringSoon: (cards?.expiringSoon ?? []).length,
      //alerts needing attention right now
      alertCount:
        countOf(InventoryStatuses.LOW_STOCK) +
        countOf(InventoryStatuses.OUT_OF_STOCK) +
        countOf(InventoryStatuses.EXPIRED),
      estimatedStockValue: roundMoney(estimatedStockValueTotal),
    },
    last30Days: {
      purchaseQuantity: roundQuantity(flowOf(InventoryTransactionTypes.PURCHASE).quantity),
      purchaseSpend: roundMoney(flowOf(InventoryTransactionTypes.PURCHASE).amount),
      consumptionQuantity: roundQuantity(
        flowOf(InventoryTransactionTypes.CONSUMPTION).quantity +
          flowOf(InventoryTransactionTypes.TREATMENT_USAGE).quantity +
          flowOf(InventoryTransactionTypes.VACCINATION_USAGE).quantity,
      ),
      wastageQuantity: roundQuantity(
        WASTAGE_TYPES.reduce((sum, type) => sum + flowOf(type).quantity, 0),
      ),
      movements: flow.reduce((sum, row) => sum + row.movements, 0),
    },
    byItemType: cards?.byItemType ?? [],
    reorderRecommendations: cards?.reorder ?? [],
    expiringSoon: cards?.expiringSoon ?? [],
    expiredItems: cards?.expiredItems ?? [],
    recentTransactions,
    expiringDays,
    notificationsPersisted: true,
  };
};

/**
 * GET /farms/:farmId/inventory/alerts — the actionable rows behind the dashboard
 * cards (low stock, out of stock, expiring, expired) in one call for the alert panel.
 */
const getInventoryAlerts = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, InventoryPermissions.READ, "view inventory alerts");

  const now = new Date();
  const expiringDays = isBlank(query.expiringDays)
    ? DEFAULT_EXPIRING_DAYS
    : Math.floor(parseNumber("expiringDays", query.expiringDays, { min: 1, max: MAX_EXPIRING_DAYS }));
  const limit = Math.min(Math.max(Math.floor(Number(query.limit)) || 50, 1), MAX_LIST_LIMIT);

  const project = {
    inventoryCode: 1,
    itemName: 1,
    itemType: 1,
    category: 1,
    unit: 1,
    currentStock: 1,
    minimumStock: 1,
    reorderLevel: 1,
    maximumStock: 1,
    recommendedReorderQuantity: 1,
    expiryDate: 1,
    daysUntilExpiry: 1,
    derivedStatus: 1,
    supplierName: 1,
    storageLocation: 1,
    estimatedValue: 1,
  };

  const [result] = await InventoryModel.aggregate([
    { $match: { farmId: access.farmObjectId, status: { $ne: InventoryStatuses.INACTIVE } } },
    ...derivedFieldsStage(now),
    {
      $facet: {
        lowStock: [
          { $match: { derivedStatus: InventoryStatuses.LOW_STOCK } },
          { $sort: { currentStock: 1 } },
          { $limit: limit },
          { $project: project },
        ],
        outOfStock: [
          { $match: { derivedStatus: InventoryStatuses.OUT_OF_STOCK } },
          { $sort: { itemName: 1 } },
          { $limit: limit },
          { $project: project },
        ],
        expired: [
          { $match: { derivedStatus: InventoryStatuses.EXPIRED } },
          { $sort: { expiryDate: 1 } },
          { $limit: limit },
          { $project: project },
        ],
        expiringSoon: [
          {
            $match: {
              derivedStatus: { $ne: InventoryStatuses.EXPIRED },
              daysUntilExpiry: { $gte: 0, $lte: expiringDays },
            },
          },
          { $sort: { daysUntilExpiry: 1 } },
          { $limit: limit },
          { $project: project },
        ],
      },
    },
  ]);

  const lowStock = result?.lowStock ?? [];
  const outOfStock = result?.outOfStock ?? [];
  const expired = result?.expired ?? [];
  const expiringSoon = result?.expiringSoon ?? [];

  return {
    asOf: now,
    expiringDays,
    counts: {
      lowStock: lowStock.length,
      outOfStock: outOfStock.length,
      expired: expired.length,
      expiringSoon: expiringSoon.length,
      total: lowStock.length + outOfStock.length + expired.length + expiringSoon.length,
    },
    lowStock,
    outOfStock,
    expired,
    expiringSoon,
  };
};

/* -------------------------------------------------------------------------- */
/*                           Inventory — single item                          */
/* -------------------------------------------------------------------------- */

/**
 * GET /farms/:farmId/inventory/:id — full detail by _id or inventoryCode, with the
 * populated master record, the derived status and a short ledger preview.
 */
const getInventoryItem = async (farmId: string, id: string, requesterUserId: string) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, InventoryPermissions.READ, "view inventory");

  const doc = await findItem(access, id);
  const populated = await InventoryModel.findById(doc._id)
    .select("-__v")
    .populate({ path: "createdBy", ...MEMBER_POPULATE })
    .populate({ path: "updatedBy", ...MEMBER_POPULATE })
    .lean();
  if (!populated) throw new AppError(status.NOT_FOUND, "Inventory item not found!");

  const master = doc.referenceId ? await loadMaster(doc.itemType, doc.referenceId) : null;

  //ledger preview + the reconciliation check of spec 20 §119/§160
  const [recentTransactions, ledgerTotals, movementCount] = await Promise.all([
    InventoryTransactionModel.find({ farmId: access.farmObjectId, inventoryId: doc._id })
      .sort({ transactionDate: -1, createdAt: -1 })
      .limit(DETAIL_LEDGER_PREVIEW)
      .select("transactionNo transactionType transactionDate quantity unit direction unitPrice totalAmount referenceType referenceId supplierName remarks performedBy createdAt")
      .populate({ path: "performedBy", ...MEMBER_POPULATE })
      .lean(),
    InventoryTransactionModel.find({ farmId: access.farmObjectId, inventoryId: doc._id })
      .select("transactionType quantity direction totalAmount")
      .lean(),
    InventoryTransactionModel.countDocuments({ farmId: access.farmObjectId, inventoryId: doc._id }),
  ]);

  const ledgerBalance = roundQuantity(ledgerTotals.reduce((sum, row) => sum + signedDelta(row), 0));
  const purchaseSpend = roundMoney(
    ledgerTotals
      .filter((row) => row.transactionType === InventoryTransactionTypes.PURCHASE)
      .reduce((sum, row) => sum + (row.totalAmount ?? 0), 0),
  );

  return {
    ...withDerived(populated as TInventoryDoc),
    master: master ? { _id: master._id, name: master.name, code: master.code, collection: ITEM_TYPE_MASTERS[doc.itemType as keyof typeof ITEM_TYPE_MASTERS] ?? null } : null,
    movementCount,
    purchaseSpend,
    reconciliation: {
      ledgerBalance,
      currentStock: doc.currentStock,
      //ledger sum must equal currentStock; a mismatch means a movement bypassed the ledger
      balanced: ledgerBalance === roundQuantity(doc.currentStock),
    },
    recentTransactions: recentTransactions.map((row) => ({
      ...row,
      direction: resolveDirection(row.transactionType, row.direction ?? null),
      delta: signedDelta(row),
    })),
  };
};

/**
 * GET /farms/:farmId/inventory/:inventoryId/ledger (spec 20 §157).
 * Chronological stock ledger of one item with the signed delta (+50 / −15) and a
 * running balance. Stored quantities stay positive; the sign is derived.
 */
const getInventoryLedger = async (
  farmId: string,
  inventoryIdRef: string,
  requesterUserId: string,
  query: TPayload,
) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, InventoryPermissions.READ, "view the stock ledger");

  const item = await findItem(access, inventoryIdRef);
  const { page, limit, skip } = parsePaging(query, MAX_LEDGER_LIMIT, 20);

  const filter: Record<string, unknown> = { farmId: access.farmObjectId, inventoryId: item._id };
  if (!isBlank(query.transactionType)) {
    filter.transactionType = { $in: parseEnumList("transactionType", query.transactionType, TRANSACTION_TYPES) };
  }
  if (!isBlank(query.from) || !isBlank(query.to)) {
    Object.assign(filter, parseDateRange(query, "transactionDate"));
  }

  //oldest first so the running balance reads like a bank statement
  const sort: Record<string, 1 | -1> = { transactionDate: 1, createdAt: 1, _id: 1 };

  const [total, rows] = await Promise.all([
    InventoryTransactionModel.countDocuments(filter),
    InventoryTransactionModel.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .select("transactionNo transactionType transactionDate quantity unit direction unitPrice totalAmount referenceType referenceId supplierName remarks performedBy createdAt")
      .populate({ path: "performedBy", ...MEMBER_POPULATE })
      .lean(),
  ]);

  //opening balance = every movement before this page (so page 2 continues page 1)
  const earlier = skip
    ? await InventoryTransactionModel.find(filter)
        .sort(sort)
        .limit(skip)
        .select("transactionType quantity direction")
        .lean()
    : [];
  const openingBalance = roundQuantity(earlier.reduce((sum, row) => sum + signedDelta(row), 0));

  const ledger = withRunningBalance(rows, openingBalance).map((row) => ({
    ...row,
    direction: resolveDirection(row.transactionType, row.direction ?? null),
  }));

  //full-ledger totals, independent of paging
  const allRows = await InventoryTransactionModel.find({ farmId: access.farmObjectId, inventoryId: item._id })
    .select("transactionType quantity direction")
    .lean();
  const closingBalance = roundQuantity(allRows.reduce((sum, row) => sum + signedDelta(row), 0));
  const totalIn = roundQuantity(
    allRows.filter((row) => signedDelta(row) > 0).reduce((sum, row) => sum + row.quantity, 0),
  );
  const totalOut = roundQuantity(
    allRows.filter((row) => signedDelta(row) < 0).reduce((sum, row) => sum + row.quantity, 0),
  );

  return {
    meta: pageMeta(page, limit, total),
    item: {
      _id: item._id,
      inventoryCode: item.inventoryCode,
      itemName: item.itemName,
      itemType: item.itemType,
      unit: item.unit,
      currentStock: item.currentStock,
      status: deriveInventoryStatus(item),
      reorderLevel: item.reorderLevel,
      minimumStock: item.minimumStock,
      maximumStock: item.maximumStock,
      expiryDate: item.expiryDate ?? null,
    },
    openingBalance,
    closingBalance,
    totals: { totalIn, totalOut, movements: allRows.length },
    reconciliation: {
      ledgerBalance: closingBalance,
      currentStock: item.currentStock,
      balanced: closingBalance === roundQuantity(item.currentStock),
    },
    data: ledger,
  };
};

/** GET /farms/:farmId/inventory/:id/audit-logs — change history of one stock item. */
const getInventoryAuditLogs = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  query: TPayload,
) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, InventoryPermissions.AUDIT, "view inventory history");

  const item = await findItem(access, id);
  const { page, limit, skip } = parsePaging(query, MAX_LIST_LIMIT, 20);

  //rows of the item itself plus the ledger rows written against it
  const transactionIds = await InventoryTransactionModel.find({
    farmId: access.farmObjectId,
    inventoryId: item._id,
  })
    .select("_id")
    .lean();

  const filter = {
    farmId: access.farmObjectId,
    $or: [
      { entityType: AuditEntityTypes.INVENTORY, entityId: item._id },
      {
        entityType: AuditEntityTypes.INVENTORY_TRANSACTION,
        entityId: { $in: transactionIds.map((row) => row._id) },
      },
    ],
  };

  const [total, data] = await Promise.all([
    AuditLogModel.countDocuments(filter),
    AuditLogModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      //never expose IP / user agent to farm users
      .select("logNo action event entityType oldData newData changedFields status createdAt userId")
      .populate("userId", "userId fullName")
      .lean(),
  ]);

  return { meta: pageMeta(page, limit, total), data };
};

/* -------------------------------------------------------------------------- */
/*                        Inventory — controlled update                       */
/* -------------------------------------------------------------------------- */

/**
 * PUT /farms/:farmId/inventory/:id (spec 19 §120–121).
 * Administrative metadata only. `currentStock` can never be written here — stock moves
 * exclusively through Inventory_Transaction — and `unit` / `itemType` / `referenceId`
 * are locked once the item has a ledger, so historical quantities keep their meaning.
 */
const updateInventoryItem = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  body: TPayload,
  context?: TAuditContext,
) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, InventoryPermissions.UPDATE, "update inventory items");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);
  rejectServerFields(body, SERVER_MANAGED_INVENTORY_FIELDS);

  const item = await findItem(access, id);

  //clear, specific errors instead of silently ignoring protected fields
  const locked = LOCKED_INVENTORY_FIELDS.filter((field) => field in body);
  if (locked.includes("currentStock")) {
    throw new AppError(
      status.BAD_REQUEST,
      "currentStock cannot be edited — record a Purchase, Consumption, Damage, Expired, Adjustment or Return transaction instead.",
    );
  }
  if (locked.length) {
    const movements = await InventoryTransactionModel.countDocuments({ inventoryId: item._id });
    if (movements > 0) {
      throw new AppError(
        status.CONFLICT,
        `${locked.join(", ")} cannot change: ${item.inventoryCode} already has ${movements} stock movement(s) recorded in that unit. Deactivate this item and register a new one instead.`,
      );
    }
    throw new AppError(
      status.BAD_REQUEST,
      `${locked.join(", ")} cannot be changed through this endpoint — it is part of the item's identity.`,
    );
  }

  //only the documented administrative fields may be sent (spec 19 §120 "Update")
  const allowed = [...UPDATABLE_INVENTORY_FIELDS, "averagePurchasePrice", "reason"];
  const unknownFields = Object.keys(body).filter((field) => !allowed.includes(field));
  if (unknownFields.length) {
    throw new AppError(
      status.BAD_REQUEST,
      `${unknownFields.join(", ")} cannot be updated here. Updatable fields: ${allowed.join(", ")}.`,
    );
  }

  const update: Record<string, unknown> = {};
  const oldData: Record<string, unknown> = {};
  const changedFields: string[] = [];

  const setIfChanged = (field: string, next: unknown) => {
    const current = (item as unknown as Record<string, unknown>)[field] ?? null;
    const normalizedCurrent = current instanceof Date ? current.getTime() : current;
    const normalizedNext = next instanceof Date ? next.getTime() : (next ?? null);
    if (normalizedCurrent === normalizedNext) return;
    update[field] = next;
    oldData[field] = current;
    changedFields.push(field);
  };

  if ("itemName" in body) {
    const itemName = parseText("itemName", body.itemName, MAX_ITEM_NAME);
    if (!itemName) throw new AppError(status.BAD_REQUEST, "itemName cannot be empty!");
    setIfChanged("itemName", itemName);
  }
  if ("category" in body) setIfChanged("category", parseText("category", body.category, MAX_CATEGORY) ?? null);
  if ("supplierName" in body) {
    setIfChanged("supplierName", parseText("supplierName", body.supplierName, MAX_SUPPLIER_NAME) ?? null);
  }
  if ("storageLocation" in body) {
    setIfChanged("storageLocation", parseText("storageLocation", body.storageLocation, MAX_STORAGE_LOCATION) ?? null);
  }
  if ("remarks" in body) setIfChanged("remarks", parseText("remarks", body.remarks) ?? null);
  if ("expiryDate" in body) setIfChanged("expiryDate", parseExpiryDate(body.expiryDate));

  //thresholds: validate the new ladder as a whole, not field by field
  const nextThreshold = (field: "minimumStock" | "maximumStock" | "reorderLevel") =>
    field in body ? parseQuantity(field, body[field], { allowZero: true }) : item[field];
  if ("minimumStock" in body || "maximumStock" in body || "reorderLevel" in body) {
    const minimumStock = nextThreshold("minimumStock");
    const maximumStock = nextThreshold("maximumStock");
    const reorderLevel = nextThreshold("reorderLevel");
    if (maximumStock > 0 && minimumStock > maximumStock) {
      throw new AppError(status.BAD_REQUEST, "minimumStock cannot be greater than maximumStock!");
    }
    if (maximumStock > 0 && reorderLevel > maximumStock) {
      throw new AppError(status.BAD_REQUEST, "reorderLevel cannot be greater than maximumStock!");
    }
    if (reorderLevel > 0 && minimumStock > reorderLevel) {
      throw new AppError(status.BAD_REQUEST, "minimumStock cannot be greater than reorderLevel!");
    }
    setIfChanged("minimumStock", minimumStock);
    setIfChanged("maximumStock", maximumStock);
    setIfChanged("reorderLevel", reorderLevel);
  }

  //manual average-price correction is an owner decision and needs a reason (spec 19 §34)
  if ("averagePurchasePrice" in body) {
    requireRole(access, InventoryPermissions.PRICE_CORRECTION, "correct the average purchase price");
    requireReason("reason", body.reason, "correct the average purchase price");
    setIfChanged("averagePurchasePrice", parseMoney("averagePurchasePrice", body.averagePurchasePrice));
  }
  //why the change was made: optional for ordinary metadata edits, audited when sent
  const reason = parseText("reason", body.reason, MAX_SHORT_TEXT);

  if (!changedFields.length) {
    return { mode: "unchanged" as const, item: withDerived(item) };
  }

  //thresholds / expiry move the operational status, so recompute it in the same write
  const nextStatus = deriveInventoryStatus(
    {
      currentStock: item.currentStock,
      minimumStock: (update.minimumStock as number | undefined) ?? item.minimumStock,
      reorderLevel: (update.reorderLevel as number | undefined) ?? item.reorderLevel,
      expiryDate: "expiryDate" in update ? (update.expiryDate as Date | null) : (item.expiryDate ?? null),
      status: item.status,
    },
  );
  if (nextStatus !== item.status) {
    update.status = nextStatus;
    oldData.status = item.status;
    changedFields.push("status");
  }

  const updated = await InventoryModel.findOneAndUpdate(
    { _id: item._id, farmId: access.farmObjectId },
    { ...update, updatedBy: memberId },
    { new: true, runValidators: true },
  ).lean();
  if (!updated) throw new AppError(status.NOT_FOUND, "Inventory item not found!");

  await audit(
    context,
    access.farmObjectId,
    item._id,
    AuditEntityTypes.INVENTORY,
    AuditActions.UPDATE,
    "Inventory Item Updated",
    oldData,
    { ...update, ...(reason ? { reason } : {}) },
    changedFields,
  );

  await NotificationProducers.stockChanged(access.farmObjectId, { _id: item._id });
  return { mode: "updated" as const, changedFields, item: withDerived(updated as TInventoryDoc) };
};

/**
 * PATCH /farms/:farmId/inventory/:id/toggle-active (spec 19 §48, §112).
 * Inactive blocks new stock movements while every historical Inventory_Transaction
 * stays readable, so discontinued items are archived instead of deleted.
 */
const toggleInventoryActive = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  body: TPayload,
  context?: TAuditContext,
) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, InventoryPermissions.TOGGLE_ACTIVE, "activate or deactivate inventory items");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);

  const item = await findItem(access, id);
  const wasInactive = item.status === InventoryStatuses.INACTIVE;
  //explicit `active` wins; otherwise this is a toggle
  const nextActive = isBlank(body.active) ? wasInactive : body.active === true || body.active === "true";

  if (nextActive === !wasInactive) {
    return {
      mode: "unchanged" as const,
      item: withDerived(item),
      message: `${item.inventoryCode} is already ${wasInactive ? "Inactive" : "active"}.`,
    };
  }

  const reason = nextActive
    ? parseText("reason", body.reason, MAX_SHORT_TEXT)
    : requireReason("reason", body.reason, "deactivate a stock item");

  //reactivating re-derives the real status from stock, thresholds and expiry
  const nextStatus = nextActive
    ? deriveInventoryStatus({ ...item, status: InventoryStatuses.AVAILABLE })
    : InventoryStatuses.INACTIVE;

  const updated = await InventoryModel.findOneAndUpdate(
    { _id: item._id, farmId: access.farmObjectId },
    { status: nextStatus, updatedBy: memberId },
    { new: true },
  ).lean();
  if (!updated) throw new AppError(status.NOT_FOUND, "Inventory item not found!");

  await audit(
    context,
    access.farmObjectId,
    item._id,
    AuditEntityTypes.INVENTORY,
    nextActive ? AuditActions.UPDATE : AuditActions.ARCHIVE,
    nextActive ? "Inventory Item Reactivated" : "Inventory Item Deactivated",
    { status: item.status },
    { status: nextStatus, ...(reason ? { reason } : {}) },
    ["status"],
  );

  await NotificationProducers.stockChanged(access.farmObjectId, { _id: item._id });

  return {
    mode: nextActive ? ("activated" as const) : ("deactivated" as const),
    item: withDerived(updated as TInventoryDoc),
    message: nextActive
      ? `${item.inventoryCode} is active again (status ${nextStatus}).`
      : `${item.inventoryCode} is now Inactive — its stock history stays readable but no new movement can be recorded.`,
  };
};

/**
 * POST /farms/:farmId/inventory/sync-statuses — refresh the stored `status` of every
 * item from stock, thresholds and expiry. The daily `inventory.sync` job does the same;
 * reads already derive the right value, and this makes the stored one agree.
 */
const syncInventoryStatuses = async (
  farmId: string,
  requesterUserId: string,
  context?: TAuditContext,
) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, InventoryPermissions.SYNC_STATUS, "refresh inventory statuses");
  requireWritableFarm(access);
  return refreshStatuses(access.farmObjectId, context);
};

/** Stored statuses + stock notifications of one farm. No access check: the route and the job call it. */
const refreshStatuses = async (farmObjectId: Types.ObjectId, context?: TAuditContext) => {
  const rows = await InventoryModel.find({ farmId: farmObjectId })
    .select("inventoryCode itemName currentStock minimumStock reorderLevel expiryDate status")
    .lean();

  const now = new Date();
  const changes: { inventoryCode: string; itemName: string; from: string; to: string }[] = [];
  for (const row of rows) {
    const next = deriveInventoryStatus(row, now);
    if (next === row.status) continue;
    await InventoryModel.updateOne({ _id: row._id }, { status: next });
    changes.push({ inventoryCode: row.inventoryCode, itemName: row.itemName, from: row.status, to: next });
  }

  if (changes.length) {
    await audit(
      context,
      farmObjectId,
      farmObjectId,
      AuditEntityTypes.INVENTORY,
      AuditActions.UPDATE,
      "Inventory Statuses Refreshed",
      null,
      { changed: changes.length, changes: changes.slice(0, 50) },
      ["status"],
    );
  }

  await NotificationProducers.sweepFarmStock(farmObjectId);
  return { checked: rows.length, changed: changes.length, changes };
};

/**
 * DELETE /farms/:farmId/inventory/:id (spec 19 §120 "Delete", §139).
 * Default: archival — the item becomes Inactive and its ledger stays intact.
 * `?hard=true` really deletes, and only when the item has no Inventory_Transaction
 * history and no stock on hand; otherwise it is refused with 409.
 */
const deleteInventoryItem = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  query: TPayload,
  body: TPayload,
  context?: TAuditContext,
) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, InventoryPermissions.DELETE, "delete inventory items");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);

  const item = await findItem(access, id);
  const hard = parseBoolean(query.hard);
  const movements = await InventoryTransactionModel.countDocuments({ inventoryId: item._id });

  if (hard) {
    if (movements > 0) {
      throw new AppError(
        status.CONFLICT,
        `${item.inventoryCode} has ${movements} stock movement(s) and cannot be deleted — deleting it would destroy the history behind past stock balances. Deactivate it instead (DELETE without ?hard=true, or PATCH /toggle-active).`,
      );
    }
    if (item.currentStock > 0) {
      throw new AppError(
        status.CONFLICT,
        `${item.inventoryCode} still holds ${item.currentStock} ${item.unit} of stock — write it off with a Damage / Expired / Adjustment transaction before deleting it.`,
      );
    }
    await InventoryModel.deleteOne({ _id: item._id, farmId: access.farmObjectId });
    await audit(
      context,
      access.farmObjectId,
      item._id,
      AuditEntityTypes.INVENTORY,
      AuditActions.DELETE,
      "Inventory Item Deleted",
      { inventoryCode: item.inventoryCode, itemName: item.itemName, itemType: item.itemType },
      null,
    );
    await NotificationProducers.itemDeleted(access.farmObjectId, item._id);
    return {
      mode: "deleted" as const,
      inventoryCode: item.inventoryCode,
      message: `${item.inventoryCode} was deleted — it had no stock and no transaction history.`,
    };
  }

  if (item.status === InventoryStatuses.INACTIVE) {
    return {
      mode: "unchanged" as const,
      item: withDerived(item),
      message: `${item.inventoryCode} is already archived (Inactive).`,
    };
  }

  const reason = parseText("reason", body.reason, MAX_SHORT_TEXT);
  const updated = await InventoryModel.findOneAndUpdate(
    { _id: item._id, farmId: access.farmObjectId },
    { status: InventoryStatuses.INACTIVE, updatedBy: memberId },
    { new: true },
  ).lean();

  await audit(
    context,
    access.farmObjectId,
    item._id,
    AuditEntityTypes.INVENTORY,
    AuditActions.ARCHIVE,
    "Inventory Item Archived",
    { status: item.status },
    { status: InventoryStatuses.INACTIVE, ...(reason ? { reason } : {}) },
    ["status"],
  );

  await NotificationProducers.stockChanged(access.farmObjectId, { _id: item._id });

  return {
    mode: "deactivated" as const,
    item: withDerived(updated as TInventoryDoc),
    movements,
    message: `${item.inventoryCode} was archived as Inactive${movements ? ` — its ${movements} stock movement(s) stay readable` : ""}.`,
  };
};

/* -------------------------------------------------------------------------- */
/*                 Inventory_Transaction — record a movement                  */
/* -------------------------------------------------------------------------- */

type TResolvedMovement = {
  transactionType: TInventoryTransactionType;
  direction: TStockDirection;
  quantity: number;
  delta: number;
};

/**
 * Resolves what a request actually does to stock (spec 20 §115–118):
 * `quantity` always stays positive and the direction comes from the transactionType,
 * except for Adjustment / Return where the caller states it (or, for Adjustment, sends
 * a `physicalCount` and the service derives both from the difference).
 */
const resolveMovement = (
  transactionType: TInventoryTransactionType,
  body: TPayload,
  item: TInventoryDoc,
): TResolvedMovement => {
  const needsDirection = (DIRECTIONAL_TRANSACTION_TYPES as readonly string[]).includes(transactionType);

  //stock reconciliation shortcut (spec 19 §68): send the counted stock, not a delta
  if (transactionType === InventoryTransactionTypes.ADJUSTMENT && !isBlank(body.physicalCount)) {
    const counted = parseQuantity("physicalCount", body.physicalCount, { allowZero: true });
    const difference = roundQuantity(counted - item.currentStock);
    if (difference === 0) {
      throw new AppError(
        status.BAD_REQUEST,
        `physicalCount matches the system stock (${item.currentStock} ${item.unit}) — there is nothing to adjust.`,
      );
    }
    return {
      transactionType,
      direction: difference > 0 ? StockDirections.IN : StockDirections.OUT,
      quantity: Math.abs(difference),
      delta: difference,
    };
  }

  const quantity = parseQuantity("quantity", body.quantity);
  let direction: TStockDirection;
  if (needsDirection) {
    if (isBlank(body.direction)) {
      if (transactionType === InventoryTransactionTypes.ADJUSTMENT) {
        throw new AppError(
          status.BAD_REQUEST,
          'An Adjustment needs a direction: send direction: "In" (system stock was too low) or "Out" (too high), or send physicalCount and let the server work it out.',
        );
      }
      //Return defaults to stock coming back in, the convention the feed / health
      //workflows already use when they undo a consumption
      direction = StockDirections.IN;
    } else {
      direction = parseEnum("direction", body.direction, DIRECTIONS) as TStockDirection;
    }
  } else {
    direction = resolveDirection(transactionType);
    if (!isBlank(body.direction) && body.direction !== direction) {
      throw new AppError(
        status.BAD_REQUEST,
        `A ${transactionType} transaction is always ${direction === StockDirections.IN ? "an inflow (In)" : "an outflow (Out)"} — direction cannot be overridden.`,
      );
    }
  }

  return {
    transactionType,
    direction,
    quantity,
    delta: direction === StockDirections.IN ? quantity : -quantity,
  };
};

/** Shared guardrails before any stock movement (spec 19 §112–113, spec 20 §90, §133). */
const assertMovementAllowed = (item: TInventoryDoc, movement: TResolvedMovement) => {
  const derived = deriveInventoryStatus(item);

  if (derived === InventoryStatuses.INACTIVE) {
    throw new AppError(
      status.UNPROCESSABLE_ENTITY,
      `${item.inventoryCode} (${item.itemName}) is Inactive — reactivate it before recording stock movements.`,
    );
  }

  if (derived === InventoryStatuses.EXPIRED) {
    //an expired row may only be written off or corrected, never consumed or restocked
    const disposalTypes: string[] = [InventoryTransactionTypes.EXPIRED, InventoryTransactionTypes.ADJUSTMENT];
    if (!disposalTypes.includes(movement.transactionType)) {
      throw new AppError(
        status.UNPROCESSABLE_ENTITY,
        `${item.inventoryCode} (${item.itemName}) expired on ${new Date(item.expiryDate as Date).toISOString().slice(0, 10)} — only an Expired write-off or an Adjustment is allowed. Update the expiry date first if new stock arrived.`,
      );
    }
    if (movement.direction === StockDirections.IN) {
      throw new AppError(
        status.UNPROCESSABLE_ENTITY,
        `${item.inventoryCode} is Expired — stock cannot be added to it. Update its expiryDate, or register the new batch as a separate item.`,
      );
    }
  }

  if (movement.direction === StockDirections.OUT && item.currentStock < movement.quantity) {
    throw new AppError(
      status.UNPROCESSABLE_ENTITY,
      `Insufficient stock: ${item.inventoryCode} has ${item.currentStock} ${item.unit} on hand, ${movement.quantity} ${item.unit} requested.`,
    );
  }
};

/**
 * POST /farms/:farmId/inventory-transactions (spec 20 §56–63).
 * The single door through which a farm user changes stock:
 *  - type-level role check (workers consume, managers purchase / adjust / write off)
 *  - unit must match the item's unit, quantity > 0, Purchase needs a price
 *  - the stock update and the ledger row are one atomic unit of work, and the update
 *    is conditional (`currentStock >= quantity`) so concurrent workers cannot oversell
 *  - a Purchase re-derives `averagePurchasePrice` with the weighted-average formula
 *  - the item's status is recomputed and a crossing of the reorder line is reported
 */
const createTransaction = async (
  farmId: string,
  requesterUserId: string,
  body: TPayload,
  context?: TAuditContext,
  afterTransaction?: TAfterTransaction,
) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, InventoryPermissions.TRANSACTION_READ, "record stock movements");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);
  rejectServerFields(body, SERVER_MANAGED_TRANSACTION_FIELDS);

  const transactionType = parseEnum("transactionType", body.transactionType, TRANSACTION_TYPES) as TInventoryTransactionType;

  //usage rows must come from the clinical / feeding workflow that caused them
  if ((WORKFLOW_ONLY_TRANSACTION_TYPES as readonly string[]).includes(transactionType)) {
    throw new AppError(
      status.BAD_REQUEST,
      `${transactionType} rows are written by the ${transactionType === InventoryTransactionTypes.TREATMENT_USAGE ? "treatment" : "vaccination"} workflow so they always point at a real record — record it there instead.`,
    );
  }
  const allowedRoles = TRANSACTION_TYPE_PERMISSIONS[transactionType] ?? [];
  requireRole(access, allowedRoles, `record a ${transactionType} transaction`);

  if (isBlank(body.inventoryId)) throw new AppError(status.BAD_REQUEST, "inventoryId is required!");
  const item = await findItem(access, String(body.inventoryId));

  //unit consistency (spec 20 §37): no silent conversion between kg and liter
  if (!isBlank(body.unit)) {
    const unit = parseEnum("unit", body.unit, UNITS);
    if (unit !== item.unit) {
      throw new AppError(
        status.BAD_REQUEST,
        `unit must be ${item.unit} — ${item.inventoryCode} is stocked in ${item.unit} and the system never converts units automatically.`,
      );
    }
  }

  const movement = resolveMovement(transactionType, body, item);
  assertMovementAllowed(item, movement);

  const transactionDate = parseTransactionDate(body.transactionDate);
  const supplierName = parseText("supplierName", body.supplierName, MAX_SUPPLIER_NAME) ?? undefined;
  const remarks = parseText("remarks", body.remarks);

  //Damage / Expired / Adjustment always need an explanation (spec 19 §67, spec 20 §24)
  const explanationRequired: string[] = [
    InventoryTransactionTypes.DAMAGE,
    InventoryTransactionTypes.EXPIRED,
    InventoryTransactionTypes.ADJUSTMENT,
  ];
  if (explanationRequired.includes(transactionType) && !remarks) {
    throw new AppError(
      status.BAD_REQUEST,
      `remarks are required for a ${transactionType} transaction — record why the stock changed.`,
    );
  }

  //price: required for Purchase, computed total verified when the client sends one
  let unitPrice: number | null = null;
  let totalAmount: number | null = null;
  if (transactionType === InventoryTransactionTypes.PURCHASE) {
    if (isBlank(body.unitPrice)) {
      throw new AppError(status.BAD_REQUEST, "unitPrice is required for a Purchase transaction!");
    }
    unitPrice = parseMoney("unitPrice", body.unitPrice);
    totalAmount = roundMoney(movement.quantity * unitPrice);
    if (!isBlank(body.totalAmount)) {
      const sent = parseMoney("totalAmount", body.totalAmount, MAX_TOTAL_AMOUNT);
      if (Math.abs(sent - totalAmount) > TOTAL_AMOUNT_TOLERANCE) {
        throw new AppError(
          status.BAD_REQUEST,
          `totalAmount ${sent} does not match quantity × unitPrice (${movement.quantity} × ${unitPrice} = ${totalAmount}).`,
        );
      }
      totalAmount = sent;
    }
  } else if (!isBlank(body.unitPrice)) {
    //other types may carry a value for reporting (e.g. the cost of damaged stock)
    unitPrice = parseMoney("unitPrice", body.unitPrice);
    totalAmount = roundMoney(movement.quantity * unitPrice);
  }

  //reference: manual rows may only point at Manual / Purchase / Expense
  const referenceType = isBlank(body.referenceType)
    ? transactionType === InventoryTransactionTypes.PURCHASE
      ? InventoryReferenceTypes.PURCHASE
      : InventoryReferenceTypes.MANUAL
    : (parseEnum("referenceType", body.referenceType, MANUAL_REFERENCE_TYPES as unknown as string[]) as TInventoryReferenceType);
  let referenceId: Types.ObjectId | null = null;
  if (!isBlank(body.referenceId)) {
    if (referenceType !== InventoryReferenceTypes.EXPENSE) {
      throw new AppError(
        status.BAD_REQUEST,
        `referenceId is only accepted with referenceType "Expense" — ${referenceType} rows have no source document.`,
      );
    }
    if (!isValidObjectId(String(body.referenceId))) {
      throw new AppError(status.BAD_REQUEST, "referenceId must be a valid id!");
    }
    referenceId = new Types.ObjectId(String(body.referenceId));
    if (!(await ExpenseModel.exists({ _id: referenceId, farmId: access.farmObjectId }))) {
      throw new AppError(status.NOT_FOUND, "Expense not found in this farm!");
    }
  }

  const statusBefore = deriveInventoryStatus(item);
  const warnings: string[] = [];
  //overstock is a warning, not a block — farm policy decides (spec 19 §31)
  const projected = roundQuantity(item.currentStock + movement.delta);
  if (item.maximumStock > 0 && projected > item.maximumStock) {
    warnings.push(
      `This brings ${item.inventoryCode} to ${projected} ${item.unit}, above its maximum stock of ${item.maximumStock} ${item.unit}.`,
    );
  }

  const result = await executeAtomically(async (session, undo) => {
    //one conditional pipeline update: concurrent workers can never oversell stock
    const change = await applyStockChange(item._id, movement.delta, {
      session,
      updatedBy: memberId,
      //an Expired write-off is the authorized exception to the unusable-row guard
      allowUnusable: transactionType === InventoryTransactionTypes.EXPIRED || transactionType === InventoryTransactionTypes.ADJUSTMENT,
    });
    if (!change) {
      throw new AppError(
        status.CONFLICT,
        `Stock of ${item.itemName} changed while saving and is no longer sufficient. Reload the item and try again.`,
      );
    }
    const applied = change.applied;
    undo.push(() => applyStockChange(item._id, -movement.delta, { session: null, capAtZero: true, allowUnusable: true }));

    const transactionNo = await generateTransactionNo();
    const [trx] = await InventoryTransactionModel.create(
      [
        {
          transactionNo,
          farmId: access.farmObjectId,
          inventoryId: item._id,
          transactionType,
          transactionDate,
          quantity: applied,
          direction: movement.direction,
          unit: item.unit,
          ...(unitPrice !== null ? { unitPrice } : {}),
          ...(totalAmount !== null ? { totalAmount } : {}),
          referenceType,
          referenceId,
          ...(supplierName ? { supplierName } : {}),
          ...(remarks ? { remarks } : {}),
          performedBy: memberId,
        },
      ],
      sessionOpts(session),
    );
    if (!trx) throw new AppError(status.INTERNAL_SERVER_ERROR, "Stock transaction could not be recorded!");
    undo.push(() => InventoryTransactionModel.deleteOne({ _id: trx._id }));

    //weighted average purchase price + expiry-aware status, in the same unit of work
    const itemUpdate: Record<string, unknown> = {};
    if (transactionType === InventoryTransactionTypes.PURCHASE && unitPrice !== null) {
      itemUpdate.averagePurchasePrice = weightedAveragePrice(
        change.before,
        item.averagePurchasePrice ?? null,
        applied,
        unitPrice,
      );
    }
    //a purchase may also come with a fresh expiry date for the restocked item
    if (!isBlank(body.expiryDate) && movement.direction === StockDirections.IN) {
      itemUpdate.expiryDate = parseExpiryDate(body.expiryDate);
    }
    const nextStatus = deriveInventoryStatus({
      currentStock: change.after,
      minimumStock: item.minimumStock,
      reorderLevel: item.reorderLevel,
      expiryDate: (itemUpdate.expiryDate as Date | null | undefined) ?? item.expiryDate ?? null,
      status: item.status,
    });
    if (nextStatus !== item.status) itemUpdate.status = nextStatus;

    if (Object.keys(itemUpdate).length) {
      const previous = {
        averagePurchasePrice: item.averagePurchasePrice ?? null,
        expiryDate: item.expiryDate ?? null,
        status: item.status,
      };
      await InventoryModel.updateOne({ _id: item._id }, itemUpdate, sessionOpts(session));
      undo.push(() => InventoryModel.updateOne({ _id: item._id }, previous));
    }

    if (afterTransaction) await afterTransaction(trx.toObject() as TInventoryTransactionDoc, session, undo);

    return {
      transaction: trx.toObject() as TInventoryTransactionDoc,
      stockBefore: change.before,
      stockAfter: change.after,
      applied,
      nextStatus,
    };
  }, {
    trace: traceOf(context, access.farmObjectId, null, AuditActions.CREATE, `Stock Movement — ${transactionType}`),
    log: async (result) => {
      await audit(
        context,
        access.farmObjectId,
        result.transaction._id,
        AuditEntityTypes.INVENTORY_TRANSACTION,
        AuditActions.CREATE,
        `Stock ${movement.direction === StockDirections.IN ? "Increased" : "Decreased"} — ${transactionType}`,
        { currentStock: result.stockBefore, status: statusBefore },
        {
          transactionNo: result.transaction.transactionNo,
          inventoryCode: item.inventoryCode,
          transactionType,
          direction: movement.direction,
          quantity: result.applied,
          unit: item.unit,
          ...(unitPrice !== null ? { unitPrice, totalAmount } : {}),
          currentStock: result.stockAfter,
          status: result.nextStatus,
          ...(remarks ? { remarks } : {}),
        },
        ["currentStock", "status"],
      );
    },
  });

  await NotificationProducers.stockChanged(access.farmObjectId, { _id: item._id });
  const alert = stockAlertFor(statusBefore, result.nextStatus, {
    itemName: item.itemName,
    inventoryCode: item.inventoryCode,
    currentStock: result.stockAfter,
    unit: item.unit,
  });

  return {
    transaction: {
      ...result.transaction,
      delta: movement.delta,
      direction: movement.direction,
    },
    item: {
      _id: item._id,
      inventoryCode: item.inventoryCode,
      itemName: item.itemName,
      unit: item.unit,
      stockBefore: result.stockBefore,
      currentStock: result.stockAfter,
      status: result.nextStatus,
      reorderLevel: item.reorderLevel,
      minimumStock: item.minimumStock,
    },
    alert,
    warnings,
  };
};

/* -------------------------------------------------------------------------- */
/*                 Inventory_Transaction — list / detail / summary            */
/* -------------------------------------------------------------------------- */

/**
 * GET /farms/:farmId/inventory-transactions (spec 20 §156).
 * Farm-wide stock movements, filtered by inventoryId, transactionType, referenceType,
 * performedBy, supplierName, direction and a transactionDate range.
 */
const getFarmTransactions = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, InventoryPermissions.TRANSACTION_READ, "view stock movements");

  const { page, limit, skip } = parsePaging(query, MAX_LIST_LIMIT, 10);
  const filter: Record<string, unknown> = { farmId: access.farmObjectId };

  if (!isBlank(query.inventoryId)) {
    const item = await findItem(access, String(query.inventoryId));
    filter.inventoryId = item._id;
  }
  if (!isBlank(query.transactionType)) {
    filter.transactionType = { $in: parseEnumList("transactionType", query.transactionType, TRANSACTION_TYPES) };
  }
  if (!isBlank(query.referenceType)) {
    filter.referenceType = { $in: parseEnumList("referenceType", query.referenceType, REFERENCE_TYPES) };
  }
  if (!isBlank(query.supplierName)) {
    filter.supplierName = new RegExp(escapeRegex(String(query.supplierName).trim()), "i");
  }
  if (!isBlank(query.performedBy)) {
    if (!isValidObjectId(String(query.performedBy))) {
      throw new AppError(status.BAD_REQUEST, "performedBy must be a valid farm member id!");
    }
    filter.performedBy = new Types.ObjectId(String(query.performedBy));
  }
  if (!isBlank(query.from) || !isBlank(query.to)) {
    Object.assign(filter, parseDateRange(query, "transactionDate"));
  }
  //searchTerm: transactionNo / supplier / remarks
  const searchTerm = typeof query.searchTerm === "string" ? query.searchTerm.trim() : "";
  if (searchTerm) {
    const rx = new RegExp(escapeRegex(searchTerm), "i");
    filter.$or = [{ transactionNo: rx }, { supplierName: rx }, { remarks: rx }];
  }

  const sortRaw = typeof query.sort === "string" && query.sort.trim() ? query.sort.trim() : "-transactionDate";
  const descending = sortRaw.startsWith("-");
  const sortField = descending ? sortRaw.slice(1) : sortRaw;
  if (!(TRANSACTION_SORT_FIELDS as readonly string[]).includes(sortField)) {
    throw new AppError(
      status.BAD_REQUEST,
      `sort must be one of: ${TRANSACTION_SORT_FIELDS.join(", ")} (prefix with - for descending)!`,
    );
  }

  const [total, rows] = await Promise.all([
    InventoryTransactionModel.countDocuments(filter),
    InventoryTransactionModel.find(filter)
      .sort({ [sortField]: descending ? -1 : 1, createdAt: descending ? -1 : 1 })
      .skip(skip)
      .limit(limit)
      .select("-__v")
      .populate("inventoryId", "inventoryCode itemName itemType unit currentStock")
      .populate({ path: "performedBy", ...MEMBER_POPULATE })
      .lean(),
  ]);

  //direction filter is applied after the derive step (legacy rows store no direction)
  const directionFilter = isBlank(query.direction)
    ? null
    : (parseEnum("direction", query.direction, DIRECTIONS) as TStockDirection);
  const data = rows
    .map((row) => ({
      ...row,
      direction: resolveDirection(row.transactionType, row.direction ?? null),
      delta: signedDelta(row),
    }))
    .filter((row) => !directionFilter || row.direction === directionFilter);

  return { meta: pageMeta(page, limit, total), data };
};

/** GET /farms/:farmId/inventory-transactions/:id — one movement, fully populated. */
const getTransaction = async (farmId: string, id: string, requesterUserId: string) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, InventoryPermissions.TRANSACTION_READ, "view stock movements");

  const doc = await findTransaction(access, id);
  const populated = await InventoryTransactionModel.findById(doc._id)
    .select("-__v")
    .populate("inventoryId", "inventoryCode itemName itemType category unit currentStock status reorderLevel minimumStock maximumStock expiryDate storageLocation averagePurchasePrice")
    .populate({ path: "performedBy", ...MEMBER_POPULATE })
    .lean();
  if (!populated) throw new AppError(status.NOT_FOUND, "Inventory transaction not found!");

  //has this row already been reversed? (a reversal points back at it)
  const reversal = await InventoryTransactionModel.findOne({
    farmId: access.farmObjectId,
    referenceType: InventoryReferenceTypes.MANUAL,
    referenceId: doc._id,
  })
    .select("transactionNo transactionType transactionDate quantity direction remarks")
    .lean();

  //balance of the item right after this movement, for the ledger drill-down
  const upTo = await InventoryTransactionModel.find({
    farmId: access.farmObjectId,
    inventoryId: doc.inventoryId,
    $or: [
      { transactionDate: { $lt: doc.transactionDate } },
      { transactionDate: doc.transactionDate, createdAt: { $lte: doc.createdAt } },
    ],
  })
    .select("transactionType quantity direction")
    .lean();

  return {
    ...populated,
    direction: resolveDirection(doc.transactionType, doc.direction ?? null),
    delta: signedDelta(doc),
    balanceAfter: roundQuantity(upTo.reduce((sum, row) => sum + signedDelta(row), 0)),
    reversal,
    reversible:
      !reversal && !(WORKFLOW_ONLY_TRANSACTION_TYPES as readonly string[]).includes(doc.transactionType),
  };
};

/**
 * GET /farms/:farmId/inventory-transactions/summary (spec 20 §158).
 * Inflow vs outflow, purchase spend, wastage (Damage + Expired) and usage breakdowns
 * over a date range, grouped by type, reference type and item.
 */
const getTransactionSummary = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, InventoryPermissions.TRANSACTION_READ, "view stock movement summaries");

  const now = new Date();
  //default window: the last 30 days
  const range = isBlank(query.from) && isBlank(query.to)
    ? { transactionDate: { $gte: new Date(now.getTime() - 30 * DAY_MS), $lte: now } }
    : parseDateRange(query, "transactionDate");

  const match: Record<string, unknown> = { farmId: access.farmObjectId, ...range };
  if (!isBlank(query.inventoryId)) {
    const item = await findItem(access, String(query.inventoryId));
    match.inventoryId = item._id;
  }
  if (!isBlank(query.itemType)) {
    const types = parseEnumList("itemType", query.itemType, ITEM_TYPES) as TInventoryItemType[];
    const items = await InventoryModel.find({ farmId: access.farmObjectId, itemType: { $in: types } })
      .select("_id")
      .lean();
    match.inventoryId = { $in: items.map((row) => row._id) };
  }

  const [result] = await InventoryTransactionModel.aggregate([
    { $match: match },
    {
      $addFields: {
        //same direction rule as resolveDirection(): stored value first, then the type map
        resolvedDirection: {
          $cond: [
            { $in: ["$direction", [StockDirections.IN, StockDirections.OUT]] },
            "$direction",
            {
              $cond: [
                {
                  $in: [
                    "$transactionType",
                    [InventoryTransactionTypes.PURCHASE, InventoryTransactionTypes.RETURN],
                  ],
                },
                StockDirections.IN,
                StockDirections.OUT,
              ],
            },
          ],
        },
      },
    },
    {
      $facet: {
        byType: [
          {
            $group: {
              _id: "$transactionType",
              movements: { $sum: 1 },
              quantity: { $sum: "$quantity" },
              amount: { $sum: { $ifNull: ["$totalAmount", 0] } },
            },
          },
          { $sort: { quantity: -1 } },
        ],
        byDirection: [
          {
            $group: {
              _id: "$resolvedDirection",
              movements: { $sum: 1 },
              quantity: { $sum: "$quantity" },
              amount: { $sum: { $ifNull: ["$totalAmount", 0] } },
            },
          },
        ],
        byReferenceType: [
          {
            $group: {
              _id: { $ifNull: ["$referenceType", InventoryReferenceTypes.MANUAL] },
              movements: { $sum: 1 },
              quantity: { $sum: "$quantity" },
            },
          },
          { $sort: { quantity: -1 } },
        ],
        bySupplier: [
          { $match: { transactionType: InventoryTransactionTypes.PURCHASE, supplierName: { $nin: [null, ""] } } },
          {
            $group: {
              _id: "$supplierName",
              purchases: { $sum: 1 },
              quantity: { $sum: "$quantity" },
              spend: { $sum: { $ifNull: ["$totalAmount", 0] } },
            },
          },
          { $sort: { spend: -1 } },
          { $limit: DASHBOARD_LIST_LIMIT },
        ],
        byItem: [
          {
            $group: {
              _id: "$inventoryId",
              movements: { $sum: 1 },
              inQuantity: {
                $sum: { $cond: [{ $eq: ["$resolvedDirection", StockDirections.IN] }, "$quantity", 0] },
              },
              outQuantity: {
                $sum: { $cond: [{ $eq: ["$resolvedDirection", StockDirections.OUT] }, "$quantity", 0] },
              },
              spend: {
                $sum: {
                  $cond: [
                    { $eq: ["$transactionType", InventoryTransactionTypes.PURCHASE] },
                    { $ifNull: ["$totalAmount", 0] },
                    0,
                  ],
                },
              },
            },
          },
          { $sort: { outQuantity: -1 } },
          { $limit: DASHBOARD_LIST_LIMIT },
          {
            $lookup: {
              from: "inventories",
              localField: "_id",
              foreignField: "_id",
              as: "item",
              pipeline: [{ $project: { inventoryCode: 1, itemName: 1, itemType: 1, unit: 1, currentStock: 1 } }],
            },
          },
          { $addFields: { item: { $first: "$item" } } },
        ],
        byMonth: [
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m", date: "$transactionDate" } },
              movements: { $sum: 1 },
              inQuantity: {
                $sum: { $cond: [{ $eq: ["$resolvedDirection", StockDirections.IN] }, "$quantity", 0] },
              },
              outQuantity: {
                $sum: { $cond: [{ $eq: ["$resolvedDirection", StockDirections.OUT] }, "$quantity", 0] },
              },
              spend: {
                $sum: {
                  $cond: [
                    { $eq: ["$transactionType", InventoryTransactionTypes.PURCHASE] },
                    { $ifNull: ["$totalAmount", 0] },
                    0,
                  ],
                },
              },
            },
          },
          { $sort: { _id: 1 } },
        ],
      },
    },
  ]);

  type TGroup = { _id: string; movements: number; quantity: number; amount?: number };
  const byType = (result?.byType ?? []) as TGroup[];
  const typeOf = (type: string) => byType.find((row) => row._id === type);
  const quantityOf = (type: string) => roundQuantity(typeOf(type)?.quantity ?? 0);
  const amountOf = (type: string) => roundMoney(typeOf(type)?.amount ?? 0);
  const byDirection = (result?.byDirection ?? []) as TGroup[];
  const directionOf = (direction: string) => byDirection.find((row) => row._id === direction);

  return {
    range: {
      from: (range as { transactionDate?: { $gte?: Date } }).transactionDate?.$gte ?? null,
      to: (range as { transactionDate?: { $lte?: Date } }).transactionDate?.$lte ?? null,
    },
    totals: {
      movements: byType.reduce((sum, row) => sum + row.movements, 0),
      stockIn: roundQuantity(directionOf(StockDirections.IN)?.quantity ?? 0),
      stockOut: roundQuantity(directionOf(StockDirections.OUT)?.quantity ?? 0),
      netChange: roundQuantity(
        (directionOf(StockDirections.IN)?.quantity ?? 0) - (directionOf(StockDirections.OUT)?.quantity ?? 0),
      ),
      purchaseQuantity: quantityOf(InventoryTransactionTypes.PURCHASE),
      purchaseSpend: amountOf(InventoryTransactionTypes.PURCHASE),
      consumptionQuantity: quantityOf(InventoryTransactionTypes.CONSUMPTION),
      feedUsage: quantityOf(InventoryTransactionTypes.CONSUMPTION),
      treatmentUsage: quantityOf(InventoryTransactionTypes.TREATMENT_USAGE),
      vaccinationUsage: quantityOf(InventoryTransactionTypes.VACCINATION_USAGE),
      damageQuantity: quantityOf(InventoryTransactionTypes.DAMAGE),
      expiredQuantity: quantityOf(InventoryTransactionTypes.EXPIRED),
      //wastage = stock lost rather than used (spec 20 §158)
      wastageQuantity: roundQuantity(
        WASTAGE_TYPES.reduce((sum, type) => sum + quantityOf(type), 0),
      ),
      wastageValue: roundMoney(WASTAGE_TYPES.reduce((sum, type) => sum + amountOf(type), 0)),
      adjustmentQuantity: quantityOf(InventoryTransactionTypes.ADJUSTMENT),
      returnQuantity: quantityOf(InventoryTransactionTypes.RETURN),
    },
    byType,
    byDirection,
    byReferenceType: result?.byReferenceType ?? [],
    bySupplier: result?.bySupplier ?? [],
    byItem: result?.byItem ?? [],
    byMonth: result?.byMonth ?? [],
  };
};

/* -------------------------------------------------------------------------- */
/*              Inventory_Transaction — compensating reversal                 */
/* -------------------------------------------------------------------------- */

/**
 * POST /farms/:farmId/inventory-transactions/:id/reverse (spec 20 §82, §121, §154).
 * The ledger is append-only, so a mistake is corrected by writing a new offsetting
 * movement — an Adjustment (or a Return when goods went back to the supplier) in the
 * opposite direction — that points at the original row. The original is never touched.
 */
const reverseTransaction = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  body: TPayload,
  context?: TAuditContext,
) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, InventoryPermissions.TRANSACTION_REVERSE, "reverse stock movements");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);

  const original = await findTransaction(access, id);
  const reason = requireReason("reason", body.reason, "reverse a stock transaction");

  //workflow rows are reversed by their own module, which also fixes the source record
  if ((WORKFLOW_ONLY_TRANSACTION_TYPES as readonly string[]).includes(original.transactionType)) {
    throw new AppError(
      status.CONFLICT,
      `${original.transactionNo} was written by the ${original.transactionType === InventoryTransactionTypes.TREATMENT_USAGE ? "treatment" : "vaccination"} workflow — correct it there so the clinical record and the stock stay consistent.`,
    );
  }
  if (original.referenceType === InventoryReferenceTypes.FEED_RECORD) {
    throw new AppError(
      status.CONFLICT,
      `${original.transactionNo} belongs to a feed record — correct or void that feed record instead, and the stock follows.`,
    );
  }

  //never reverse twice
  const existing = await InventoryTransactionModel.findOne({
    farmId: access.farmObjectId,
    referenceType: InventoryReferenceTypes.MANUAL,
    referenceId: original._id,
  })
    .select("transactionNo transactionDate")
    .lean();
  if (existing) {
    throw new AppError(
      status.CONFLICT,
      `${original.transactionNo} was already reversed by ${existing.transactionNo}. Record a new transaction if a further correction is needed.`,
    );
  }

  const item = await InventoryModel.findOne({ _id: original.inventoryId, farmId: access.farmObjectId }).lean();
  if (!item) throw new AppError(status.NOT_FOUND, "The stock item of this transaction no longer exists!");

  const originalDirection = resolveDirection(original.transactionType, original.direction ?? null);
  const direction = originalDirection === StockDirections.IN ? StockDirections.OUT : StockDirections.IN;
  const quantity = roundQuantity(original.quantity);
  const delta = direction === StockDirections.IN ? quantity : -quantity;

  //Adjustment by default; Return is the honest type when a purchase goes back
  const reversalType = isBlank(body.reversalType)
    ? original.transactionType === InventoryTransactionTypes.PURCHASE
      ? InventoryTransactionTypes.RETURN
      : InventoryTransactionTypes.ADJUSTMENT
    : (parseEnum("reversalType", body.reversalType, [
        InventoryTransactionTypes.ADJUSTMENT,
        InventoryTransactionTypes.RETURN,
      ]) as TInventoryTransactionType);

  if (item.status === InventoryStatuses.INACTIVE) {
    throw new AppError(
      status.UNPROCESSABLE_ENTITY,
      `${item.inventoryCode} is Inactive — reactivate it before reversing a transaction against it.`,
    );
  }
  if (direction === StockDirections.OUT && item.currentStock < quantity) {
    throw new AppError(
      status.UNPROCESSABLE_ENTITY,
      `Cannot reverse ${original.transactionNo}: it added ${quantity} ${item.unit}, but only ${item.currentStock} ${item.unit} is on hand now (it has already been used). Record the real movement instead of a reversal.`,
    );
  }

  const statusBefore = deriveInventoryStatus(item as TInventoryDoc);
  const transactionDate = parseTransactionDate(body.transactionDate);
  const remarks = `Reversal of ${original.transactionNo} (${original.transactionType}) — ${reason}`;

  const result = await executeAtomically(async (session, undo) => {
    const change = await applyStockChange(item._id, delta, {
      session,
      updatedBy: memberId,
      //a reversal must also work on an expired row that is being corrected
      allowUnusable: true,
    });
    if (!change) {
      throw new AppError(
        status.CONFLICT,
        `Stock of ${item.itemName} changed while saving the reversal. Reload and try again.`,
      );
    }
    undo.push(() => applyStockChange(item._id, -delta, { session: null, capAtZero: true, allowUnusable: true }));

    const transactionNo = await generateTransactionNo();
    const [trx] = await InventoryTransactionModel.create(
      [
        {
          transactionNo,
          farmId: access.farmObjectId,
          inventoryId: item._id,
          transactionType: reversalType,
          transactionDate,
          quantity,
          direction,
          unit: original.unit ?? item.unit,
          ...(original.unitPrice !== undefined ? { unitPrice: original.unitPrice } : {}),
          ...(original.totalAmount !== undefined ? { totalAmount: original.totalAmount } : {}),
          //points back at the reversed row, which is how a double reversal is detected
          referenceType: InventoryReferenceTypes.MANUAL,
          referenceId: original._id,
          ...(original.supplierName ? { supplierName: original.supplierName } : {}),
          remarks,
          performedBy: memberId,
        },
      ],
      sessionOpts(session),
    );
    if (!trx) throw new AppError(status.INTERNAL_SERVER_ERROR, "Reversal transaction could not be recorded!");
    undo.push(() => InventoryTransactionModel.deleteOne({ _id: trx._id }));

    const nextStatus = deriveInventoryStatus({
      currentStock: change.after,
      minimumStock: item.minimumStock,
      reorderLevel: item.reorderLevel,
      expiryDate: item.expiryDate ?? null,
      status: item.status,
    });
    if (nextStatus !== item.status) {
      await InventoryModel.updateOne({ _id: item._id }, { status: nextStatus }, sessionOpts(session));
      undo.push(() => InventoryModel.updateOne({ _id: item._id }, { status: item.status }));
    }

    return { transaction: trx.toObject() as TInventoryTransactionDoc, change, nextStatus };
  }, {
    trace: traceOf(context, access.farmObjectId, original._id, AuditActions.UPDATE, "Stock Transaction Reversed"),
    log: async (result) => {
      await audit(
        context,
        access.farmObjectId,
        result.transaction._id,
        AuditEntityTypes.INVENTORY_TRANSACTION,
        AuditActions.UPDATE,
        "Stock Transaction Reversed",
        {
          transactionNo: original.transactionNo,
          transactionType: original.transactionType,
          direction: originalDirection,
          quantity: original.quantity,
          currentStock: result.change.before,
          status: statusBefore,
        },
        {
          transactionNo: result.transaction.transactionNo,
          transactionType: reversalType,
          direction,
          quantity,
          currentStock: result.change.after,
          status: result.nextStatus,
          reason,
        },
        ["currentStock", "status"],
      );
    },
  });

  await NotificationProducers.stockChanged(access.farmObjectId, { _id: item._id });

  return {
    reversal: { ...result.transaction, delta, direction },
    original: {
      _id: original._id,
      transactionNo: original.transactionNo,
      transactionType: original.transactionType,
      direction: originalDirection,
      quantity: original.quantity,
      //the original row is untouched: the ledger keeps both entries
      mutated: false,
    },
    item: {
      _id: item._id,
      inventoryCode: item.inventoryCode,
      itemName: item.itemName,
      unit: item.unit,
      stockBefore: result.change.before,
      currentStock: result.change.after,
      status: result.nextStatus,
    },
    alert: stockAlertFor(statusBefore, result.nextStatus, {
      itemName: item.itemName,
      inventoryCode: item.inventoryCode,
      currentStock: result.change.after,
      unit: item.unit,
    }),
    //a Purchase reversal does not recompute averagePurchasePrice backwards
    note:
      original.transactionType === InventoryTransactionTypes.PURCHASE
        ? "averagePurchasePrice was left as it is — a weighted average cannot be un-mixed. Correct it with PUT /inventory/:id (Owner) if the reversed purchase skewed it."
        : null,
  };
};

/**
 * DELETE /farms/:farmId/inventory-transactions/:id — always refused (spec 20 §83, §121).
 * A committed stock movement is the explanation behind the current balance, so the
 * ledger is append-only: corrections go through the reversal endpoint.
 */
const deleteTransaction = async (farmId: string, id: string, requesterUserId: string) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, InventoryPermissions.TRANSACTION_DELETE, "delete stock movements");

  const doc = await findTransaction(access, id);
  throw new AppError(
    status.FORBIDDEN,
    `${doc.transactionNo} cannot be deleted. A committed stock movement is what explains the current balance (sum of inflows − outflows = currentStock), so the ledger is append-only — reverse it with POST /api/v1/farms/:farmId/inventory-transactions/${doc.transactionNo}/reverse instead.`,
  );
};

export const InventoryServices = {
  //Inventory
  createInventoryItem,
  getFarmInventory,
  getInventoryMeta,
  getInventoryLookup,
  getMasterOptions,
  getDashboardSummary,
  getInventoryAlerts,
  getInventoryItem,
  getInventoryLedger,
  getInventoryAuditLogs,
  updateInventoryItem,
  toggleInventoryActive,
  syncInventoryStatuses,
  refreshStatuses,
  deleteInventoryItem,
  //Inventory_Transaction
  createTransaction,
  getFarmTransactions,
  getTransaction,
  getTransactionSummary,
  reverseTransaction,
  deleteTransaction,
};
