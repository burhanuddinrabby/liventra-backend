import type { NextFunction, Request, Response } from "express";
import status from "http-status";
import multer from "multer";
import { parse } from "csv-parse/sync";
import AppError from "../../errors/AppError.js";
import { CSV_DEVICE_COLUMNS, CSV_MAX_BYTES, CSV_MAX_ROWS, METRIC_KEYS } from "./sensorData.constants.js";
import type { TIncomingReading } from "./sensorData.pipeline.js";

const bad = (message: string) => new AppError(status.BAD_REQUEST, message);
const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: CSV_MAX_BYTES, files: 1 } }).single("file");

/** multipart field `file`, kept in memory (≤ 2 MB); the file is never written to disk. */
export const uploadCsv = (req: Request, res: Response, next: NextFunction) => {
  csvUpload(req, res, (error: unknown) => {
    if (!error) return next();
    const tooLarge = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
    next(bad(tooLarge ? "The CSV file cannot exceed 2 MB!" : "The CSV file could not be read — send one file in the `file` field."));
  });
};

const ALLOWED_COLUMNS = new Set<string>(["recordedAt", ...CSV_DEVICE_COLUMNS, ...METRIC_KEYS]);

/**
 * Columns: `recordedAt`, `deviceCode` or `serialNumber`, then metric keys. Unknown columns refuse
 * the whole file, so a typo never silently drops a metric. Each data row keeps its line number.
 */
export const parseSensorCsv = (file: Express.Multer.File | undefined): { rows: TIncomingReading[]; columns: string[] } => {
  if (!file?.buffer?.length) throw bad("Choose a CSV file to import!");
  if (file.buffer.includes(0)) throw bad("This is not a CSV text file!");
  const content = file.buffer.toString("utf8").replace(BOM, "");

  let records: string[][];
  try {
    records = parse(content, { skip_empty_lines: true, trim: true, relax_column_count: false }) as string[][];
  } catch (error) {
    throw bad(`The CSV file could not be parsed: ${error instanceof Error ? error.message : "invalid format"}`);
  }
  const [header, ...data] = records;
  if (!header) throw bad("The CSV file is empty!");
  const columns = header.map((column) => column.trim());
  const unknown = columns.filter((column) => !ALLOWED_COLUMNS.has(column));
  if (unknown.length) throw bad(`Unknown CSV column: ${unknown.join(", ")}! Use the template.`);
  const duplicated = columns.filter((column, index) => columns.indexOf(column) !== index);
  if (duplicated.length) throw bad(`Duplicate CSV column: ${[...new Set(duplicated)].join(", ")}!`);
  if (!columns.includes("recordedAt")) throw bad("The CSV file needs a recordedAt column!");
  if (!columns.some((column) => (CSV_DEVICE_COLUMNS as readonly string[]).includes(column))) {
    throw bad("The CSV file needs a deviceCode or serialNumber column!");
  }
  if (!columns.some((column) => (METRIC_KEYS as string[]).includes(column))) throw bad("The CSV file has no metric column!");
  if (!data.length) throw bad("The CSV file has no data rows!");
  if (data.length > CSV_MAX_ROWS) throw bad(`A CSV file can hold at most ${CSV_MAX_ROWS} rows!`);

  const rows = data.map((cells, index): TIncomingReading => {
    const record = Object.fromEntries(columns.map((column, i) => [column, cells[i] ?? ""]));
    const metrics = Object.fromEntries(METRIC_KEYS.filter((key) => key in record).map((key) => [key, record[key]]));
    return {
      //line 1 is the header
      row: index + 2,
      device: { deviceCode: record.deviceCode, serialNumber: record.serialNumber },
      recordedAt: record.recordedAt,
      metrics,
      //the row as it was in the file: the evidence of where the numbers came from
      rawPayload: { csvLine: index + 2, ...record },
    };
  });
  return { rows, columns };
};

/** Header + one sample row; units are fixed by the app and listed by GET /meta. */
export const SENSOR_CSV_TEMPLATE = (): string => {
  const header = ["recordedAt", "deviceCode", ...METRIC_KEYS];
  const sample: Record<string, string> = { recordedAt: "2026-11-20 08:30", deviceCode: "DEV-000001", bodyTemperature: "38.6", ruminationMinutes: "480", batteryLevel: "82" };
  const sampleRow = header.map((column) => sample[column] ?? "").join(",");
  return [header.join(","), sampleRow, ""].join(String.fromCharCode(13, 10));
};
