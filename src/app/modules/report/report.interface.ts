import type { Types } from "mongoose";
import type { ReportFormats, ReportJobStatuses, ReportStatuses, ReportTypes } from "./report.constants.js";

export type TReportType = (typeof ReportTypes)[keyof typeof ReportTypes];
export type TReportFormat = (typeof ReportFormats)[keyof typeof ReportFormats];
export type TReportStatus = (typeof ReportStatuses)[keyof typeof ReportStatuses];
export type TReportJobStatus = (typeof ReportJobStatuses)[keyof typeof ReportJobStatuses];

export type TReport = {
  reportNo: string;
  farmId: Types.ObjectId;
  reportType: TReportType;
  reportFormat: TReportFormat;
  reportName: string;
  dateRange: { from: Date; to: Date };
  //effective, allowlisted filters actually used (never raw query syntax)
  filters: Record<string, unknown>;
  generatedBy: Types.ObjectId;
  //private relative storage key — NEVER returned by the API
  fileUrl: string | null;
  fileSize: number | null;
  status: TReportStatus;
  expiresAt: Date | null;
  createdAt?: Date;
};

//technical collection: the worker's atomic claim for one report
export type TReportJob = {
  reportId: Types.ObjectId;
  farmId: Types.ObjectId;
  //User _id of the requester — used for the "1 running per user" rule
  generatedBy: Types.ObjectId;
  status: TReportJobStatus;
  lockedUntil: Date | null;
  attempts: number;
  createdAt?: Date;
  updatedAt?: Date;
};

/* --------------------- neutral report document model ---------------------- */

export type TReportCell = string | number | Date | null;
export type TReportColumnType = "text" | "number" | "integer" | "date";

export type TReportColumn = {
  key: string;
  header: string;
  headerBn?: string;
  type: TReportColumnType;
  //false = dropped from the (narrow) PDF layout; still present in Excel / CSV / JSON
  pdf?: boolean;
  //relative column width hint (PDF + Excel)
  width?: number;
};

export type TReportRow = Record<string, TReportCell>;

export type TReportTable = {
  name: string;
  nameBn?: string;
  columns: TReportColumn[];
  rows: TReportRow[];
  //the one table a CSV export flattens to (exactly one table must set this for CSV types)
  csvMain?: boolean;
};

export type TReportKeyValue = { label: string; labelBn?: string; value: string };

/** Renderer-neutral shape every report type produces; the four renderers consume it. */
export type TReportDocument = {
  title: string;
  titleBn?: string;
  meta: TReportKeyValue[];
  summary: TReportKeyValue[];
  tables: TReportTable[];
  notes: string[];
};

/* ------------------------------ build context ----------------------------- */

export type TReportBuildContext = {
  farm: { _id: Types.ObjectId; farmId: string; farmName: string };
  dateRange: { from: Date; to: Date };
  //half-open query bound: < this (day after `to`)
  toExclusive: Date;
  filters: Record<string, unknown>;
  format: TReportFormat;
  //one consistent time for the whole report
  asOf: Date;
  //false for Vet / Worker — price columns are dropped
  includePrices: boolean;
  generatedByLabel: string;
};

/** One report type: its formats, filter allowlist, row count and document builder. */
export type TReportTypeDef = {
  type: TReportType;
  formats: readonly TReportFormat[];
  //true when the type can be flattened to a single CSV table
  csvFlat: boolean;
  dateFieldLabel: string;
  // eslint-disable-next-line no-unused-vars
  parseFilters: (raw: Record<string, unknown>, ctx: TFilterParseContext) => Promise<Record<string, unknown>>;
  // eslint-disable-next-line no-unused-vars
  countRows: (ctx: TReportBuildContext) => Promise<number>;
  // eslint-disable-next-line no-unused-vars
  build: (ctx: TReportBuildContext) => Promise<TReportDocument>;
};

export type TFilterParseContext = {
  farmObjectId: Types.ObjectId;
};
