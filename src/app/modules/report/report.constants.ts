// Report (Model 28, updated) — generation request + lifecycle + private file tracking.
// Enum values are the exact display strings from the final schema and are stored as-is.

export const ReportTypes = {
  FARM_SUMMARY: "Farm Summary",
  ANIMAL: "Animal",
  FEED: "Feed",
  MILK: "Milk",
  WEIGHT: "Weight",
  HEALTH: "Health",
  VACCINATION: "Vaccination",
  TREATMENT: "Treatment",
  INVENTORY: "Inventory",
  EXPENSE: "Expense",
  INCOME: "Income",
  FINANCE: "Finance",
  AUDIT_LOG: "Audit Log",
  DEVICE: "Device",
  SENSOR: "Sensor",
} as const;

export const ReportFormats = {
  PDF: "PDF",
  EXCEL: "Excel",
  CSV: "CSV",
  JSON: "JSON",
} as const;

export const ReportStatuses = {
  GENERATING: "Generating",
  COMPLETED: "Completed",
  FAILED: "Failed",
  EXPIRED: "Expired",
} as const;

//technical ReportJob collection: only the worker changes these
export const ReportJobStatuses = {
  WAITING: "Waiting",
  RUNNING: "Running",
} as const;

export const REPORT_NO_PREFIX = "REP";

/* ------------------------------- validation ------------------------------- */

export const MAX_REPORT_NAME = 150;
export const MIN_REPORT_NAME = 1;
//default cap; some types tighten it (Sensor 31, Audit Log 92)
export const MAX_RANGE_DAYS = 366;
export const SENSOR_MAX_RANGE_DAYS = 31;
export const AUDIT_MAX_RANGE_DAYS = 92;
//Worker-limited types (Milk / Feed): PDF / CSV only, at most 31 days
export const WORKER_MAX_RANGE_DAYS = 31;
export const WORKER_FORMATS = [ReportFormats.PDF, ReportFormats.CSV] as const;
export const MAX_ANIMAL_IDS = 1000;
//tolerance for client / server time-zone differences when rejecting future dates
export const FUTURE_TOLERANCE_HOURS = 24;

/* -------------------------------- worker ---------------------------------- */

//rows that would reach the file (counted before start when possible)
export const ROW_LIMIT_TABULAR = 50_000; //Excel / CSV / JSON
export const ROW_LIMIT_PDF = 2_000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024; //25 MB
export const WORKER_TIMEOUT_MS = 5 * 60_000; //5 min per report

//in-process queue limits
export const MAX_RUNNING = 2; //concurrent reports across the farm fleet
export const MAX_RUNNING_PER_USER = 1;
export const MAX_WAITING_PER_FARM = 20;
export const MAX_JOB_ATTEMPTS = 3;
//a Generating report older than this with no live worker is stuck
export const STUCK_AFTER_MS = 15 * 60_000;
//lease a claimed job holds; longer than the worker timeout so a slow run keeps its claim
export const JOB_LOCK_TTL_MS = 10 * 60_000;

/* ------------------------------- lifecycle -------------------------------- */

//how long a Completed file is kept before the hourly expiry job deletes it
export const RETENTION_DAYS = 7;
//the same request by the same user inside this window returns the existing report
export const DUPLICATE_WINDOW_MS = 60_000;
export const RATE_LIMIT_PER_HOUR = 10;

export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 20;
