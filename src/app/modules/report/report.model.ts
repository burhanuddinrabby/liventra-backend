import { model, Schema } from "mongoose";
import type { Types } from "mongoose";
import {
  REPORT_NO_PREFIX,
  ReportFormats,
  ReportJobStatuses,
  ReportStatuses,
  ReportTypes,
} from "./report.constants.js";
import type { TReport, TReportJob } from "./report.interface.js";

/**
 * Report (Model 28, updated). timestamps give `createdAt` only — the model has no
 * `updatedAt` on purpose. Every lifecycle field (reportNo, generatedBy, fileUrl,
 * fileSize, status, expiresAt) is server-controlled; the client never sets them.
 */
const reportSchema = new Schema<TReport>(
  {
    reportNo: { type: String, required: true, trim: true, immutable: true },
    farmId: { type: Schema.Types.ObjectId, ref: "Farm", required: true, immutable: true },
    reportType: { type: String, enum: Object.values(ReportTypes), required: true, immutable: true },
    reportFormat: { type: String, enum: Object.values(ReportFormats), required: true, immutable: true },
    reportName: { type: String, required: true, trim: true, maxlength: 150, immutable: true },
    dateRange: {
      from: { type: Date, required: true, immutable: true },
      to: { type: Date, required: true, immutable: true },
    },
    filters: { type: Schema.Types.Mixed, default: {}, immutable: true },
    generatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    //private relative storage key, never exposed by the API
    fileUrl: { type: String, default: null },
    fileSize: { type: Number, min: 0, default: null },
    status: {
      type: String,
      enum: Object.values(ReportStatuses),
      required: true,
      default: ReportStatuses.GENERATING,
    },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

reportSchema.index({ farmId: 1, reportNo: 1 }, { unique: true });
reportSchema.index({ farmId: 1, createdAt: -1 });
reportSchema.index({ farmId: 1, reportType: 1, createdAt: -1 });
reportSchema.index({ status: 1, expiresAt: 1 });
reportSchema.index({ generatedBy: 1, createdAt: -1 });

export const ReportModel = model<TReport>("Report", reportSchema);

/* ----------------------------- ReportJob (claims) ------------------------- */

const reportJobSchema = new Schema<TReportJob>(
  {
    //one job per report: the unique index is the real double-enqueue guard
    reportId: { type: Schema.Types.ObjectId, ref: "Report", required: true, unique: true, immutable: true },
    farmId: { type: Schema.Types.ObjectId, ref: "Farm", required: true, immutable: true },
    generatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    status: {
      type: String,
      enum: Object.values(ReportJobStatuses),
      required: true,
      default: ReportJobStatuses.WAITING,
    },
    lockedUntil: { type: Date, default: null },
    attempts: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

//the worker scans waiting jobs oldest-first and counts running jobs per user / farm
reportJobSchema.index({ status: 1, createdAt: 1 });
reportJobSchema.index({ farmId: 1, status: 1 });

export const ReportJobModel = model<TReportJob>("ReportJob", reportJobSchema);

/* -------------------------------- numbering ------------------------------- */

type TReportCounter = { _id: string; seq: number };
const reportCounterSchema = new Schema<TReportCounter>(
  { _id: { type: String, required: true }, seq: { type: Number, required: true, default: 0 } },
  { versionKey: false },
);
const ReportCounterModel = model<TReportCounter>("ReportCounter", reportCounterSchema);

/**
 * REP-YYYY-NNNNN, atomic per farm + year (outside any transaction; gaps are harmless).
 * The unique `{ farmId, reportNo }` index is the real guard, so retry on 11000.
 */
export const generateReportNo = async (farmObjectId: Types.ObjectId): Promise<string> => {
  const year = new Date().getFullYear();
  const counter = await ReportCounterModel.findOneAndUpdate(
    { _id: `${farmObjectId.toString()}-${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  return `${REPORT_NO_PREFIX}-${year}-${String(counter?.seq ?? 1).padStart(5, "0")}`;
};
