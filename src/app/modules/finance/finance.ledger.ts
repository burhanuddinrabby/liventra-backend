import status from "http-status";
import { isValidObjectId, Types } from "mongoose";
import type { Model } from "mongoose";
import AppError from "../../errors/AppError.js";
import { AuditActions, AuditModules } from "../auditLog/auditLog.constants.js";
import type { TAuditAction, TAuditEntityType } from "../auditLog/auditLog.interface.js";
import { AuditLogModel } from "../auditLog/auditLog.model.js";
import { recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext } from "../auditLog/auditLog.utils.js";
import {
  DAY_MS,
  dayKey,
  escapeRegex,
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
import type { TPayload } from "../feedRecord/feedRecord.utils.js";
import { roundMoney } from "../inventory/inventory.utils.js";
import { FinancePermissions, MAX_AMOUNT, MAX_LIST_LIMIT, MAX_REASON, PaymentMethods } from "./finance.constants.js";
import {
  appendTrail,
  discardAttachment,
  parseBusinessDate,
  parseText,
  readAttachment,
  requireReason,
  requireRole,
  requireWriter,
  resolveFinanceAccess,
  saveAttachment,
  splitDescription,
} from "./finance.utils.js";
import type { TFinanceAccess } from "./finance.utils.js";

// Expense and Income share one life cycle (Pending → settled, or → Cancelled; never
// deleted; every change audited). This file holds that shared behaviour once; the two
// modules add their own creation workflows, corrections and reconciliation.

const METHODS = Object.values(PaymentMethods) as string[];
const PENDING = "Pending";
const CANCELLED = "Cancelled";

export type TFinanceRow = Record<string, unknown> & {
  _id: Types.ObjectId;
  farmId: Types.ObjectId;
  amount: number;
  status: string;
  paymentMethod: string;
  referenceType?: string | null;
  referenceId?: Types.ObjectId | null;
  description?: string | null;
  attachment?: string | null;
  updatedAt: Date;
};

/** What the list / detail shows about the operational record behind an entry. */
export type TReferenceView = { type: string; _id: Types.ObjectId; label: string; details?: Record<string, unknown> };

export type TLedgerConfig = {
  //"expense" / "income", used in messages
  name: string;
  noField: "expenseNo" | "incomeNo";
  noPattern: RegExp;
  noExample: string;
  dateField: "expenseDate" | "incomeDate";
  categoryField: "expenseCategory" | "incomeCategory";
  partyField: "paidTo" | "customerName";
  categories: readonly string[];
  referenceTypes: readonly string[];
  settledStatus: "Paid" | "Received";
  searchFields: readonly string[];
  entityType: TAuditEntityType;
  model: unknown;
  // eslint-disable-next-line no-unused-vars
  describeReferences: (farmObjectId: Types.ObjectId, rows: TFinanceRow[], detail: boolean) => Promise<Map<string, TReferenceView>>;
  /** Extra text on cancel when a linked record needs an explicit operational review. */
  // eslint-disable-next-line no-unused-vars
  cancelReview: (row: TFinanceRow) => Promise<Record<string, unknown> | null>;
};

const MEMBER_POPULATE = { select: "role userId", populate: { path: "userId", select: "userId fullName" } };

export const createLedger = (config: TLedgerConfig) => {
  const rows = config.model as Model<Record<string, unknown>>;
  const STATUSES = [PENDING, config.settledStatus, CANCELLED];
  const Label = config.name[0]!.toUpperCase() + config.name.slice(1);

  const access = (farmId: string, requester: string, action: string, write = false) =>
    resolveFinanceAccess(farmId, requester, write ? FinancePermissions.WRITE : FinancePermissions.READ, action);

  /** _id or display number, always farm-scoped. */
  const find = async (scope: TFinanceAccess, ref: string): Promise<TFinanceRow> => {
    const value = String(ref ?? "").trim();
    if (!isValidObjectId(value) && !config.noPattern.test(value)) {
      throw new AppError(status.BAD_REQUEST, `Use ${config.name} _id or a number like ${config.noExample}!`);
    }
    const filter = isValidObjectId(value)
      ? { _id: new Types.ObjectId(value) }
      : { [config.noField]: value.toUpperCase() };
    const row = await rows.findOne({ ...filter, farmId: scope.farmObjectId }).lean();
    if (!row) throw new AppError(status.NOT_FOUND, `${Label} not found in this farm!`);
    return row as unknown as TFinanceRow;
  };

  /** Never exposes the stored file path; splits the server's notes from the user's text. */
  const present = (row: TFinanceRow, references: Map<string, TReferenceView>) => {
    const { attachment, description, __v, ...rest } = row as TFinanceRow & { __v?: number };
    void __v;
    const { text, trail } = splitDescription(description);
    return {
      ...rest,
      description: text || null,
      notes: trail,
      hasAttachment: Boolean(attachment),
      reference: row.referenceId ? (references.get(String(row.referenceId)) ?? null) : null,
    };
  };

  const detailById = async (farmObjectId: Types.ObjectId, id: Types.ObjectId) => {
    const row = (await rows
      .findOne({ _id: id, farmId: farmObjectId })
      .populate({ path: "createdBy", ...MEMBER_POPULATE })
      .populate({ path: "updatedBy", ...MEMBER_POPULATE })
      .lean()) as unknown as TFinanceRow | null;
    if (!row) throw new AppError(status.NOT_FOUND, `${Label} not found in this farm!`);
    return present(row, await config.describeReferences(farmObjectId, [row], true));
  };

  const audit = (
    context: TAuditContext | undefined,
    farmObjectId: Types.ObjectId,
    id: Types.ObjectId,
    action: TAuditAction,
    event: string,
    oldData: Record<string, unknown> | null,
    newData: Record<string, unknown> | null,
    changedFields: string[] = [],
  ) =>
    recordAuditLog({
      context,
      farmId: farmObjectId,
      entityType: config.entityType,
      entityId: id,
      action,
      module: AuditModules.FINANCE,
      event,
      oldData,
      newData,
      changedFields,
    });

  /**
   * Optimistic write: refused when anybody touched the entry since it was read, so a
   * double click can never settle or cancel twice.
   */
  const write = async (
    scope: TFinanceAccess,
    row: TFinanceRow,
    set: Record<string, unknown>,
    memberId: Types.ObjectId,
    session: import("mongoose").ClientSession | null = null,
  ) => {
    const result = await rows.updateOne(
      { _id: row._id, farmId: scope.farmObjectId, status: row.status, updatedAt: row.updatedAt },
      { $set: { ...set, updatedBy: memberId } },
      { runValidators: true, ...(session ? { session } : {}) },
    );
    if (result.modifiedCount !== 1) {
      throw new AppError(status.CONFLICT, `The ${config.name} was changed by someone else; reload and try again.`);
    }
  };

  /* ------------------------------- list ---------------------------------- */

  const list = async (farmId: string, requester: string, query: TPayload) => {
    const scope = await access(farmId, requester, `view ${config.name} records`);
    const filter: Record<string, unknown> = {
      farmId: scope.farmObjectId,
      ...parseDateRange(query, config.dateField),
    };
    const enumFilter = (field: string, allowed: readonly string[]) => {
      if (!isBlank(query[field])) filter[field] = { $in: parseEnumList(field, query[field], allowed) };
    };
    enumFilter(config.categoryField, config.categories);
    enumFilter("status", STATUSES);
    enumFilter("paymentMethod", METHODS);
    enumFilter("referenceType", config.referenceTypes);

    for (const field of [config.partyField, "invoiceNumber"]) {
      if (!isBlank(query[field])) filter[field] = new RegExp(escapeRegex(String(query[field]).trim().slice(0, 100)), "i");
    }
    if (!isBlank(query.referenceId)) {
      const value = String(query.referenceId);
      if (!isValidObjectId(value)) throw new AppError(status.BAD_REQUEST, "referenceId must be a valid id!");
      filter.referenceId = new Types.ObjectId(value);
    }
    if (!isBlank(query.hasAttachment)) {
      filter.attachment = parseBoolean(query.hasAttachment) ? { $nin: [null, ""] } : { $in: [null, ""] };
    }
    const amount: Record<string, number> = {};
    if (!isBlank(query.minAmount)) amount.$gte = parseNumber("minAmount", query.minAmount, { min: 0, max: MAX_AMOUNT });
    if (!isBlank(query.maxAmount)) amount.$lte = parseNumber("maxAmount", query.maxAmount, { min: 0, max: MAX_AMOUNT });
    if (Object.keys(amount).length) filter.amount = amount;
    if (!isBlank(query.searchTerm)) {
      const term = new RegExp(escapeRegex(String(query.searchTerm).trim().slice(0, 100)), "i");
      filter.$or = config.searchFields.map((field) => ({ [field]: term }));
    }

    //-date first; createdAt resolves ties (spec 21 §122)
    const sortable = [config.dateField, "amount", "createdAt", "status", config.categoryField];
    const requested = isBlank(query.sort) ? `-${config.dateField}` : String(query.sort);
    const field = requested.replace(/^-/, "");
    parseEnum("sort", field, sortable);
    const direction = requested.startsWith("-") ? -1 : 1;

    const { page, limit, skip } = parsePaging(query, MAX_LIST_LIMIT, 20);
    const [total, found, totals] = await Promise.all([
      rows.countDocuments(filter),
      rows
        .find(filter)
        .sort({ [field]: direction, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({ path: "createdBy", ...MEMBER_POPULATE })
        .lean(),
      rows.aggregate<{ _id: string; count: number; amount: number }>([
        { $match: filter },
        { $group: { _id: "$status", count: { $sum: 1 }, amount: { $sum: "$amount" } } },
      ]),
    ]);
    const data = found as unknown as TFinanceRow[];
    const references = await config.describeReferences(scope.farmObjectId, data, false);
    return {
      meta: pageMeta(page, limit, total),
      data: { items: data.map((row) => present(row, references)), totals: statusTotals(totals) },
    };
  };

  /** Settled, pending and cancelled money are never mixed. */
  const statusTotals = (groups: { _id: string; count: number; amount: number }[]) => {
    const of = (name: string) => {
      const group = groups.find((entry) => entry._id === name);
      return { count: group?.count ?? 0, amount: roundMoney(group?.amount ?? 0) };
    };
    const settled = of(config.settledStatus);
    const pending = of(PENDING);
    return {
      settled,
      pending,
      //active money = settled + pending; cancelled never counts
      recorded: { count: settled.count + pending.count, amount: roundMoney(settled.amount + pending.amount) },
      cancelled: of(CANCELLED),
    };
  };

  /* ------------------------------ summary -------------------------------- */

  /** Business-date range of a report; defaults to the current month. */
  const reportRange = (query: TPayload) => {
    const now = new Date();
    const today = parseCalendarDate("to", now.toISOString());
    const to = isBlank(query.to) ? today : parseCalendarDate("to", query.to);
    const from = isBlank(query.from)
      ? new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1))
      : parseCalendarDate("from", query.from);
    if (from > to) throw new AppError(status.BAD_REQUEST, "from must be before to!");
    return { from, to, end: new Date(to.getTime() + DAY_MS - 1) };
  };

  const totalsBetween = async (farmObjectId: Types.ObjectId, from: Date, end: Date) =>
    statusTotals(
      await rows.aggregate<{ _id: string; count: number; amount: number }>([
        { $match: { farmId: farmObjectId, [config.dateField]: { $gte: from, $lte: end } } },
        { $group: { _id: "$status", count: { $sum: 1 }, amount: { $sum: "$amount" } } },
      ]),
    );

  /** Last 12 months up to `to`, so a one-month report still shows a trend. */
  const monthlyTrend = async (farmObjectId: Types.ObjectId, to: Date) => {
    const start = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 11, 1));
    const groups = await rows.aggregate<{ _id: string; settled: number; pending: number; count: number }>([
      {
        $match: {
          farmId: farmObjectId,
          status: { $ne: CANCELLED },
          [config.dateField]: { $gte: start, $lte: new Date(to.getTime() + DAY_MS - 1) },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m", date: `$${config.dateField}` } },
          settled: { $sum: { $cond: [{ $eq: ["$status", config.settledStatus] }, "$amount", 0] } },
          pending: { $sum: { $cond: [{ $eq: ["$status", PENDING] }, "$amount", 0] } },
          count: { $sum: 1 },
        },
      },
    ]);
    return Array.from({ length: 12 }, (_, index) => {
      const month = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1)).toISOString().slice(0, 7);
      const group = groups.find((entry) => entry._id === month);
      const settled = roundMoney(group?.settled ?? 0);
      const pending = roundMoney(group?.pending ?? 0);
      return { month, settled, pending, recorded: roundMoney(settled + pending), count: group?.count ?? 0 };
    });
  };

  const breakdown = async (farmObjectId: Types.ObjectId, from: Date, end: Date, field: string) => {
    const groups = await rows.aggregate<{ _id: string | null; count: number; settled: number; pending: number }>([
      {
        $match: { farmId: farmObjectId, status: { $ne: CANCELLED }, [config.dateField]: { $gte: from, $lte: end } },
      },
      {
        $group: {
          _id: `$${field}`,
          count: { $sum: 1 },
          settled: { $sum: { $cond: [{ $eq: ["$status", config.settledStatus] }, "$amount", 0] } },
          pending: { $sum: { $cond: [{ $eq: ["$status", PENDING] }, "$amount", 0] } },
        },
      },
    ]);
    const total = groups.reduce((sum, group) => sum + group.settled + group.pending, 0);
    return groups
      .map((group) => ({
        key: group._id,
        count: group.count,
        settled: roundMoney(group.settled),
        pending: roundMoney(group.pending),
        recorded: roundMoney(group.settled + group.pending),
        share: total > 0 ? roundMoney(((group.settled + group.pending) / total) * 100) : 0,
      }))
      .sort((a, b) => b.recorded - a.recorded);
  };

  const summaryFor = async (farmObjectId: Types.ObjectId, query: TPayload) => {
    const { from, to, end } = reportRange(query);
    //the period of the same length right before this one
    const previousEnd = new Date(from.getTime() - 1);
    const previousFrom = new Date(from.getTime() - (to.getTime() - from.getTime() + DAY_MS));
    const [totals, previous, byCategory, byPaymentMethod, byParty, byMonth, outstanding] = await Promise.all([
      totalsBetween(farmObjectId, from, end),
      totalsBetween(farmObjectId, previousFrom, previousEnd),
      breakdown(farmObjectId, from, end, config.categoryField),
      breakdown(farmObjectId, from, end, "paymentMethod"),
      breakdown(farmObjectId, from, end, config.partyField),
      monthlyTrend(farmObjectId, to),
      //everything still unpaid, whatever its date
      rows.aggregate<{ count: number; amount: number; oldest: Date }>([
        { $match: { farmId: farmObjectId, status: PENDING } },
        { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$amount" }, oldest: { $min: `$${config.dateField}` } } },
      ]),
    ]);
    const open = outstanding[0];
    return {
      range: { from: dayKey(from), to: dayKey(to) },
      totals,
      previousPeriod: { range: { from: dayKey(previousFrom), to: dayKey(previousEnd) }, totals: previous },
      outstandingAllTime: {
        count: open?.count ?? 0,
        amount: roundMoney(open?.amount ?? 0),
        oldestDate: open ? dayKey(open.oldest) : null,
      },
      byCategory,
      byPaymentMethod,
      topParties: byParty.filter((group) => group.key).slice(0, 10),
      byMonth,
    };
  };

  const summary = async (farmId: string, requester: string, query: TPayload) => {
    const scope = await access(farmId, requester, `view ${config.name} reports`);
    return summaryFor(scope.farmObjectId, query);
  };

  /* ------------------------------- detail -------------------------------- */

  const AUDIT_SELECT = "logNo action event oldData newData changedFields status createdAt userId";

  const detail = async (farmId: string, ref: string, requester: string) => {
    const scope = await access(farmId, requester, `view ${config.name} records`);
    const row = await find(scope, ref);
    const [entry, recentChanges] = await Promise.all([
      detailById(scope.farmObjectId, row._id),
      AuditLogModel.find({ farmId: scope.farmObjectId, entityType: config.entityType, entityId: row._id })
        .sort({ createdAt: -1 })
        .limit(5)
        //never expose IP / user agent to farm users
        .select(AUDIT_SELECT)
        .populate("userId", "userId fullName")
        .lean(),
    ]);
    return { ...entry, recentChanges };
  };

  const auditLogs = async (farmId: string, ref: string, requester: string, query: TPayload) => {
    const scope = await access(farmId, requester, `view ${config.name} history`);
    const row = await find(scope, ref);
    const { page, limit, skip } = parsePaging(query, MAX_LIST_LIMIT, 20);
    const filter = { farmId: scope.farmObjectId, entityType: config.entityType, entityId: row._id };
    const [total, data] = await Promise.all([
      AuditLogModel.countDocuments(filter),
      AuditLogModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select(AUDIT_SELECT)
        .populate("userId", "userId fullName")
        .lean(),
    ]);
    return { meta: pageMeta(page, limit, total), data };
  };

  /* --------------------------- life cycle -------------------------------- */

  /** Pending → Paid / Received. The date and remarks live in the notes and the AuditLog. */
  const settle = async (farmId: string, ref: string, requester: string, body: TPayload, context?: TAuditContext) => {
    const verb = config.settledStatus === "Paid" ? "pay" : "receive";
    const scope = await access(farmId, requester, `${verb} ${config.name} records`, true);
    const memberId = requireWriter(scope);
    const row = await find(scope, ref);
    if (row.status !== PENDING) {
      throw new AppError(status.CONFLICT, `${String(row[config.noField])} is already ${row.status}!`);
    }
    const paymentMethod = parseEnum("paymentMethod", body.paymentMethod, METHODS);
    const paymentDate = parseBusinessDate("paymentDate", body.paymentDate);
    if (paymentDate < (row[config.dateField] as Date)) {
      throw new AppError(status.BAD_REQUEST, `paymentDate cannot be before the ${config.dateField}!`);
    }
    const remarks = parseText("remarks", body.remarks, MAX_REASON)?.replace(/\s+/g, " ") ?? "";
    const party = parseText(config.partyField, body[config.partyField], 120) ?? (row[config.partyField] as string | null);
    if (config.settledStatus === "Paid" && !party) {
      throw new AppError(status.BAD_REQUEST, "paidTo is required to record a payment — say who received the money!");
    }
    const set: Record<string, unknown> = {
      status: config.settledStatus,
      paymentMethod,
      description: appendTrail(row.description, config.settledStatus, paymentDate, `${paymentMethod}${remarks ? ` — ${remarks}` : ""}`),
      ...(party ? { [config.partyField]: party } : {}),
    };
    await write(scope, row, set, memberId);
    const changedFields = ["status", "paymentMethod", config.partyField].filter((key) => key in set && set[key] !== row[key]);
    await audit(
      context,
      scope.farmObjectId,
      row._id,
      AuditActions.UPDATE,
      `${Label} ${config.settledStatus}`,
      { status: row.status, paymentMethod: row.paymentMethod, [config.partyField]: row[config.partyField] ?? null },
      {
        status: config.settledStatus,
        paymentMethod,
        [config.partyField]: party ?? null,
        paymentDate: dayKey(paymentDate),
        ...(remarks ? { remarks } : {}),
      },
      changedFields,
    );
    return detailById(scope.farmObjectId, row._id);
  };

  /** → Cancelled. The linked operational record is never touched, only flagged for review. */
  const cancel = async (farmId: string, ref: string, requester: string, body: TPayload, context?: TAuditContext) => {
    const scope = await access(farmId, requester, `cancel ${config.name} records`, true);
    const memberId = requireWriter(scope);
    const row = await find(scope, ref);
    if (row.status === CANCELLED) {
      throw new AppError(status.CONFLICT, `${String(row[config.noField])} is already Cancelled!`);
    }
    if (row.status === config.settledStatus) {
      requireRole(scope, FinancePermissions.CORRECT_SETTLED, `cancel a ${config.settledStatus} ${config.name}`);
    }
    const reason = requireReason(body.reason, `cancel this ${config.name}`);
    await write(
      scope,
      row,
      {
        status: CANCELLED,
        description: appendTrail(row.description, CANCELLED, new Date(), reason),
      },
      memberId,
    );
    const review = await config.cancelReview(row);
    await audit(
      context,
      scope.farmObjectId,
      row._id,
      AuditActions.REJECT,
      `${Label} Cancelled`,
      { status: row.status, amount: row.amount },
      { status: CANCELLED, reason, ...(review ? { reviewRequired: true } : {}) },
      ["status"],
    );
    return { entry: await detailById(scope.farmObjectId, row._id), review };
  };

  /** Always 403: financial history is cancelled, never erased (final DB schema). */
  const remove = async (farmId: string, ref: string, requester: string) => {
    const scope = await resolveFinanceAccess(
      farmId,
      requester,
      FinancePermissions.DELETE,
      `delete ${config.name} records`,
    );
    const row = await find(scope, ref);
    const no = String(row[config.noField]);
    throw new AppError(
      status.FORBIDDEN,
      row.status === CANCELLED
        ? `${no} is already Cancelled and stays as financial history — it cannot be deleted.`
        : `${no} cannot be deleted. Financial records are kept for audit — cancel it with PATCH /:id/cancel and it leaves every total.`,
    );
  };

  /* ------------------------------ receipts ------------------------------- */

  const setAttachment = async (
    farmId: string,
    ref: string,
    requester: string,
    buffer: Buffer | undefined,
    context?: TAuditContext,
  ) => {
    const scope = await access(farmId, requester, `attach receipts to ${config.name} records`, true);
    const memberId = requireWriter(scope);
    const row = await find(scope, ref);
    if (row.status === CANCELLED) throw new AppError(status.CONFLICT, `A Cancelled ${config.name} can no longer be changed!`);
    if (!buffer?.length) throw new AppError(status.BAD_REQUEST, "Send one file in the `attachment` field!");
    const stored = await saveAttachment(scope.farmObjectId, buffer);
    try {
      await write(scope, row, { attachment: stored }, memberId);
    } catch (error) {
      await discardAttachment(stored);
      throw error;
    }
    //the replaced file stays on disk: it is part of the financial evidence (spec 21 §111)
    await audit(
      context,
      scope.farmObjectId,
      row._id,
      AuditActions.UPDATE,
      `${Label} Receipt ${row.attachment ? "Replaced" : "Added"}`,
      { attachment: row.attachment ? row.attachment.split("/").pop() : null },
      { attachment: stored.split("/").pop() },
      ["attachment"],
    );
    return detailById(scope.farmObjectId, row._id);
  };

  const getAttachment = async (farmId: string, ref: string, requester: string) => {
    const scope = await access(farmId, requester, `view ${config.name} receipts`);
    const row = await find(scope, ref);
    if (!row.attachment) throw new AppError(status.NOT_FOUND, `This ${config.name} has no attachment!`);
    return readAttachment(scope.farmObjectId, row.attachment, String(row[config.noField]));
  };

  const removeAttachment = async (farmId: string, ref: string, requester: string, context?: TAuditContext) => {
    const scope = await access(farmId, requester, `remove ${config.name} receipts`, true);
    const memberId = requireWriter(scope);
    const row = await find(scope, ref);
    if (!row.attachment) throw new AppError(status.NOT_FOUND, `This ${config.name} has no attachment!`);
    if (row.status !== PENDING) {
      throw new AppError(status.CONFLICT, `The receipt of a ${row.status} ${config.name} is kept as evidence — replace it instead.`);
    }
    await write(scope, row, { attachment: null }, memberId);
    await audit(
      context,
      scope.farmObjectId,
      row._id,
      AuditActions.UPDATE,
      `${Label} Receipt Removed`,
      { attachment: row.attachment.split("/").pop() },
      { attachment: null },
      ["attachment"],
    );
    return detailById(scope.farmObjectId, row._id);
  };

  return {
    access,
    find,
    detailById,
    audit,
    write,
    list,
    summary,
    summaryFor,
    reportRange,
    detail,
    auditLogs,
    settle,
    cancel,
    remove,
    setAttachment,
    getAttachment,
    removeAttachment,
  };
};
