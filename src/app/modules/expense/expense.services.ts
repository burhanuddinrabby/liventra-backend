import status from "http-status";
import { isValidObjectId, Types } from "mongoose";
import type { ClientSession } from "mongoose";
import AppError from "../../errors/AppError.js";
import { AuditActions, AuditEntityTypes } from "../auditLog/auditLog.constants.js";
import { withAuditSession } from "../auditLog/auditLog.utils.js";
import type { TAuditContext } from "../auditLog/auditLog.utils.js";
import { executeAtomically, isBlank, parseBoolean, parseEnum } from "../feedRecord/feedRecord.utils.js";
import type { TPayload, TUndo } from "../feedRecord/feedRecord.utils.js";
import {
  AMOUNT_TOLERANCE,
  FinancePermissions,
  MAX_INVOICE,
  MAX_PARTY,
  PaymentMethods,
  RECONCILIATION_LIMIT,
  REFERENCE_OPTION_LIMIT,
} from "../finance/finance.constants.js";
import { createLedger } from "../finance/finance.ledger.js";
import type { TFinanceRow, TReferenceView } from "../finance/finance.ledger.js";
import {
  can,
  generateFinanceNo,
  parseAmount,
  parseBusinessDate,
  parseDescription,
  parseText,
  rejectServerFields,
  requireReason,
  requireRole,
  requireWriter,
  sessionOpts,
  withDescriptionText,
} from "../finance/finance.utils.js";
import type { TFinanceAccess } from "../finance/finance.utils.js";
import { InventoryTransactionTypes } from "../inventory/inventory.constants.js";
import type { TInventoryTransactionDoc } from "../inventory/inventory.interface.js";
import { InventoryModel, InventoryTransactionModel } from "../inventory/inventory.model.js";
import { InventoryServices } from "../inventory/inventory.services.js";
import { TreatmentModel } from "../treatment/treatment.model.js";
import {
  EXPENSE_NO_PATTERN,
  EXPENSE_NO_PREFIX,
  ExpenseCategories,
  ExpenseReferenceTypes,
  ExpenseStatuses,
  ITEM_TYPE_CATEGORIES,
  STOCK_PURCHASE_CATEGORIES,
  TREATMENT_CATEGORIES,
} from "./expense.constants.js";
import { ExpenseModel } from "./expense.model.js";

const CATEGORIES = Object.values(ExpenseCategories) as string[];
const REFERENCE_TYPES = Object.values(ExpenseReferenceTypes) as string[];
const METHODS = Object.values(PaymentMethods) as string[];
const ACTIVE = { $ne: ExpenseStatuses.CANCELLED };

/* -------------------------------------------------------------------------- */
/*                              Linked records                                */
/* -------------------------------------------------------------------------- */

/** Ledger rows that were undone by a reversal (POST /inventory-transactions/:id/reverse). */
const reversedIds = async (farmObjectId: Types.ObjectId, ids: Types.ObjectId[]) => {
  if (!ids.length) return new Set<string>();
  const found = await InventoryTransactionModel.find({
    farmId: farmObjectId,
    referenceType: "Manual",
    referenceId: { $in: ids },
  })
    .select("referenceId")
    .lean();
  return new Set(found.map((row) => String(row.referenceId)));
};

const describeReferences = async (farmObjectId: Types.ObjectId, rows: TFinanceRow[], detail: boolean) => {
  const result = new Map<string, TReferenceView>();
  const idsOf = (type: string) =>
    rows.filter((row) => row.referenceType === type && row.referenceId).map((row) => row.referenceId as Types.ObjectId);

  const transactionIds = idsOf(ExpenseReferenceTypes.INVENTORY_TRANSACTION);
  const treatmentIds = idsOf(ExpenseReferenceTypes.TREATMENT);
  const [transactions, treatments, reversed] = await Promise.all([
    transactionIds.length
      ? InventoryTransactionModel.find({ _id: { $in: transactionIds }, farmId: farmObjectId }).lean()
      : [],
    treatmentIds.length
      ? TreatmentModel.find({ _id: { $in: treatmentIds }, farmId: farmObjectId })
          .select("treatmentNo animalId diseaseId diagnosisDate estimatedCost status")
          .populate({ path: "animalId", select: "animalCode name" })
          .populate({ path: "diseaseId", select: "diseaseName" })
          .lean()
      : [],
    reversedIds(farmObjectId, transactionIds),
  ]);
  const items = transactions.length
    ? await InventoryModel.find({ _id: { $in: transactions.map((row) => row.inventoryId) }, farmId: farmObjectId })
        .select("inventoryCode itemName itemType unit")
        .lean()
    : [];

  for (const row of transactions) {
    const item = items.find((entry) => entry._id.equals(row.inventoryId));
    result.set(String(row._id), {
      type: ExpenseReferenceTypes.INVENTORY_TRANSACTION,
      _id: row._id,
      label: row.transactionNo,
      details: {
        itemName: item?.itemName ?? null,
        ...(detail
          ? {
              inventoryId: row.inventoryId,
              inventoryCode: item?.inventoryCode ?? null,
              itemType: item?.itemType ?? null,
              quantity: row.quantity,
              unit: row.unit ?? item?.unit ?? null,
              unitPrice: row.unitPrice ?? null,
              totalAmount: row.totalAmount ?? null,
              transactionDate: row.transactionDate,
            }
          : {}),
        reversed: reversed.has(String(row._id)),
      },
    });
  }
  for (const row of treatments) {
    const animal = row.animalId as unknown as { _id: Types.ObjectId; animalCode: string; name?: string } | null;
    const disease = row.diseaseId as unknown as { diseaseName?: string } | null;
    result.set(String(row._id), {
      type: ExpenseReferenceTypes.TREATMENT,
      _id: row._id,
      label: row.treatmentNo,
      details: {
        animalId: animal?._id ?? null,
        animalCode: animal?.animalCode ?? null,
        ...(detail
          ? {
              diseaseName: disease?.diseaseName ?? null,
              diagnosisDate: row.diagnosisDate,
              treatmentStatus: row.status,
              //an estimate — never added to Expense.amount (spec 21 §52–53)
              estimatedCost: row.estimatedCost ?? null,
            }
          : {}),
      },
    });
  }
  return result;
};

/** Cancelling never moves stock: say what still has to be reconciled (spec 21 §103–105). */
const cancelReview = async (row: TFinanceRow) => {
  if (row.referenceType !== ExpenseReferenceTypes.INVENTORY_TRANSACTION || !row.referenceId) return null;
  const transaction = await InventoryTransactionModel.findOne({ _id: row.referenceId, farmId: row.farmId })
    .select("transactionNo")
    .lean();
  if (!transaction) return null;
  const reversed = (await reversedIds(row.farmId, [transaction._id])).has(String(transaction._id));
  if (reversed) return null;
  return {
    type: "InventoryTransaction",
    referenceId: transaction._id,
    referenceNo: transaction.transactionNo,
    message: `Stock receipt ${transaction.transactionNo} is still in inventory and no longer has an active expense. Reverse it if the goods were returned, or record a new expense if they were kept.`,
  };
};

export const ExpenseLedger = createLedger({
  name: "expense",
  noField: "expenseNo",
  noPattern: EXPENSE_NO_PATTERN,
  noExample: "EXP-2026-000001",
  dateField: "expenseDate",
  categoryField: "expenseCategory",
  partyField: "paidTo",
  categories: CATEGORIES,
  referenceTypes: REFERENCE_TYPES,
  settledStatus: "Paid",
  searchFields: ["expenseNo", "expenseCategory", "paidTo", "invoiceNumber", "description"],
  entityType: AuditEntityTypes.EXPENSE,
  model: ExpenseModel,
  describeReferences,
  cancelReview,
});

/* -------------------------------------------------------------------------- */
/*                                 Creation                                   */
/* -------------------------------------------------------------------------- */

type TResolvedReference = {
  referenceType: string;
  referenceId: Types.ObjectId | null;
  //only these categories make sense for the linked record
  categories: readonly string[];
  //a linked purchase fixes the amount
  amount: number | null;
  supplierName: string | null;
  transactionDate: Date | null;
};

const findByIdOrNo = (value: string, noField: string) =>
  isValidObjectId(value) ? { _id: new Types.ObjectId(value) } : { [noField]: value.toUpperCase() };

/** referenceType + referenceId are validated together and inside this farm (spec 21 §27). */
const resolveReference = async (access: TFinanceAccess, body: TPayload): Promise<TResolvedReference> => {
  const referenceType = isBlank(body.referenceType)
    ? ExpenseReferenceTypes.MANUAL
    : parseEnum("referenceType", body.referenceType, REFERENCE_TYPES);
  const plain = { referenceType, referenceId: null, amount: null, supplierName: null, transactionDate: null };

  if (referenceType === ExpenseReferenceTypes.INVENTORY_TRANSACTION || referenceType === ExpenseReferenceTypes.TREATMENT) {
    if (isBlank(body.referenceId)) {
      throw new AppError(status.BAD_REQUEST, `referenceId is required with referenceType ${referenceType}!`);
    }
    const value = String(body.referenceId).trim();
    if (referenceType === ExpenseReferenceTypes.TREATMENT) {
      const treatment = await TreatmentModel.findOne({
        ...findByIdOrNo(value, "treatmentNo"),
        farmId: access.farmObjectId,
      })
        .select("_id")
        .lean();
      if (!treatment) throw new AppError(status.NOT_FOUND, "Treatment not found in this farm!");
      return { ...plain, referenceId: treatment._id, categories: TREATMENT_CATEGORIES };
    }

    const transaction = await InventoryTransactionModel.findOne({
      ...findByIdOrNo(value, "transactionNo"),
      farmId: access.farmObjectId,
    }).lean();
    if (!transaction) throw new AppError(status.NOT_FOUND, "Inventory transaction not found in this farm!");
    if (transaction.transactionType !== InventoryTransactionTypes.PURCHASE) {
      throw new AppError(status.BAD_REQUEST, `${transaction.transactionNo} is not a Purchase — only purchases cost money.`);
    }
    if (!transaction.totalAmount) {
      throw new AppError(status.BAD_REQUEST, `${transaction.transactionNo} has no purchase amount.`);
    }
    if ((await reversedIds(access.farmObjectId, [transaction._id])).size) {
      throw new AppError(status.CONFLICT, `${transaction.transactionNo} was reversed — it is no longer a purchase.`);
    }
    const item = await InventoryModel.findOne({ _id: transaction.inventoryId, farmId: access.farmObjectId })
      .select("itemType")
      .lean();
    return {
      referenceType,
      referenceId: transaction._id,
      categories: ITEM_TYPE_CATEGORIES[item?.itemType ?? ""] ?? CATEGORIES,
      amount: transaction.totalAmount,
      supplierName: transaction.supplierName ?? null,
      transactionDate: transaction.transactionDate,
    };
  }

  //Manual / Salary / Other: no collection exists to point at, so no fake reference is stored
  if (!isBlank(body.referenceId)) {
    throw new AppError(status.BAD_REQUEST, `referenceId is not accepted with referenceType ${referenceType}!`);
  }
  return {
    ...plain,
    categories: referenceType === ExpenseReferenceTypes.SALARY ? [ExpenseCategories.SALARY] : CATEGORIES,
  };
};

const pickCategory = (value: unknown, allowed: readonly string[]): string => {
  if (isBlank(value)) {
    if (allowed.length === CATEGORIES.length) throw new AppError(status.BAD_REQUEST, "expenseCategory is required!");
    return allowed[0]!;
  }
  const category = parseEnum("expenseCategory", value, CATEGORIES);
  if (!allowed.includes(category)) {
    throw new AppError(status.BAD_REQUEST, `expenseCategory must be one of ${allowed.join(", ")} for this reference!`);
  }
  return category;
};

/** One active expense per purchase. The ledger row is touched so two requests cannot race. */
const assertPurchaseUnbooked = async (farmObjectId: Types.ObjectId, id: Types.ObjectId, session: ClientSession | null) => {
  await InventoryTransactionModel.updateOne({ _id: id }, { $inc: { __v: 1 } }, { timestamps: false, ...sessionOpts(session) });
  const existing = await ExpenseModel.findOne({
    farmId: farmObjectId,
    referenceType: ExpenseReferenceTypes.INVENTORY_TRANSACTION,
    referenceId: id,
    status: ACTIVE,
  })
    .select("expenseNo")
    .session(session)
    .lean();
  if (existing) {
    throw new AppError(status.CONFLICT, `This purchase is already recorded as ${existing.expenseNo} — it cannot be counted twice.`);
  }
};

/** Same day + amount + category (and payee / invoice when known) is a warning, not proof. */
const assertNotDuplicate = async (farmObjectId: Types.ObjectId, data: Record<string, unknown>, body: TPayload) => {
  if (parseBoolean(body.confirmDuplicate)) return;
  const similar = await ExpenseModel.findOne({
    farmId: farmObjectId,
    expenseDate: data.expenseDate as Date,
    amount: data.amount as number,
    expenseCategory: data.expenseCategory as string,
    status: ACTIVE,
    ...(data.paidTo ? { paidTo: data.paidTo as string } : {}),
    ...(data.invoiceNumber ? { invoiceNumber: data.invoiceNumber as string } : {}),
  })
    .select("expenseNo")
    .lean();
  if (similar) {
    throw new AppError(
      status.CONFLICT,
      `Possible duplicate: ${similar.expenseNo} has the same date, amount and category. Resend with confirmDuplicate: true if this is a different expense.`,
    );
  }
};

const parseCommon = (body: TPayload, supplier: string | null = null, defaultDate: Date | null = null) => {
  const state = isBlank(body.status)
    ? ExpenseStatuses.PENDING
    : parseEnum("status", body.status, [ExpenseStatuses.PENDING, ExpenseStatuses.PAID]);
  const paidTo = parseText("paidTo", body.paidTo, MAX_PARTY) ?? supplier;
  if (state === ExpenseStatuses.PAID) {
    if (isBlank(body.paymentMethod)) throw new AppError(status.BAD_REQUEST, "paymentMethod is required for a Paid expense!");
    if (!paidTo) throw new AppError(status.BAD_REQUEST, "paidTo is required for a Paid expense!");
  }
  return {
    status: state,
    expenseDate:
      isBlank(body.expenseDate) && defaultDate
        ? parseBusinessDate("expenseDate", defaultDate.toISOString())
        : parseBusinessDate("expenseDate", body.expenseDate),
    //the schema requires a method; for a Pending bill it is the planned one
    paymentMethod: isBlank(body.paymentMethod) ? PaymentMethods.CASH : parseEnum("paymentMethod", body.paymentMethod, METHODS),
    paidTo,
    invoiceNumber: parseText("invoiceNumber", body.invoiceNumber, MAX_INVOICE),
    description: parseDescription(body.description),
  };
};

const insert = async (data: Record<string, unknown>, session: ClientSession | null, undo: TUndo) => {
  const expenseNo = await generateFinanceNo(EXPENSE_NO_PREFIX);
  const [row] = await ExpenseModel.create([{ ...data, expenseNo }], sessionOpts(session));
  if (!row) throw new AppError(status.INTERNAL_SERVER_ERROR, "Expense could not be created!");
  undo.push(() => ExpenseModel.deleteOne({ _id: row._id }));
  return { _id: row._id, expenseNo };
};

const auditCreated = (
  context: TAuditContext | undefined,
  farmObjectId: Types.ObjectId,
  created: { _id: Types.ObjectId; expenseNo: string },
  data: Record<string, unknown>,
) =>
  ExpenseLedger.audit(context, farmObjectId, created._id, AuditActions.CREATE, "Expense Recorded", null, {
    expenseNo: created.expenseNo,
    ...data,
  });

const createExpense = async (farmId: string, requester: string, body: TPayload, context?: TAuditContext) => {
  const access = await ExpenseLedger.access(farmId, requester, "record expenses", true);
  const memberId = requireWriter(access);
  rejectServerFields(body);

  const reference = await resolveReference(access, body);
  const amount = reference.amount !== null && isBlank(body.amount) ? reference.amount : parseAmount("amount", body.amount);
  if (reference.amount !== null && Math.abs(amount - reference.amount) > AMOUNT_TOLERANCE) {
    throw new AppError(status.BAD_REQUEST, `amount must equal the purchase total (${reference.amount})!`);
  }
  const data = {
    farmId: access.farmObjectId,
    expenseCategory: pickCategory(body.expenseCategory, reference.categories),
    amount: reference.amount ?? amount,
    ...parseCommon(body, reference.supplierName, reference.transactionDate),
    referenceType: reference.referenceType,
    referenceId: reference.referenceId,
    createdBy: memberId,
  };
  await assertNotDuplicate(access.farmObjectId, data, body);

  const created = await executeAtomically(async (session, undo) => {
    if (reference.referenceType === ExpenseReferenceTypes.INVENTORY_TRANSACTION && reference.referenceId) {
      await assertPurchaseUnbooked(access.farmObjectId, reference.referenceId, session);
    }
    return insert(data, session, undo);
  }, {
    trace: ExpenseLedger.trace(context, access.farmObjectId, null, AuditActions.CREATE, "Expense Recorded"),
    log: async (created) => {
      
      await auditCreated(context, access.farmObjectId, created, data);
    },
  });

  const warnings: string[] = [];
  if (STOCK_PURCHASE_CATEGORIES.includes(data.expenseCategory) && reference.referenceType === ExpenseReferenceTypes.MANUAL) {
    warnings.push("This expense does not add stock. Use the purchase workflow when goods enter the inventory.");
  }
  return { expense: await ExpenseLedger.detailById(access.farmObjectId, created._id), warnings };
};

/**
 * POST /expenses/purchase — stock, weighted average price, Purchase ledger row and the
 * linked Expense are one unit of work: the expense is inserted inside the inventory
 * module's own transaction, so either everything is saved or nothing is.
 */
const createPurchase = async (farmId: string, requester: string, body: TPayload, context?: TAuditContext) => {
  const access = await ExpenseLedger.access(farmId, requester, "record purchases", true);
  const memberId = requireWriter(access);
  rejectServerFields(body);

  const newItem = body.newItem && typeof body.newItem === "object" ? (body.newItem as TPayload) : null;
  if (Boolean(newItem) === !isBlank(body.inventoryId)) {
    throw new AppError(status.BAD_REQUEST, "Send either inventoryId (restock) or newItem (first purchase), not both!");
  }
  if (newItem) requireRole(access, FinancePermissions.NEW_STOCK_ITEM, "register a new stock item");

  const unitPrice = parseAmount("unitPrice", body.unitPrice);
  const common = parseCommon(body);

  let itemType: string;
  if (newItem) itemType = String(newItem.itemType);
  else {
    const item = await InventoryModel.findOne({
      ...findByIdOrNo(String(body.inventoryId).trim(), "inventoryCode"),
      farmId: access.farmObjectId,
    })
      .select("itemType supplierName")
      .lean();
    if (!item) throw new AppError(status.NOT_FOUND, "Inventory item not found in this farm!");
    itemType = item.itemType;
    common.paidTo ??= item.supplierName ?? null;
  }
  const expenseCategory = pickCategory(body.expenseCategory, ITEM_TYPE_CATEGORIES[itemType] ?? CATEGORIES);

  let created: { _id: Types.ObjectId; expenseNo: string } | null = null;
  let saved: Record<string, unknown> = {};
  const linkExpense = async (transaction: TInventoryTransactionDoc, session: ClientSession | null, undo: TUndo) => {
    if (!transaction.totalAmount) throw new AppError(status.BAD_REQUEST, "The purchase total must be greater than 0!");
    saved = {
      farmId: access.farmObjectId,
      expenseCategory,
      amount: transaction.totalAmount,
      ...common,
      referenceType: ExpenseReferenceTypes.INVENTORY_TRANSACTION,
      referenceId: transaction._id,
      createdBy: memberId,
    };
    const row = await insert(saved, session, undo);
    created = row;
    //same unit of work as the stock movement
    await withAuditSession(session, () => auditCreated(context, access.farmObjectId, row, saved));
  };

  const supplier = common.paidTo ? { supplierName: common.paidTo } : {};
  const day = common.expenseDate.toISOString().slice(0, 10);
  const expiry = isBlank(body.expiryDate) ? {} : { expiryDate: body.expiryDate };
  const remarks = common.description ? { remarks: common.description } : {};

  let stock: { inventoryId: Types.ObjectId; itemName: string; unit: string; currentStock: number; warnings: string[] };
  let transactionNo: string;
  if (newItem) {
    const allowed = [
      "itemName", "itemType", "unit", "referenceId", "category", "storageLocation",
      "minimumStock", "reorderLevel", "maximumStock", "confirmDuplicate",
    ];
    const picked = Object.fromEntries(Object.entries(newItem).filter(([key]) => allowed.includes(key)));
    const result = await InventoryServices.createInventoryItem(
      farmId,
      requester,
      {
        ...picked,
        ...supplier,
        ...expiry,
        currentStock: body.quantity,
        openingTransactionType: InventoryTransactionTypes.PURCHASE,
        openingUnitPrice: unitPrice,
        openingTransactionDate: day,
        ...(common.description ? { openingRemarks: common.description } : {}),
      },
      context,
      linkExpense,
    );
    stock = {
      inventoryId: result.item._id,
      itemName: result.item.itemName,
      unit: result.item.unit,
      currentStock: result.item.currentStock,
      warnings: [],
    };
    transactionNo = result.openingTransaction?.transactionNo ?? "";
  } else {
    const result = await InventoryServices.createTransaction(
      farmId,
      requester,
      {
        inventoryId: body.inventoryId,
        transactionType: InventoryTransactionTypes.PURCHASE,
        quantity: body.quantity,
        unitPrice,
        transactionDate: day,
        ...supplier,
        ...expiry,
        ...remarks,
      },
      context,
      linkExpense,
    );
    stock = {
      inventoryId: result.item._id,
      itemName: result.item.itemName,
      unit: result.item.unit,
      currentStock: result.item.currentStock,
      warnings: result.warnings,
    };
    transactionNo = result.transaction.transactionNo;
  }

  const expenseRef = created as { _id: Types.ObjectId; expenseNo: string } | null;
  if (!expenseRef) throw new AppError(status.INTERNAL_SERVER_ERROR, "The purchase expense was not recorded!");
  const { warnings, ...item } = stock;
  return {
    expense: await ExpenseLedger.detailById(access.farmObjectId, expenseRef._id),
    transactionNo,
    item,
    warnings,
  };
};

/* -------------------------------------------------------------------------- */
/*                            Controlled update                               */
/* -------------------------------------------------------------------------- */

const FINANCIAL_FIELDS = ["amount", "expenseCategory", "expenseDate", "paymentMethod"];

const updateExpense = async (farmId: string, ref: string, requester: string, body: TPayload, context?: TAuditContext) => {
  const access = await ExpenseLedger.access(farmId, requester, "update expenses", true);
  const memberId = requireWriter(access);
  rejectServerFields(body);
  const row = await ExpenseLedger.find(access, ref);
  if (row.status === ExpenseStatuses.CANCELLED) {
    throw new AppError(status.CONFLICT, "A Cancelled expense can no longer be changed!");
  }

  const next: Record<string, unknown> = {};
  if ("paidTo" in body) {
    next.paidTo = parseText("paidTo", body.paidTo, MAX_PARTY);
    if (!next.paidTo && row.status === ExpenseStatuses.PAID) {
      throw new AppError(status.BAD_REQUEST, "paidTo cannot be emptied on a Paid expense!");
    }
  }
  if ("invoiceNumber" in body) next.invoiceNumber = parseText("invoiceNumber", body.invoiceNumber, MAX_INVOICE);
  if ("description" in body) {
    next.description = withDescriptionText(row.description, parseDescription(body.description)) || null;
  }
  if ("amount" in body) next.amount = parseAmount("amount", body.amount);
  if ("expenseCategory" in body) next.expenseCategory = parseEnum("expenseCategory", body.expenseCategory, CATEGORIES);
  if ("expenseDate" in body) next.expenseDate = parseBusinessDate("expenseDate", body.expenseDate);
  if ("paymentMethod" in body) next.paymentMethod = parseEnum("paymentMethod", body.paymentMethod, METHODS);

  const same = (a: unknown, b: unknown) =>
    (a instanceof Date ? a.getTime() : (a ?? null)) === (b instanceof Date ? b.getTime() : (b ?? null));
  const changed = Object.keys(next).filter((key) => !same(next[key], row[key]));
  if (!changed.length) {
    return { mode: "unchanged" as const, changedFields: changed, expense: await ExpenseLedger.detailById(access.farmObjectId, row._id) };
  }

  let reason: string | null = parseText("reason", body.reason, 200);
  if (changed.some((key) => FINANCIAL_FIELDS.includes(key))) {
    if (row.status === ExpenseStatuses.PAID) {
      requireRole(access, FinancePermissions.CORRECT_SETTLED, "correct a Paid expense");
    }
    reason = requireReason(body.reason, "correct financial values");
  }
  if (row.referenceType === ExpenseReferenceTypes.INVENTORY_TRANSACTION && changed.includes("amount")) {
    throw new AppError(
      status.CONFLICT,
      "The amount of a linked purchase must match its stock ledger row. Reverse the stock movement, cancel this expense and record the purchase again.",
    );
  }
  if (changed.includes("expenseCategory") && row.referenceId) {
    const reference = await resolveReferenceCategories(access, row);
    if (!reference.includes(String(next.expenseCategory))) {
      throw new AppError(status.BAD_REQUEST, `expenseCategory must be one of ${reference.join(", ")} for this reference!`);
    }
  }
  if (row.referenceType === ExpenseReferenceTypes.SALARY && changed.includes("expenseCategory")) {
    throw new AppError(status.BAD_REQUEST, "A Salary reference only fits the Salary category!");
  }

  const pick = (source: Record<string, unknown>) => Object.fromEntries(changed.map((key) => [key, source[key] ?? null]));
  await ExpenseLedger.writeAudited(
    access,
    row,
    pick(next),
    memberId,
    ExpenseLedger.trace(context, access.farmObjectId, row._id, AuditActions.UPDATE, "Expense Updated"),
    () =>
      ExpenseLedger.audit(
        context,
        access.farmObjectId,
        row._id,
        AuditActions.UPDATE,
        changed.some((key) => FINANCIAL_FIELDS.includes(key)) ? "Expense Corrected" : "Expense Updated",
        pick(row),
        { ...pick(next), ...(reason ? { reason } : {}) },
        changed,
      ),
  );
  return { mode: "updated" as const, changedFields: changed, expense: await ExpenseLedger.detailById(access.farmObjectId, row._id) };
};

/** Categories that fit the record an existing expense is linked to. */
const resolveReferenceCategories = async (access: TFinanceAccess, row: TFinanceRow): Promise<readonly string[]> => {
  if (row.referenceType === ExpenseReferenceTypes.TREATMENT) return TREATMENT_CATEGORIES;
  const transaction = await InventoryTransactionModel.findOne({ _id: row.referenceId, farmId: access.farmObjectId })
    .select("inventoryId")
    .lean();
  const item = transaction
    ? await InventoryModel.findOne({ _id: transaction.inventoryId, farmId: access.farmObjectId }).select("itemType").lean()
    : null;
  return ITEM_TYPE_CATEGORIES[item?.itemType ?? ""] ?? CATEGORIES;
};

/* -------------------------------------------------------------------------- */
/*                     Meta, pickers and reconciliation                       */
/* -------------------------------------------------------------------------- */

const getMeta = async (farmId: string, requester: string) => {
  const access = await ExpenseLedger.access(farmId, requester, "view expenses");
  const active = access.farmStatus === "Active";
  return {
    categories: CATEGORIES,
    paymentMethods: METHODS,
    referenceTypes: REFERENCE_TYPES,
    statuses: Object.values(ExpenseStatuses),
    itemTypeCategories: ITEM_TYPE_CATEGORIES,
    treatmentCategories: TREATMENT_CATEGORIES,
    permissions: {
      role: access.role,
      write: active && can(access, FinancePermissions.WRITE),
      correctSettled: active && can(access, FinancePermissions.CORRECT_SETTLED),
      newStockItem: active && can(access, FinancePermissions.NEW_STOCK_ITEM),
    },
  };
};

/** Purchases that carry money, were not reversed and have no active expense. */
const unbookedPurchases = async (farmObjectId: Types.ObjectId, limit: number) => {
  const pipeline = [
    { $match: { farmId: farmObjectId, transactionType: InventoryTransactionTypes.PURCHASE, totalAmount: { $gt: 0 } } },
    {
      $lookup: {
        from: ExpenseModel.collection.name,
        let: { id: "$_id" },
        pipeline: [
          {
            $match: {
              farmId: farmObjectId,
              referenceType: ExpenseReferenceTypes.INVENTORY_TRANSACTION,
              status: ACTIVE,
              $expr: { $eq: ["$referenceId", "$$id"] },
            },
          },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: "expenses",
      },
    },
    { $match: { expenses: { $size: 0 } } },
    {
      $lookup: {
        from: InventoryTransactionModel.collection.name,
        let: { id: "$_id" },
        pipeline: [
          { $match: { farmId: farmObjectId, referenceType: "Manual", $expr: { $eq: ["$referenceId", "$$id"] } } },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: "reversals",
      },
    },
    { $match: { reversals: { $size: 0 } } },
    {
      $facet: {
        rows: [
          { $sort: { transactionDate: -1 as const, _id: -1 as const } },
          { $limit: limit },
          {
            $lookup: {
              from: InventoryModel.collection.name,
              localField: "inventoryId",
              foreignField: "_id",
              as: "item",
            },
          },
          {
            $project: {
              transactionNo: 1,
              transactionDate: 1,
              quantity: 1,
              unit: 1,
              totalAmount: 1,
              supplierName: 1,
              itemName: { $first: "$item.itemName" },
              itemType: { $first: "$item.itemType" },
            },
          },
        ],
        total: [{ $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$totalAmount" } } }],
      },
    },
  ];
  const [result] = await InventoryTransactionModel.aggregate<{
    rows: Record<string, unknown>[];
    total: { count: number; amount: number }[];
  }>(pipeline);
  return {
    rows: result?.rows ?? [],
    count: result?.total[0]?.count ?? 0,
    amount: Math.round((result?.total[0]?.amount ?? 0) * 100) / 100,
  };
};

/** GET /expenses/reference-options?referenceType= — rows for the create form's picker. */
const getReferenceOptions = async (farmId: string, requester: string, query: TPayload) => {
  const access = await ExpenseLedger.access(farmId, requester, "record expenses", true);
  const type = parseEnum("referenceType", query.referenceType, [
    ExpenseReferenceTypes.INVENTORY_TRANSACTION,
    ExpenseReferenceTypes.TREATMENT,
  ]);
  if (type === ExpenseReferenceTypes.INVENTORY_TRANSACTION) {
    return (await unbookedPurchases(access.farmObjectId, REFERENCE_OPTION_LIMIT)).rows;
  }
  return TreatmentModel.find({ farmId: access.farmObjectId })
    .sort({ diagnosisDate: -1 })
    .limit(REFERENCE_OPTION_LIMIT)
    .select("treatmentNo diagnosisDate status estimatedCost animalId diseaseId")
    .populate({ path: "animalId", select: "animalCode name" })
    .populate({ path: "diseaseId", select: "diseaseName" })
    .lean();
};

/** GET /expenses/reconciliation — purchases vs expenses (spec 21 §106–107). Read-only. */
const getReconciliation = async (farmId: string, requester: string) => {
  const access = await ExpenseLedger.access(farmId, requester, "view finance reconciliation");
  const [missing, linked] = await Promise.all([
    unbookedPurchases(access.farmObjectId, RECONCILIATION_LIMIT),
    ExpenseModel.find({
      farmId: access.farmObjectId,
      referenceType: ExpenseReferenceTypes.INVENTORY_TRANSACTION,
      status: ACTIVE,
    })
      .select("expenseNo amount expenseDate status referenceId")
      .lean(),
  ]);
  const ids = linked.map((row) => row.referenceId).filter((id): id is Types.ObjectId => Boolean(id));
  const [transactions, reversed] = await Promise.all([
    InventoryTransactionModel.find({ _id: { $in: ids }, farmId: access.farmObjectId })
      .select("transactionNo totalAmount")
      .lean(),
    reversedIds(access.farmObjectId, ids),
  ]);
  const byId = new Map(transactions.map((row) => [String(row._id), row]));
  const view = (row: (typeof linked)[number]) => ({
    _id: row._id,
    expenseNo: row.expenseNo,
    amount: row.amount,
    expenseDate: row.expenseDate,
    status: row.status,
    transactionId: row.referenceId,
    transactionNo: byId.get(String(row.referenceId))?.transactionNo ?? null,
    transactionAmount: byId.get(String(row.referenceId))?.totalAmount ?? null,
  });
  const reversedPurchases = linked.filter((row) => reversed.has(String(row.referenceId))).map(view);
  const mismatched = linked
    .filter((row) => {
      const transaction = byId.get(String(row.referenceId));
      return !transaction || Math.abs((transaction.totalAmount ?? 0) - row.amount) > AMOUNT_TOLERANCE;
    })
    .map(view);
  return {
    balanced: !missing.count && !reversedPurchases.length && !mismatched.length,
    //stock came in but no money was booked
    purchasesWithoutExpense: missing,
    //goods went back but the expense still counts
    expensesOfReversedPurchases: { count: reversedPurchases.length, rows: reversedPurchases.slice(0, RECONCILIATION_LIMIT) },
    amountMismatches: { count: mismatched.length, rows: mismatched.slice(0, RECONCILIATION_LIMIT) },
  };
};

export const ExpenseServices = {
  createExpense,
  createPurchase,
  updateExpense,
  getMeta,
  getReferenceOptions,
  getReconciliation,
};
