import status from "http-status";
import { isValidObjectId, Types } from "mongoose";
import type { ClientSession } from "mongoose";
import AppError from "../../errors/AppError.js";
import { AnimalLifeStatuses } from "../animal/animal.constants.js";
import { AnimalModel } from "../animal/animal.model.js";
import { AuditActions, AuditEntityTypes, AuditModules } from "../auditLog/auditLog.constants.js";
import { recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext } from "../auditLog/auditLog.utils.js";
import { BreedingModel } from "../breeding/breeding.model.js";
import { escapeRegex, executeAtomically, isBlank, parseBoolean, parseEnum, parseNumber } from "../feedRecord/feedRecord.utils.js";
import type { TPayload, TUndo } from "../feedRecord/feedRecord.utils.js";
import { ExpenseLedger } from "../expense/expense.services.js";
import {
  AMOUNT_TOLERANCE,
  FinancePermissions,
  MAX_INVOICE,
  MAX_PARTY,
  MAX_QUANTITY,
  MILK_KG_PER_LITER,
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
import { roundMoney, roundQuantity } from "../inventory/inventory.utils.js";
import { MilkQualities } from "../milkRecord/milkRecord.constants.js";
import { MilkRecordModel } from "../milkRecord/milkRecord.model.js";
import {
  ANIMAL_CATEGORIES,
  CATEGORY_UNITS,
  INCOME_NO_PATTERN,
  INCOME_NO_PREFIX,
  IncomeCategories,
  IncomeReferenceTypes,
  IncomeStatuses,
  IncomeUnits,
  MANUAL_CATEGORIES,
} from "./income.constants.js";
import { IncomeModel } from "./income.model.js";

const CATEGORIES = Object.values(IncomeCategories) as string[];
const REFERENCE_TYPES = Object.values(IncomeReferenceTypes) as string[];
const METHODS = Object.values(PaymentMethods) as string[];
const ACTIVE = { $ne: IncomeStatuses.CANCELLED };

/* -------------------------------------------------------------------------- */
/*                              Linked records                                */
/* -------------------------------------------------------------------------- */

const toLiters = (quantity: number, unit: string | null | undefined) =>
  roundQuantity(unit === IncomeUnits.KG ? quantity / MILK_KG_PER_LITER : quantity);

/** Liters already sold per milk record, over active (Pending + Received) incomes. */
const soldLitersByRecord = async (
  farmObjectId: Types.ObjectId,
  ids: Types.ObjectId[],
  session: ClientSession | null = null,
  excludeIncomeId: Types.ObjectId | null = null,
) => {
  const rows = ids.length
    ? await IncomeModel.find({
        farmId: farmObjectId,
        referenceType: IncomeReferenceTypes.MILK_RECORD,
        referenceId: { $in: ids },
        status: ACTIVE,
        ...(excludeIncomeId ? { _id: { $ne: excludeIncomeId } } : {}),
      })
        .select("referenceId quantity unit")
        .session(session)
        .lean()
    : [];
  const sold = new Map<string, number>();
  for (const row of rows) {
    const key = String(row.referenceId);
    sold.set(key, roundQuantity((sold.get(key) ?? 0) + toLiters(row.quantity ?? 0, row.unit)));
  }
  return sold;
};

const describeReferences = async (farmObjectId: Types.ObjectId, rows: TFinanceRow[], detail: boolean) => {
  const result = new Map<string, TReferenceView>();
  const idsOf = (type: string) =>
    rows.filter((row) => row.referenceType === type && row.referenceId).map((row) => row.referenceId as Types.ObjectId);
  const milkIds = idsOf(IncomeReferenceTypes.MILK_RECORD);
  const animalIds = idsOf(IncomeReferenceTypes.ANIMAL);
  const breedingIds = idsOf(IncomeReferenceTypes.BREEDING);

  const [milk, animals, breedings, sold] = await Promise.all([
    milkIds.length
      ? MilkRecordModel.find({ _id: { $in: milkIds }, farmId: farmObjectId })
          .select("animalId recordDate milkingSession quantityInLiters isVoided")
          .populate({ path: "animalId", select: "animalCode name" })
          .lean()
      : [],
    animalIds.length
      ? AnimalModel.find({ _id: { $in: animalIds }, farmId: farmObjectId })
          .select("animalCode name lifeStatus gender purchasePrice")
          .lean()
      : [],
    breedingIds.length
      ? BreedingModel.find({ _id: { $in: breedingIds }, farmId: farmObjectId })
          .select("breedingNo animalId breedingMethod inseminationDate pregnancyResult")
          .populate({ path: "animalId", select: "animalCode name" })
          .lean()
      : [],
    detail ? soldLitersByRecord(farmObjectId, milkIds) : new Map<string, number>(),
  ]);

  type TAnimalRef = { _id: Types.ObjectId; animalCode: string; name?: string } | null;
  for (const row of milk) {
    const animal = row.animalId as unknown as TAnimalRef;
    result.set(String(row._id), {
      type: IncomeReferenceTypes.MILK_RECORD,
      _id: row._id,
      label: `${animal?.animalCode ?? ""} ${row.recordDate.toISOString().slice(0, 10)}`.trim(),
      details: {
        animalId: animal?._id ?? null,
        animalCode: animal?.animalCode ?? null,
        recordDate: row.recordDate,
        milkingSession: row.milkingSession,
        producedLiters: row.quantityInLiters,
        isVoided: row.isVoided,
        ...(detail ? { soldLiters: sold.get(String(row._id)) ?? 0 } : {}),
      },
    });
  }
  for (const row of animals) {
    result.set(String(row._id), {
      type: IncomeReferenceTypes.ANIMAL,
      _id: row._id,
      label: row.animalCode,
      details: {
        animalId: row._id,
        animalCode: row.animalCode,
        name: row.name ?? null,
        lifeStatus: row.lifeStatus,
        //a price difference, never called profit (spec 22 §86)
        ...(detail ? { purchasePrice: row.purchasePrice ?? null } : {}),
      },
    });
  }
  for (const row of breedings) {
    const animal = row.animalId as unknown as TAnimalRef;
    result.set(String(row._id), {
      type: IncomeReferenceTypes.BREEDING,
      _id: row._id,
      label: row.breedingNo,
      details: {
        animalId: animal?._id ?? null,
        animalCode: animal?.animalCode ?? null,
        breedingMethod: row.breedingMethod,
        inseminationDate: row.inseminationDate ?? null,
        pregnancyResult: row.pregnancyResult,
      },
    });
  }
  return result;
};

/** Income and operational status are not coupled: flag, never change (spec 22 §75). */
const cancelReview = async (row: TFinanceRow) => {
  if (!row.referenceId) return null;
  if (row.referenceType === IncomeReferenceTypes.ANIMAL) {
    const animal = await AnimalModel.findOne({ _id: row.referenceId, farmId: row.farmId }).select("animalCode lifeStatus").lean();
    if (!animal || animal.lifeStatus !== AnimalLifeStatuses.SOLD) return null;
    return {
      type: "Animal",
      referenceId: animal._id,
      referenceNo: animal.animalCode,
      message: `${animal.animalCode} is still marked Sold and no longer has an active sale income. Review whether the sale really happened; if it did, record the income again.`,
    };
  }
  if (row.referenceType === IncomeReferenceTypes.MILK_RECORD) {
    return {
      type: "MilkRecord",
      referenceId: row.referenceId,
      referenceNo: null,
      message: "The milk record is unchanged; the cancelled quantity is available for sale again.",
    };
  }
  return null;
};

export const IncomeLedger = createLedger({
  name: "income",
  noField: "incomeNo",
  noPattern: INCOME_NO_PATTERN,
  noExample: "INC-2026-000001",
  dateField: "incomeDate",
  categoryField: "incomeCategory",
  partyField: "customerName",
  categories: CATEGORIES,
  referenceTypes: REFERENCE_TYPES,
  settledStatus: "Received",
  searchFields: ["incomeNo", "incomeCategory", "customerName", "customerPhone", "invoiceNumber", "description"],
  entityType: AuditEntityTypes.INCOME,
  model: IncomeModel,
  describeReferences,
  cancelReview,
});

/* -------------------------------------------------------------------------- */
/*                                 Creation                                   */
/* -------------------------------------------------------------------------- */

const parsePhone = (value: unknown): string | null => {
  const phone = parseText("customerPhone", value, 20);
  if (phone && !/^\+?[0-9][0-9 -]{5,19}$/.test(phone)) {
    throw new AppError(status.BAD_REQUEST, "customerPhone must be a valid phone number!");
  }
  return phone;
};

const parseCommon = (body: TPayload) => {
  const state = isBlank(body.status)
    ? IncomeStatuses.PENDING
    : parseEnum("status", body.status, [IncomeStatuses.PENDING, IncomeStatuses.RECEIVED]);
  if (state === IncomeStatuses.RECEIVED && isBlank(body.paymentMethod)) {
    throw new AppError(status.BAD_REQUEST, "paymentMethod is required for a Received income!");
  }
  return {
    status: state,
    incomeDate: parseBusinessDate("incomeDate", body.incomeDate),
    //the schema requires a method; for a Pending sale it is the expected one
    paymentMethod: isBlank(body.paymentMethod) ? PaymentMethods.CASH : parseEnum("paymentMethod", body.paymentMethod, METHODS),
    customerName: parseText("customerName", body.customerName, MAX_PARTY),
    customerPhone: parsePhone(body.customerPhone),
    invoiceNumber: parseText("invoiceNumber", body.invoiceNumber, MAX_INVOICE),
    description: parseDescription(body.description),
  };
};

const parseSaleQuantity = (value: unknown) => {
  const quantity = roundQuantity(parseNumber("quantity", value, { min: 0, max: MAX_QUANTITY, exclusiveMin: true }));
  if (quantity <= 0) throw new AppError(status.BAD_REQUEST, "quantity must be greater than 0!");
  return quantity;
};

/** amount = quantity × unitPrice; only the Owner may book a different amount, with a reason. */
const resolveAmount = (
  access: TFinanceAccess,
  quantity: number,
  unitPrice: number,
  sent: unknown,
  reason: unknown,
): { amount: number; override: string | null } => {
  const computed = roundMoney(quantity * unitPrice);
  if (computed <= 0) throw new AppError(status.BAD_REQUEST, "The sale amount must be greater than 0!");
  if (isBlank(sent)) return { amount: computed, override: null };
  const amount = parseAmount("amount", sent);
  if (Math.abs(amount - computed) <= AMOUNT_TOLERANCE) return { amount: computed, override: null };
  if (!can(access, FinancePermissions.OVERRIDE_AMOUNT)) {
    throw new AppError(
      status.FORBIDDEN,
      `amount must equal quantity × unitPrice (${computed}). Only the farm Owner may override it.`,
    );
  }
  return { amount, override: requireReason(reason, "override the calculated amount") };
};

const assertNotDuplicate = async (farmObjectId: Types.ObjectId, data: Record<string, unknown>, body: TPayload) => {
  if (parseBoolean(body.confirmDuplicate)) return;
  const similar = await IncomeModel.findOne({
    farmId: farmObjectId,
    incomeDate: data.incomeDate as Date,
    amount: data.amount as number,
    incomeCategory: data.incomeCategory as string,
    referenceId: (data.referenceId as Types.ObjectId | null) ?? null,
    status: ACTIVE,
    ...(data.customerName ? { customerName: data.customerName as string } : {}),
    ...(data.invoiceNumber ? { invoiceNumber: data.invoiceNumber as string } : {}),
  })
    .select("incomeNo")
    .lean();
  if (similar) {
    throw new AppError(
      status.CONFLICT,
      `Possible duplicate: ${similar.incomeNo} has the same date, amount and category. Resend with confirmDuplicate: true if this is a different income.`,
    );
  }
};

const insert = async (data: Record<string, unknown>, session: ClientSession | null, undo: TUndo) => {
  const incomeNo = await generateFinanceNo(INCOME_NO_PREFIX);
  const [row] = await IncomeModel.create([{ ...data, incomeNo }], sessionOpts(session));
  if (!row) throw new AppError(status.INTERNAL_SERVER_ERROR, "Income could not be created!");
  undo.push(() => IncomeModel.deleteOne({ _id: row._id }));
  return { _id: row._id, incomeNo };
};

const start = async (farmId: string, requester: string, body: TPayload) => {
  const access = await IncomeLedger.access(farmId, requester, "record income", true);
  const memberId = requireWriter(access);
  rejectServerFields(body);
  return { access, memberId };
};

type TCreated = { _id: Types.ObjectId; incomeNo: string };

const auditCreated = async (
  context: TAuditContext | undefined,
  access: TFinanceAccess,
  created: { _id: Types.ObjectId; incomeNo: string },
  data: Record<string, unknown>,
  override: string | null = null,
) => {
  await IncomeLedger.audit(context, access.farmObjectId, created._id, AuditActions.CREATE, "Income Recorded", null, {
    incomeNo: created.incomeNo,
    ...data,
    ...(override ? { amountOverrideReason: override } : {}),
  });
};

/** Audit step of a new income (see executeAtomically). */
const auditing = (
  context: TAuditContext | undefined,
  access: TFinanceAccess,
  data: Record<string, unknown>,
  override: string | null = null,
) => ({
  trace: IncomeLedger.trace(context, access.farmObjectId, null, AuditActions.CREATE, "Income Recorded"),
  log: (created: TCreated) => auditCreated(context, access, created, data, override),
});

/** POST /incomes — Manure Sale, Insurance Claim, Government Subsidy, Other. */
const createIncome = async (farmId: string, requester: string, body: TPayload, context?: TAuditContext) => {
  const { access, memberId } = await start(farmId, requester, body);
  const incomeCategory = parseEnum("incomeCategory", body.incomeCategory, CATEGORIES);
  if (!MANUAL_CATEGORIES.includes(incomeCategory)) {
    throw new AppError(status.BAD_REQUEST, `${incomeCategory} has its own workflow — it cannot be recorded here.`);
  }
  const units = CATEGORY_UNITS[incomeCategory] ?? [];
  const sale: Record<string, unknown> = { quantity: null, unit: null, unitPrice: null };
  let amount: number;
  let override: string | null = null;
  const hasQuantity = !isBlank(body.quantity) || !isBlank(body.unitPrice) || !isBlank(body.unit);
  if (hasQuantity) {
    if (!units.length) throw new AppError(status.BAD_REQUEST, `${incomeCategory} has no quantity — send amount only!`);
    const quantity = parseSaleQuantity(body.quantity);
    const unitPrice = parseAmount("unitPrice", body.unitPrice);
    const unit = units.length === 1 && isBlank(body.unit) ? units[0] : parseEnum("unit", body.unit, units);
    Object.assign(sale, { quantity, unit, unitPrice });
    ({ amount, override } = resolveAmount(access, quantity, unitPrice, body.amount, body.overrideReason));
  } else {
    amount = parseAmount("amount", body.amount);
  }
  const data = {
    farmId: access.farmObjectId,
    incomeCategory,
    amount,
    ...sale,
    ...parseCommon(body),
    referenceType: IncomeReferenceTypes.MANUAL,
    referenceId: null,
    createdBy: memberId,
  };
  await assertNotDuplicate(access.farmObjectId, data, body);
  const created = await executeAtomically((session, undo) => insert(data, session, undo), auditing(context, access, data, override));
  return IncomeLedger.detailById(access.farmObjectId, created._id);
};

/**
 * Sold liters can never exceed produced liters. The milk record is touched inside the
 * transaction, so two partial sales saved at once conflict instead of both passing.
 */
const assertMilkAvailable = async (
  access: TFinanceAccess,
  recordId: Types.ObjectId,
  liters: number,
  session: ClientSession | null,
  excludeIncomeId: Types.ObjectId | null = null,
) => {
  await MilkRecordModel.updateOne({ _id: recordId }, { $inc: { __v: 1 } }, { timestamps: false, ...sessionOpts(session) });
  const record = await MilkRecordModel.findOne({ _id: recordId, farmId: access.farmObjectId }).session(session).lean();
  if (!record) throw new AppError(status.NOT_FOUND, "Milk record not found in this farm!");
  if (record.isVoided) throw new AppError(status.CONFLICT, "This milk record was voided and cannot be sold!");
  if (record.quality === MilkQualities.REJECTED) throw new AppError(status.CONFLICT, "Rejected milk cannot be sold!");
  if (record.withdrawalFlag) {
    throw new AppError(status.CONFLICT, "This milk was produced during a medicine withdrawal period and cannot be sold!");
  }
  const sold = (await soldLitersByRecord(access.farmObjectId, [recordId], session, excludeIncomeId)).get(String(recordId)) ?? 0;
  const remaining = roundQuantity(record.quantityInLiters - sold);
  //0.01 l absorbs kg → liter rounding
  if (liters > remaining + 0.01) {
    throw new AppError(
      status.CONFLICT,
      `Only ${Math.max(0, remaining)} liter of this milk record is unsold (${record.quantityInLiters} produced, ${sold} already sold).`,
    );
  }
  return record;
};

/** POST /incomes/milk-sale — optional MilkRecord link, partial sales allowed. */
const createMilkSale = async (farmId: string, requester: string, body: TPayload, context?: TAuditContext) => {
  const { access, memberId } = await start(farmId, requester, body);
  const unit = parseEnum("unit", body.unit, CATEGORY_UNITS[IncomeCategories.MILK_SALE] ?? []);
  const quantity = parseSaleQuantity(body.quantity);
  const unitPrice = parseAmount("unitPrice", body.unitPrice);
  const { amount, override } = resolveAmount(access, quantity, unitPrice, body.amount, body.overrideReason);
  let referenceId: Types.ObjectId | null = null;
  if (!isBlank(body.milkRecordId)) {
    if (!isValidObjectId(body.milkRecordId)) throw new AppError(status.BAD_REQUEST, "milkRecordId must be a valid id!");
    referenceId = new Types.ObjectId(String(body.milkRecordId));
  }
  const data = {
    farmId: access.farmObjectId,
    incomeCategory: IncomeCategories.MILK_SALE,
    amount,
    quantity,
    unit,
    unitPrice,
    ...parseCommon(body),
    referenceType: referenceId ? IncomeReferenceTypes.MILK_RECORD : IncomeReferenceTypes.MANUAL,
    referenceId,
    createdBy: memberId,
  };
  await assertNotDuplicate(access.farmObjectId, data, body);
  const created = await executeAtomically(async (session, undo) => {
    if (referenceId) {
      const record = await assertMilkAvailable(access, referenceId, toLiters(quantity, unit), session);
      if (data.incomeDate < record.recordDate) {
        throw new AppError(status.BAD_REQUEST, "incomeDate cannot be before the milk was produced!");
      }
    }
    return insert(data, session, undo);
  }, auditing(context, access, data, override));
  return IncomeLedger.detailById(access.farmObjectId, created._id);
};

/** POST /incomes/animal-sale — Income + Animal → Sold in one unit of work. */
const createAnimalSale = async (farmId: string, requester: string, body: TPayload, context?: TAuditContext) => {
  const { access, memberId } = await start(farmId, requester, body);
  const incomeCategory = isBlank(body.incomeCategory)
    ? IncomeCategories.ANIMAL_SALE
    : parseEnum("incomeCategory", body.incomeCategory, ANIMAL_CATEGORIES);
  const amount = parseAmount("amount", body.amount);
  const backfill = parseBoolean(body.backfill);
  const markAsSold = !backfill && (isBlank(body.markAsSold) || parseBoolean(body.markAsSold));
  if (backfill) requireRole(access, FinancePermissions.CORRECT_SETTLED, "book the income of an already sold animal");

  const value = String(body.animalId ?? "").trim();
  const animal = await AnimalModel.findOne({
    ...(isValidObjectId(value)
      ? { _id: new Types.ObjectId(value) }
      : { animalCode: new RegExp(`^${escapeRegex(value)}$`, "i") }),
    farmId: access.farmObjectId,
  })
    .select("animalCode lifeStatus isActive")
    .lean();
  if (!animal) throw new AppError(status.NOT_FOUND, "Animal not found in this farm!");
  const expected = backfill ? AnimalLifeStatuses.SOLD : AnimalLifeStatuses.ACTIVE;
  if (animal.lifeStatus !== expected || (!backfill && !animal.isActive)) {
    throw new AppError(
      status.CONFLICT,
      backfill
        ? `${animal.animalCode} is ${animal.lifeStatus} — backfill is only for animals already marked Sold.`
        : `${animal.animalCode} is ${animal.lifeStatus} and cannot be sold!`,
    );
  }

  const data = {
    farmId: access.farmObjectId,
    incomeCategory,
    amount,
    quantity: 1,
    unit: IncomeUnits.PIECE,
    unitPrice: amount,
    ...parseCommon(body),
    referenceType: IncomeReferenceTypes.ANIMAL,
    referenceId: animal._id,
    createdBy: memberId,
  };
  const created = await executeAtomically(async (session, undo) => {
    //conditional write first: it both guards the status and serializes concurrent sales
    const result = await AnimalModel.updateOne(
      { _id: animal._id, farmId: access.farmObjectId, lifeStatus: expected, ...(backfill ? {} : { isActive: true }) },
      markAsSold
        ? { $set: { lifeStatus: AnimalLifeStatuses.SOLD, isActive: false, updatedBy: access.userObjectId }, $inc: { __v: 1 } }
        : { $inc: { __v: 1 } },
      { timestamps: markAsSold, ...sessionOpts(session) },
    );
    if (result.modifiedCount !== 1) {
      throw new AppError(status.CONFLICT, `${animal.animalCode} changed while saving the sale. Reload and try again.`);
    }
    if (markAsSold) {
      undo.push(() =>
        AnimalModel.updateOne({ _id: animal._id }, { $set: { lifeStatus: animal.lifeStatus, isActive: animal.isActive } }),
      );
    }
    const existing = await IncomeModel.findOne({
      farmId: access.farmObjectId,
      referenceType: IncomeReferenceTypes.ANIMAL,
      referenceId: animal._id,
      status: ACTIVE,
    })
      .select("incomeNo")
      .session(session)
      .lean();
    if (existing) throw new AppError(status.CONFLICT, `${animal.animalCode} already has a sale income (${existing.incomeNo})!`);
    return insert(data, session, undo);
  }, {
    trace: IncomeLedger.trace(context, access.farmObjectId, null, AuditActions.CREATE, "Animal Sale"),
    log: async (created) => {
      await auditCreated(context, access, created, data);
      if (!markAsSold) return;
      await recordAuditLog({
      context,
      farmId: access.farmObjectId,
      entityType: AuditEntityTypes.ANIMAL,
      entityId: animal._id,
      action: AuditActions.UPDATE,
      module: AuditModules.ANIMAL,
      event: `Animal Sold (${created.incomeNo})`,
      oldData: { lifeStatus: animal.lifeStatus, isActive: animal.isActive },
      newData: { lifeStatus: AnimalLifeStatuses.SOLD, isActive: false },
      changedFields: ["lifeStatus", "isActive"],
      });
    },
  });
  return IncomeLedger.detailById(access.farmObjectId, created._id);
};

/** POST /incomes/breeding-service — one service fee per breeding (more needs confirmation). */
const createBreedingService = async (farmId: string, requester: string, body: TPayload, context?: TAuditContext) => {
  const { access, memberId } = await start(farmId, requester, body);
  const amount = parseAmount("amount", body.amount);
  const value = String(body.breedingId ?? "").trim();
  const breeding = await BreedingModel.findOne({
    ...(isValidObjectId(value) ? { _id: new Types.ObjectId(value) } : { breedingNo: value.toUpperCase() }),
    farmId: access.farmObjectId,
  })
    .select("breedingNo")
    .lean();
  if (!breeding) throw new AppError(status.NOT_FOUND, "Breeding record not found in this farm!");
  const data = {
    farmId: access.farmObjectId,
    incomeCategory: IncomeCategories.BREEDING_SERVICE,
    amount,
    quantity: 1,
    unit: IncomeUnits.SERVICE,
    unitPrice: amount,
    ...parseCommon(body),
    referenceType: IncomeReferenceTypes.BREEDING,
    referenceId: breeding._id,
    createdBy: memberId,
  };
  const created = await executeAtomically(async (session, undo) => {
    await BreedingModel.updateOne({ _id: breeding._id }, { $inc: { __v: 1 } }, { timestamps: false, ...sessionOpts(session) });
    const existing = parseBoolean(body.confirmDuplicate)
      ? null
      : await IncomeModel.findOne({
          farmId: access.farmObjectId,
          referenceType: IncomeReferenceTypes.BREEDING,
          referenceId: breeding._id,
          status: ACTIVE,
        })
          .select("incomeNo")
          .session(session)
          .lean();
    if (existing) {
      throw new AppError(
        status.CONFLICT,
        `Possible duplicate: ${breeding.breedingNo} already has ${existing.incomeNo}. Resend with confirmDuplicate: true if this is another fee.`,
      );
    }
    return insert(data, session, undo);
  }, auditing(context, access, data));
  return IncomeLedger.detailById(access.farmObjectId, created._id);
};

/* -------------------------------------------------------------------------- */
/*                            Controlled update                               */
/* -------------------------------------------------------------------------- */

const FINANCIAL_FIELDS = ["amount", "quantity", "unitPrice", "incomeCategory", "incomeDate", "paymentMethod"];

const updateIncome = async (farmId: string, ref: string, requester: string, body: TPayload, context?: TAuditContext) => {
  const access = await IncomeLedger.access(farmId, requester, "update income", true);
  const memberId = requireWriter(access);
  rejectServerFields(body);
  const row = await IncomeLedger.find(access, ref);
  if (row.status === IncomeStatuses.CANCELLED) {
    throw new AppError(status.CONFLICT, "A Cancelled income can no longer be changed!");
  }

  const next: Record<string, unknown> = {};
  if ("customerName" in body) next.customerName = parseText("customerName", body.customerName, MAX_PARTY);
  if ("customerPhone" in body) next.customerPhone = parsePhone(body.customerPhone);
  if ("invoiceNumber" in body) next.invoiceNumber = parseText("invoiceNumber", body.invoiceNumber, MAX_INVOICE);
  if ("description" in body) {
    next.description = withDescriptionText(row.description, parseDescription(body.description)) || null;
  }
  if ("incomeDate" in body) next.incomeDate = parseBusinessDate("incomeDate", body.incomeDate);
  if ("paymentMethod" in body) next.paymentMethod = parseEnum("paymentMethod", body.paymentMethod, METHODS);

  const single = ANIMAL_CATEGORIES.includes(String(row.incomeCategory)) || row.incomeCategory === IncomeCategories.BREEDING_SERVICE;
  if ("incomeCategory" in body) {
    const category = parseEnum("incomeCategory", body.incomeCategory, CATEGORIES);
    //a category may only move inside its own family; anything else is another workflow
    const family = [ANIMAL_CATEGORIES, MANUAL_CATEGORIES].find((group) => group.includes(String(row.incomeCategory))) ?? [
      String(row.incomeCategory),
    ];
    if (!family.includes(category)) {
      throw new AppError(status.BAD_REQUEST, `incomeCategory can only change to: ${family.join(", ")}!`);
    }
    if (row.unit && !(CATEGORY_UNITS[category] ?? []).includes(String(row.unit))) {
      throw new AppError(status.BAD_REQUEST, `${category} cannot be measured in ${String(row.unit)}!`);
    }
    next.incomeCategory = category;
  }

  if (single) {
    //one animal / one service: quantity stays 1 and the unit price follows the amount
    if ("quantity" in body && parseSaleQuantity(body.quantity) !== row.quantity) {
      throw new AppError(status.BAD_REQUEST, "quantity is always 1 for this income!");
    }
    if ("amount" in body || "unitPrice" in body) {
      const amount = parseAmount("amount", "amount" in body ? body.amount : body.unitPrice);
      next.amount = amount;
      next.unitPrice = amount;
    }
  } else if (row.quantity != null && row.unitPrice != null) {
    if ("quantity" in body || "unitPrice" in body || "amount" in body) {
      const quantity = "quantity" in body ? parseSaleQuantity(body.quantity) : (row.quantity as number);
      const unitPrice = "unitPrice" in body ? parseAmount("unitPrice", body.unitPrice) : (row.unitPrice as number);
      //an unchanged quantity and price keep an earlier override
      const priceChanged = quantity !== row.quantity || unitPrice !== row.unitPrice;
      const sent = "amount" in body ? body.amount : priceChanged ? undefined : row.amount;
      if (priceChanged || ("amount" in body && Number(body.amount) !== row.amount)) {
        next.amount = resolveAmount(access, quantity, unitPrice, sent, body.reason).amount;
      }
      next.quantity = quantity;
      next.unitPrice = unitPrice;
    }
  } else {
    if ("quantity" in body || "unitPrice" in body) {
      throw new AppError(status.BAD_REQUEST, "This income has no quantity — correct its amount instead!");
    }
    if ("amount" in body) next.amount = parseAmount("amount", body.amount);
  }

  const same = (a: unknown, b: unknown) =>
    (a instanceof Date ? a.getTime() : (a ?? null)) === (b instanceof Date ? b.getTime() : (b ?? null));
  const changed = Object.keys(next).filter((key) => !same(next[key], row[key]));
  if (!changed.length) {
    return { mode: "unchanged" as const, changedFields: changed, income: await IncomeLedger.detailById(access.farmObjectId, row._id) };
  }
  let reason: string | null = parseText("reason", body.reason, 200);
  if (changed.some((key) => FINANCIAL_FIELDS.includes(key))) {
    if (row.status === IncomeStatuses.RECEIVED) {
      requireRole(access, FinancePermissions.CORRECT_SETTLED, "correct a Received income");
    }
    reason = requireReason(body.reason, "correct financial values");
  }

  const pick = (source: Record<string, unknown>) => Object.fromEntries(changed.map((key) => [key, source[key] ?? null]));
  const milkId = row.referenceType === IncomeReferenceTypes.MILK_RECORD ? (row.referenceId ?? null) : null;
  await executeAtomically(async (session, undo) => {
    if (milkId && changed.includes("quantity")) {
      await assertMilkAvailable(access, milkId, toLiters(next.quantity as number, row.unit as string), session, row._id);
    }
    if (milkId && changed.includes("incomeDate")) {
      const record = await MilkRecordModel.findById(milkId).select("recordDate").session(session).lean();
      if (record && (next.incomeDate as Date) < record.recordDate) {
        throw new AppError(status.BAD_REQUEST, "incomeDate cannot be before the milk was produced!");
      }
    }
    await IncomeLedger.write(access, row, pick(next), memberId, session);
    undo.push(() => IncomeModel.updateOne({ _id: row._id }, { $set: pick(row) }));
  }, {
    trace: IncomeLedger.trace(context, access.farmObjectId, row._id, AuditActions.UPDATE, "Income Updated"),
    log: async () => {
      await IncomeLedger.audit(
        context,
        access.farmObjectId,
        row._id,
        AuditActions.UPDATE,
        changed.some((key) => FINANCIAL_FIELDS.includes(key)) ? "Income Corrected" : "Income Updated",
        pick(row),
        { ...pick(next), ...(reason ? { reason } : {}) },
        changed,
      );
    },
  });
  return { mode: "updated" as const, changedFields: changed, income: await IncomeLedger.detailById(access.farmObjectId, row._id) };
};

/* -------------------------------------------------------------------------- */
/*                     Meta, pickers, reports, reconciliation                  */
/* -------------------------------------------------------------------------- */

const getMeta = async (farmId: string, requester: string) => {
  const access = await IncomeLedger.access(farmId, requester, "view income");
  const active = access.farmStatus === "Active";
  return {
    categories: CATEGORIES,
    manualCategories: MANUAL_CATEGORIES,
    categoryUnits: CATEGORY_UNITS,
    paymentMethods: METHODS,
    referenceTypes: REFERENCE_TYPES,
    units: Object.values(IncomeUnits),
    statuses: Object.values(IncomeStatuses),
    milkKgPerLiter: MILK_KG_PER_LITER,
    permissions: {
      role: access.role,
      write: active && can(access, FinancePermissions.WRITE),
      correctSettled: active && can(access, FinancePermissions.CORRECT_SETTLED),
      overrideAmount: active && can(access, FinancePermissions.OVERRIDE_AMOUNT),
    },
  };
};

/** GET /incomes/reference-options?referenceType=&searchTerm= — rows for the sale forms. */
const getReferenceOptions = async (farmId: string, requester: string, query: TPayload) => {
  const access = await IncomeLedger.access(farmId, requester, "record income", true);
  const type = parseEnum("referenceType", query.referenceType, [
    IncomeReferenceTypes.MILK_RECORD,
    IncomeReferenceTypes.ANIMAL,
    IncomeReferenceTypes.BREEDING,
  ]);
  const term = isBlank(query.searchTerm)
    ? null
    : new RegExp(escapeRegex(String(query.searchTerm).trim().slice(0, 100)), "i");
  const farmObjectId = access.farmObjectId;

  if (type === IncomeReferenceTypes.ANIMAL) {
    const sold = parseBoolean(query.sold);
    const booked = await IncomeModel.distinct("referenceId", {
      farmId: farmObjectId,
      referenceType: IncomeReferenceTypes.ANIMAL,
      status: ACTIVE,
    });
    return AnimalModel.find({
      farmId: farmObjectId,
      _id: { $nin: booked },
      ...(sold ? { lifeStatus: AnimalLifeStatuses.SOLD } : { lifeStatus: AnimalLifeStatuses.ACTIVE, isActive: true }),
      ...(term ? { $or: [{ animalCode: term }, { name: term }, { tagNumber: term }] } : {}),
    })
      .sort({ animalCode: 1 })
      .limit(REFERENCE_OPTION_LIMIT)
      .select("animalCode name gender reproductiveStatus currentWeight lifeStatus")
      .lean();
  }

  //animal code / name search for the two animal-owned record types
  const animalFilter = term
    ? {
        animalId: {
          $in: await AnimalModel.find({ farmId: farmObjectId, $or: [{ animalCode: term }, { name: term }] }).distinct("_id"),
        },
      }
    : {};

  if (type === IncomeReferenceTypes.BREEDING) {
    return BreedingModel.find({ farmId: farmObjectId, ...(term ? { $or: [{ breedingNo: term }, animalFilter] } : {}) })
      .sort({ heatDetectedDate: -1 })
      .limit(REFERENCE_OPTION_LIMIT)
      .select("breedingNo breedingMethod heatDetectedDate inseminationDate pregnancyResult animalId")
      .populate({ path: "animalId", select: "animalCode name" })
      .lean();
  }

  const records = await MilkRecordModel.find({
    farmId: farmObjectId,
    isVoided: false,
    withdrawalFlag: false,
    quality: { $ne: MilkQualities.REJECTED },
    quantityInLiters: { $gt: 0 },
    ...animalFilter,
  })
    .sort({ recordDate: -1, createdAt: -1 })
    //some of the latest rows may already be sold out
    .limit(REFERENCE_OPTION_LIMIT * 4)
    .select("animalId recordDate milkingSession quantityInLiters quality")
    .populate({ path: "animalId", select: "animalCode name" })
    .lean();
  const sold = await soldLitersByRecord(farmObjectId, records.map((row) => row._id));
  return records
    .map((row) => ({
      ...row,
      soldLiters: sold.get(String(row._id)) ?? 0,
      remainingLiters: roundQuantity(Math.max(0, row.quantityInLiters - (sold.get(String(row._id)) ?? 0))),
    }))
    .filter((row) => row.remainingLiters > 0)
    .slice(0, REFERENCE_OPTION_LIMIT);
};

/** Produced vs sold milk of one period (spec 22 §83–84). */
const milkComparison = async (farmObjectId: Types.ObjectId, from: Date, end: Date) => {
  const [produced, sales] = await Promise.all([
    MilkRecordModel.aggregate<{ liters: number; saleable: number }>([
      { $match: { farmId: farmObjectId, isVoided: false, recordDate: { $gte: from, $lte: end } } },
      {
        $group: {
          _id: null,
          liters: { $sum: "$quantityInLiters" },
          saleable: {
            $sum: {
              $cond: [
                { $and: [{ $ne: ["$quality", MilkQualities.REJECTED] }, { $ne: ["$withdrawalFlag", true] }] },
                "$quantityInLiters",
                0,
              ],
            },
          },
        },
      },
    ]),
    IncomeModel.find({
      farmId: farmObjectId,
      incomeCategory: IncomeCategories.MILK_SALE,
      status: ACTIVE,
      incomeDate: { $gte: from, $lte: end },
    })
      .select("quantity unit amount")
      .lean(),
  ]);
  const soldLiters = roundQuantity(sales.reduce((sum, row) => sum + toLiters(row.quantity ?? 0, row.unit), 0));
  const revenue = roundMoney(sales.reduce((sum, row) => sum + row.amount, 0));
  const saleable = roundQuantity(produced[0]?.saleable ?? 0);
  return {
    producedLiters: roundQuantity(produced[0]?.liters ?? 0),
    saleableLiters: saleable,
    soldLiters,
    unsoldLiters: roundQuantity(Math.max(0, saleable - soldLiters)),
    revenue,
    averagePricePerLiter: soldLiters > 0 ? roundMoney(revenue / soldLiters) : null,
    //farm-wide warning: includes sales that are not linked to a milk record
    oversold: soldLiters > saleable + 0.01,
  };
};

const getSummary = async (farmId: string, requester: string, query: TPayload) => {
  const access = await IncomeLedger.access(farmId, requester, "view income reports");
  const { from, end } = IncomeLedger.reportRange(query);
  const [summary, milk] = await Promise.all([
    IncomeLedger.summaryFor(access.farmObjectId, query),
    milkComparison(access.farmObjectId, from, end),
  ]);
  return { ...summary, milk };
};

/** GET /incomes/reconciliation — warnings for review, nothing is changed (spec 22 §89–91). */
const getReconciliation = async (farmId: string, requester: string) => {
  const access = await IncomeLedger.access(farmId, requester, "view finance reconciliation");
  const farmObjectId = access.farmObjectId;
  const linked = await IncomeModel.find({
    farmId: farmObjectId,
    status: ACTIVE,
    referenceType: { $in: [IncomeReferenceTypes.ANIMAL, IncomeReferenceTypes.MILK_RECORD] },
  })
    .select("incomeNo amount incomeDate status referenceType referenceId")
    .lean();
  const idsOf = (type: string) =>
    linked.filter((row) => row.referenceType === type && row.referenceId).map((row) => row.referenceId as Types.ObjectId);
  const animalIds = idsOf(IncomeReferenceTypes.ANIMAL);
  const milkIds = [...new Map(idsOf(IncomeReferenceTypes.MILK_RECORD).map((id) => [String(id), id])).values()];

  const missingFilter = { farmId: farmObjectId, lifeStatus: AnimalLifeStatuses.SOLD, _id: { $nin: animalIds } };
  const [missingCount, missing, animals, records, sold] = await Promise.all([
    AnimalModel.countDocuments(missingFilter),
    AnimalModel.find(missingFilter).limit(RECONCILIATION_LIMIT).select("animalCode name updatedAt").lean(),
    AnimalModel.find({ _id: { $in: animalIds }, farmId: farmObjectId }).select("animalCode lifeStatus").lean(),
    MilkRecordModel.find({ _id: { $in: milkIds }, farmId: farmObjectId })
      .select("recordDate milkingSession quantityInLiters isVoided quality withdrawalFlag animalId")
      .populate({ path: "animalId", select: "animalCode" })
      .lean(),
    soldLitersByRecord(farmObjectId, milkIds),
  ]);
  const animalById = new Map(animals.map((row) => [String(row._id), row]));
  const notSold = linked
    .filter(
      (row) =>
        row.referenceType === IncomeReferenceTypes.ANIMAL &&
        animalById.get(String(row.referenceId))?.lifeStatus !== AnimalLifeStatuses.SOLD,
    )
    .map((row) => ({
      _id: row._id,
      incomeNo: row.incomeNo,
      amount: row.amount,
      incomeDate: row.incomeDate,
      status: row.status,
      animalId: row.referenceId,
      animalCode: animalById.get(String(row.referenceId))?.animalCode ?? null,
      lifeStatus: animalById.get(String(row.referenceId))?.lifeStatus ?? null,
    }));
  const milkIssues = records
    .map((row) => ({
      milkRecordId: row._id,
      animalCode: (row.animalId as unknown as { animalCode?: string } | null)?.animalCode ?? null,
      recordDate: row.recordDate,
      milkingSession: row.milkingSession,
      producedLiters: row.quantityInLiters,
      soldLiters: sold.get(String(row._id)) ?? 0,
      issue: row.isVoided
        ? "voided"
        : row.quality === MilkQualities.REJECTED || row.withdrawalFlag
          ? "not-saleable"
          : (sold.get(String(row._id)) ?? 0) > row.quantityInLiters + 0.01
            ? "oversold"
            : null,
    }))
    .filter((row) => row.issue);
  return {
    balanced: !missingCount && !notSold.length && !milkIssues.length,
    soldAnimalsWithoutIncome: { count: missingCount, rows: missing },
    incomesOfUnsoldAnimals: { count: notSold.length, rows: notSold.slice(0, RECONCILIATION_LIMIT) },
    milkIssues: { count: milkIssues.length, rows: milkIssues.slice(0, RECONCILIATION_LIMIT) },
  };
};

/**
 * GET /farms/:farmId/finance/profit-loss — cash basis: Received income − Paid expense.
 * Pending money is reported next to it and never mixed into the profit.
 */
const getProfitLoss = async (farmId: string, requester: string, query: TPayload) => {
  const access = await IncomeLedger.access(farmId, requester, "view the profit / loss report");
  const [income, expense] = await Promise.all([
    IncomeLedger.summaryFor(access.farmObjectId, query),
    ExpenseLedger.summaryFor(access.farmObjectId, query),
  ]);
  const net = (a: number, b: number) => roundMoney(a - b);
  return {
    basis: "cash",
    range: income.range,
    income: income.totals,
    expense: expense.totals,
    netProfit: net(income.totals.settled.amount, expense.totals.settled.amount),
    //if every pending amount of the period were settled
    projectedNet: net(income.totals.recorded.amount, expense.totals.recorded.amount),
    previousNetProfit: net(income.previousPeriod.totals.settled.amount, expense.previousPeriod.totals.settled.amount),
    receivables: income.outstandingAllTime,
    payables: expense.outstandingAllTime,
    incomeByCategory: income.byCategory,
    expenseByCategory: expense.byCategory,
    byMonth: income.byMonth.map((month, index) => {
      const spent = expense.byMonth[index]?.settled ?? 0;
      return { month: month.month, income: month.settled, expense: spent, net: net(month.settled, spent) };
    }),
  };
};

export const IncomeServices = {
  createIncome,
  createMilkSale,
  createAnimalSale,
  createBreedingService,
  updateIncome,
  getMeta,
  getReferenceOptions,
  getSummary,
  getReconciliation,
  getProfitLoss,
};
