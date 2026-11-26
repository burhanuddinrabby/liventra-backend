import status from "http-status";
import { isValidObjectId, Types } from "mongoose";
import AppError from "../../errors/AppError.js";
import { AuditActions, AuditEntityTypes, AuditModules } from "../auditLog/auditLog.constants.js";
import { recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext } from "../auditLog/auditLog.utils.js";
import { FarmStatuses } from "../farm/farm.constants.js";
import type { TFarmMemberRole } from "../farmMember/farmMember.interface.js";
import { parsePaging } from "../feedRecord/feedRecord.utils.js";
import { resolveReportAccess, roleForUserInFarm } from "./report.access.js";
import {
  AUDIT_MAX_RANGE_DAYS,
  DEFAULT_LIST_LIMIT,
  DUPLICATE_WINDOW_MS,
  MAX_LIST_LIMIT,
  MAX_RANGE_DAYS,
  MAX_REPORT_NAME,
  MAX_WAITING_PER_FARM,
  RATE_LIMIT_PER_HOUR,
  RETENTION_DAYS,
  SENSOR_MAX_RANGE_DAYS,
  ReportFormats,
  ReportJobStatuses,
  ReportStatuses,
  ReportTypes,
} from "./report.constants.js";
import type { TReport, TReportFormat, TReportType } from "./report.interface.js";
import { generateReportNo, ReportJobModel, ReportModel } from "./report.model.js";
import {
  canGenerateType,
  formatsForRole,
  includesPrices,
  maxRangeDaysFor,
  restrictedToOwnReports,
  seesOwnReportsOnly,
  typesForRole,
} from "./report.permissions.js";
import { MIME_FOR_EXTENSION } from "./report.storage.js";
import { deleteReportKey, readReportFile } from "./report.storage.js";
import { getReportTypeDef, IMPLEMENTED_REPORT_TYPES } from "./report.types/index.js";
import {
  asPlainObject,
  assertSafeFilterKeys,
  deepEqual,
  parseReportRange,
} from "./report.utils.js";
import { kickWorker } from "./report.worker.js";

type TPayload = Record<string, unknown>;

/* -------------------------------- helpers --------------------------------- */

const baseMaxRangeDays = (type: TReportType): number => {
  if (type === ReportTypes.SENSOR) return SENSOR_MAX_RANGE_DAYS;
  if (type === ReportTypes.AUDIT_LOG) return AUDIT_MAX_RANGE_DAYS;
  return MAX_RANGE_DAYS;
};

const parseReportType = (value: unknown): TReportType => {
  if (typeof value !== "string" || !Object.values(ReportTypes).includes(value as TReportType)) {
    throw new AppError(status.BAD_REQUEST, "reportType must be a valid report type!");
  }
  return value as TReportType;
};

const parseReportFormat = (value: unknown): TReportFormat => {
  if (typeof value !== "string" || !Object.values(ReportFormats).includes(value as TReportFormat)) {
    throw new AppError(status.BAD_REQUEST, "reportFormat must be one of: PDF, Excel, CSV, JSON!");
  }
  return value as TReportFormat;
};

const parseReportName = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError(status.BAD_REQUEST, "reportName is required!");
  }
  const name = value.trim();
  if (name.length > MAX_REPORT_NAME) {
    throw new AppError(status.BAD_REQUEST, `reportName cannot exceed ${MAX_REPORT_NAME} characters!`);
  }
  return name;
};

type TValidatedRequest = {
  reportType: TReportType;
  reportFormat: TReportFormat;
  reportName: string;
  dateRange: { from: Date; to: Date };
  filters: Record<string, unknown>;
};

/** Full server-side validation of a generation / preview request against today's rules. */
const validateRequest = async (
  role: TFarmMemberRole,
  farmObjectId: Types.ObjectId,
  body: TPayload,
): Promise<TValidatedRequest> => {
  const reportType = parseReportType(body.reportType);

  const def = getReportTypeDef(reportType);
  if (!def) {
    throw new AppError(status.BAD_REQUEST, `The ${reportType} report is not available yet.`);
  }
  if (!canGenerateType(role, reportType)) {
    throw new AppError(status.FORBIDDEN, `Your farm role (${role}) cannot generate ${reportType} reports!`);
  }

  const reportFormat = parseReportFormat(body.reportFormat);
  if (!def.formats.includes(reportFormat) || !formatsForRole(role, reportType).includes(reportFormat)) {
    throw new AppError(status.BAD_REQUEST, `${reportFormat} is not available for this report and role.`);
  }
  if (reportFormat === ReportFormats.CSV && !def.csvFlat) {
    throw new AppError(status.BAD_REQUEST, `The ${reportType} report cannot be exported as a single CSV table.`);
  }

  const reportName = parseReportName(body.reportName);

  const maxDays = maxRangeDaysFor(role, reportType, baseMaxRangeDays(reportType));
  const { from, to } = parseReportRange(body.dateRange, maxDays);

  const rawFilters = asPlainObject(body.filters);
  //defence in depth: no raw operator syntax can reach the per-type allowlist
  assertSafeFilterKeys(rawFilters);
  const filters = await def.parseFilters(rawFilters, { farmObjectId });

  return { reportType, reportFormat, reportName, dateRange: { from, to }, filters };
};

const now = () => new Date();

const isDownloadable = (report: Pick<TReport, "status" | "expiresAt">): boolean =>
  report.status === ReportStatuses.COMPLETED && (!report.expiresAt || report.expiresAt.getTime() > Date.now());

/** API view of a report — fileUrl is NEVER included. */
const toClient = (report: TReport & { _id: Types.ObjectId; createdAt?: Date }, generatedByName?: string) => ({
  _id: report._id,
  reportNo: report.reportNo,
  farmId: report.farmId,
  reportType: report.reportType,
  reportFormat: report.reportFormat,
  reportName: report.reportName,
  dateRange: report.dateRange,
  filters: report.filters,
  generatedBy: report.generatedBy,
  ...(generatedByName ? { generatedByName } : {}),
  fileSize: report.fileSize,
  status: report.status,
  expiresAt: report.expiresAt,
  createdAt: report.createdAt,
  downloadable: isDownloadable(report),
});

/* ---------------------------------- meta ---------------------------------- */

const getMeta = async (farmId: string, requesterUserId: string) => {
  const access = await resolveReportAccess(farmId, requesterUserId);
  const types = IMPLEMENTED_REPORT_TYPES.filter((type) => canGenerateType(access.role, type)).map((type) => {
    const def = getReportTypeDef(type);
    return {
      reportType: type,
      formats: (def?.formats ?? []).filter((format) => formatsForRole(access.role, type).includes(format)),
      dateField: def?.dateFieldLabel ?? "",
      maxRangeDays: maxRangeDaysFor(access.role, type, baseMaxRangeDays(type)),
      includesPrices: includesPrices(access.role, type),
      filters: FILTER_META[type] ?? [],
    };
  });
  return {
    role: access.role,
    farmStatus: access.farmStatus,
    canGenerate: access.farmStatus === FarmStatuses.ACTIVE,
    retentionDays: RETENTION_DAYS,
    rateLimitPerHour: RATE_LIMIT_PER_HOUR,
    formats: Object.values(ReportFormats),
    types,
  };
};

//per-type filter hints for the UI (the server still validates strictly)
const FILTER_META: Partial<Record<TReportType, { key: string; type: string; label: string }[]>> = {
  [ReportTypes.MILK]: [
    { key: "animalIds", type: "animalIds", label: "Animals" },
    { key: "session", type: "enum", label: "Session" },
    { key: "quality", type: "enum", label: "Quality" },
  ],
};

/* ------------------------------ preview count ----------------------------- */

const previewCount = async (farmId: string, requesterUserId: string, body: TPayload) => {
  const access = await resolveReportAccess(farmId, requesterUserId);
  const parsed = await validateRequest(access.role, access.farmObjectId, body);
  const def = getReportTypeDef(parsed.reportType);
  if (!def) throw new AppError(status.BAD_REQUEST, "This report is not available yet.");
  const toExclusive = new Date(parsed.dateRange.to.getTime() + 24 * 60 * 60 * 1000);
  const rows = await def.countRows({
    farm: { _id: access.farmObjectId, farmId: access.farmId, farmName: access.farmName },
    dateRange: parsed.dateRange,
    toExclusive,
    filters: parsed.filters,
    format: parsed.reportFormat,
    asOf: now(),
    includePrices: includesPrices(access.role, parsed.reportType),
    generatedByLabel: access.userLabel,
  });
  return { rows, reportType: parsed.reportType, reportFormat: parsed.reportFormat };
};

/* --------------------------------- create --------------------------------- */

const createReportRecord = async (
  access: Awaited<ReturnType<typeof resolveReportAccess>>,
  parsed: TValidatedRequest,
  context: TAuditContext,
) => {
  //duplicate guard: the same request by the same user within 60 s returns the existing report
  const recent = await ReportModel.find({
    farmId: access.farmObjectId,
    generatedBy: access.userObjectId,
    reportType: parsed.reportType,
    reportFormat: parsed.reportFormat,
    reportName: parsed.reportName,
    "dateRange.from": parsed.dateRange.from,
    "dateRange.to": parsed.dateRange.to,
    status: { $in: [ReportStatuses.GENERATING, ReportStatuses.COMPLETED] },
    createdAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
  })
    .sort({ createdAt: -1 })
    .lean();
  const duplicate = recent.find((r) => deepEqual(r.filters ?? {}, parsed.filters));
  if (duplicate) {
    return { report: duplicate, reused: true };
  }

  //per-user hourly rate limit
  const lastHour = await ReportModel.countDocuments({
    generatedBy: access.userObjectId,
    createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
  });
  if (lastHour >= RATE_LIMIT_PER_HOUR) {
    throw new AppError(status.TOO_MANY_REQUESTS, `You can generate at most ${RATE_LIMIT_PER_HOUR} reports per hour.`);
  }

  //queue cap per farm
  const waiting = await ReportJobModel.countDocuments({
    farmId: access.farmObjectId,
    status: ReportJobStatuses.WAITING,
  });
  if (waiting >= MAX_WAITING_PER_FARM) {
    throw new AppError(status.TOO_MANY_REQUESTS, "The farm's report queue is full. Please try again shortly.");
  }

  //create the Report (with a reportNo retry on the unique index), then its claim
  let created: (TReport & { _id: Types.ObjectId; createdAt?: Date }) | null = null;
  for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
    try {
      const doc = await ReportModel.create({
        reportNo: await generateReportNo(access.farmObjectId),
        farmId: access.farmObjectId,
        reportType: parsed.reportType,
        reportFormat: parsed.reportFormat,
        reportName: parsed.reportName,
        dateRange: parsed.dateRange,
        filters: parsed.filters,
        generatedBy: access.userObjectId,
        status: ReportStatuses.GENERATING,
      });
      created = doc.toObject() as unknown as TReport & { _id: Types.ObjectId; createdAt?: Date };
    } catch (error) {
      if ((error as { code?: number })?.code === 11000) continue;
      throw error;
    }
  }
  if (!created) throw new AppError(status.INTERNAL_SERVER_ERROR, "Could not allocate a report number. Try again.");

  await ReportJobModel.create({
    reportId: created._id,
    farmId: access.farmObjectId,
    generatedBy: access.userObjectId,
    status: ReportJobStatuses.WAITING,
    attempts: 0,
  });

  await recordAuditLog({
    context,
    farmId: access.farmObjectId,
    entityType: AuditEntityTypes.REPORT,
    entityId: created._id,
    action: AuditActions.CREATE,
    module: AuditModules.ADMINISTRATION,
    event: "Report Requested",
    newData: {
      reportNo: created.reportNo,
      reportType: created.reportType,
      reportFormat: created.reportFormat,
      dateRange: created.dateRange,
    },
  });

  kickWorker();
  return { report: created, reused: false };
};

const createReport = async (
  farmId: string,
  requesterUserId: string,
  body: TPayload,
  context: TAuditContext,
) => {
  const access = await resolveReportAccess(farmId, requesterUserId);
  if (access.farmStatus !== FarmStatuses.ACTIVE) {
    throw new AppError(
      status.FORBIDDEN,
      `This farm is ${String(access.farmStatus).toLowerCase()} — existing reports can be viewed and downloaded, but new reports cannot be generated.`,
    );
  }
  const parsed = await validateRequest(access.role, access.farmObjectId, body);
  const { report } = await createReportRecord(access, parsed, context);
  return { reportId: report._id, reportNo: report.reportNo, status: report.status };
};

/* ---------------------------------- list ---------------------------------- */

const listReports = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveReportAccess(farmId, requesterUserId);
  const allowedTypes = typesForRole(access.role).filter((type) => IMPLEMENTED_REPORT_TYPES.includes(type));

  const filter: TPayload = { farmId: access.farmObjectId, reportType: { $in: allowedTypes } };
  if (restrictedToOwnReports(access.role)) filter.generatedBy = access.userObjectId;

  if (typeof query.type === "string") {
    const type = parseReportType(query.type);
    if (!allowedTypes.includes(type)) throw new AppError(status.FORBIDDEN, "You cannot view this report type.");
    filter.reportType = type;
  }
  if (typeof query.format === "string") filter.reportFormat = parseReportFormat(query.format);
  if (typeof query.status === "string") {
    if (!Object.values(ReportStatuses).includes(query.status as never)) {
      throw new AppError(status.BAD_REQUEST, "status is not a valid report status!");
    }
    filter.status = query.status;
  }
  if (typeof query.generatedBy === "string" && isValidObjectId(query.generatedBy)) {
    //a restricted role is already pinned to itself; others may filter freely
    if (!restrictedToOwnReports(access.role)) filter.generatedBy = new Types.ObjectId(query.generatedBy);
  }
  if (typeof query.from === "string" || typeof query.to === "string") {
    const createdAt: TPayload = {};
    if (typeof query.from === "string") createdAt.$gte = new Date(`${query.from}T00:00:00.000Z`);
    if (typeof query.to === "string") createdAt.$lte = new Date(`${query.to}T23:59:59.999Z`);
    filter.createdAt = createdAt;
  }

  const { page, limit, skip } = parsePaging(query, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);
  const [rows, total] = await Promise.all([
    ReportModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("generatedBy", "userId fullName")
      .lean(),
    ReportModel.countDocuments(filter),
  ]);

  const data = rows.map((row) => {
    const plain = row as unknown as TReport & { _id: Types.ObjectId; createdAt?: Date };
    const generator = row.generatedBy as unknown as { _id: Types.ObjectId; fullName?: string; userId?: string };
    return toClient(
      { ...plain, generatedBy: generator?._id ?? plain.generatedBy },
      generator?.fullName ?? generator?.userId,
    );
  });

  return {
    data,
    meta: { page, limit, totalEntries: total, totalPage: Math.ceil(total / limit) },
  };
};

/* ---------------------------------- detail -------------------------------- */

const loadVisibleReport = async (
  access: Awaited<ReturnType<typeof resolveReportAccess>>,
  reportId: string,
) => {
  if (!isValidObjectId(reportId)) throw new AppError(status.NOT_FOUND, "Report not found!");
  const report = await ReportModel.findOne({ _id: reportId, farmId: access.farmObjectId });
  //farm isolation: a report of another farm (or no report) is a 404 on every route
  if (!report) throw new AppError(status.NOT_FOUND, "Report not found!");
  if (!canGenerateType(access.role, report.reportType)) {
    throw new AppError(status.NOT_FOUND, "Report not found!");
  }
  if (
    seesOwnReportsOnly(access.role, report.reportType) &&
    !report.generatedBy.equals(access.userObjectId)
  ) {
    throw new AppError(status.NOT_FOUND, "Report not found!");
  }
  return report;
};

const getReport = async (farmId: string, requesterUserId: string, reportId: string) => {
  const access = await resolveReportAccess(farmId, requesterUserId);
  const report = await loadVisibleReport(access, reportId);
  await report.populate("generatedBy", "userId fullName");
  const generator = report.generatedBy as unknown as { _id: Types.ObjectId; fullName?: string; userId?: string };
  const plain = report.toObject() as never as TReport & { _id: Types.ObjectId; createdAt?: Date };
  return toClient({ ...plain, generatedBy: generator?._id ?? plain.generatedBy }, generator?.fullName ?? generator?.userId);
};

/* -------------------------------- download -------------------------------- */

const downloadReport = async (
  farmId: string,
  requesterUserId: string,
  reportId: string,
  context: TAuditContext,
) => {
  const access = await resolveReportAccess(farmId, requesterUserId);
  const report = await loadVisibleReport(access, reportId);

  //re-check at download: a member who lost the role cannot fetch an old file
  const role = await roleForUserInFarm(access.farmObjectId, access.userObjectId);
  if (!role || !canGenerateType(role, report.reportType)) {
    throw new AppError(status.FORBIDDEN, "You are no longer allowed to download this report.");
  }

  if (report.status === ReportStatuses.EXPIRED) {
    throw new AppError(status.GONE, "This report has expired and is no longer available.");
  }
  if (report.status !== ReportStatuses.COMPLETED || !report.fileUrl) {
    throw new AppError(status.CONFLICT, `This report is ${report.status.toLowerCase()} and cannot be downloaded.`);
  }
  if (report.expiresAt && report.expiresAt.getTime() <= Date.now()) {
    await ReportModel.updateOne(
      { _id: report._id, status: ReportStatuses.COMPLETED },
      { $set: { status: ReportStatuses.EXPIRED } },
    );
    await deleteReportKey(access.farmObjectId, report.fileUrl);
    throw new AppError(status.GONE, "This report has expired and is no longer available.");
  }

  const file = await readReportFile(access.farmObjectId, report.fileUrl);
  if (!file) {
    //file is gone (manually removed or storage loss): reconcile and refuse
    await ReportModel.updateOne(
      { _id: report._id, status: ReportStatuses.COMPLETED },
      { $set: { status: ReportStatuses.EXPIRED } },
    );
    throw new AppError(status.GONE, "The report file is no longer available.");
  }

  await recordAuditLog({
    context,
    farmId: access.farmObjectId,
    entityType: AuditEntityTypes.REPORT,
    entityId: report._id,
    action: AuditActions.EXPORT,
    module: AuditModules.ADMINISTRATION,
    event: "Report Downloaded",
    newData: { reportNo: report.reportNo, reportFormat: report.reportFormat },
  });

  return {
    buffer: file.buffer,
    mime: MIME_FOR_EXTENSION[file.extension] ?? "application/octet-stream",
    fileName: `${report.reportNo}.${file.extension}`,
  };
};

/* --------------------------------- retry ---------------------------------- */

const retryReport = async (
  farmId: string,
  requesterUserId: string,
  reportId: string,
  context: TAuditContext,
) => {
  const access = await resolveReportAccess(farmId, requesterUserId);
  const report = await loadVisibleReport(access, reportId);
  if (report.status !== ReportStatuses.FAILED) {
    throw new AppError(status.BAD_REQUEST, "Only a failed report can be retried.");
  }
  if (access.farmStatus !== FarmStatuses.ACTIVE) {
    throw new AppError(status.FORBIDDEN, "New reports cannot be generated while the farm is not active.");
  }

  //a retry is a NEW report, re-checked against today's permissions; the failed one stays
  const body: TPayload = {
    reportType: report.reportType,
    reportFormat: report.reportFormat,
    reportName: report.reportName,
    dateRange: {
      from: report.dateRange.from.toISOString().slice(0, 10),
      to: report.dateRange.to.toISOString().slice(0, 10),
    },
    filters: report.filters,
  };
  const parsed = await validateRequest(access.role, access.farmObjectId, body);
  const { report: fresh } = await createReportRecord(access, parsed, context);
  return { reportId: fresh._id, reportNo: fresh.reportNo, status: fresh.status };
};

/* --------------------------------- delete --------------------------------- */

//DELETE is always refused in the final schema: reports are kept as history and expire.
const deleteReport = async (farmId: string, requesterUserId: string, reportId: string) => {
  const access = await resolveReportAccess(farmId, requesterUserId);
  await loadVisibleReport(access, reportId);
  throw new AppError(status.FORBIDDEN, "Reports cannot be deleted. They are kept as history and expire automatically.");
};

/* ---------------------------- expiry (job) -------------------------------- */

/** Hourly: delete the files of Completed reports past expiry, then mark them Expired. */
const expireReports = async (): Promise<void> => {
  const due = await ReportModel.find({
    status: ReportStatuses.COMPLETED,
    expiresAt: { $ne: null, $lte: new Date() },
  })
    .select("_id farmId fileUrl")
    .lean();
  for (const report of due) {
    await deleteReportKey(report.farmId, report.fileUrl ?? null);
    await ReportModel.updateOne(
      { _id: report._id, status: ReportStatuses.COMPLETED },
      { $set: { status: ReportStatuses.EXPIRED, fileUrl: null } },
    );
  }
};

export const ReportServices = {
  getMeta,
  previewCount,
  createReport,
  listReports,
  getReport,
  downloadReport,
  retryReport,
  deleteReport,
  expireReports,
};
