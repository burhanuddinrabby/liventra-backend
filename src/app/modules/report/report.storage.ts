import fs from "node:fs/promises";
import path from "node:path";
import type { Types } from "mongoose";

/**
 * Report file storage: a disk driver behind a small interface, so an S3 driver can be
 * added later without touching the worker. Files live under uploads/reports/<farmId>/,
 * which is git-ignored and NEVER served statically — the download route streams them
 * after the same farm + role check as the record. All paths are validated to stay inside
 * the farm's own folder (same guard as finance.utils.ts).
 */

const REPORTS_ROOT = path.join("uploads", "reports");

const farmDir = (farmObjectId: Types.ObjectId) => path.join(REPORTS_ROOT, String(farmObjectId));

export const EXTENSION_FOR_FORMAT: Record<string, string> = {
  PDF: "pdf",
  Excel: "xlsx",
  CSV: "csv",
  JSON: "json",
};

export const MIME_FOR_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
};

export type TReportWriteResult = { key: string; size: number };

// eslint-disable-next-line no-unused-vars
export type TReportFileProducer = (absoluteTmpPath: string) => Promise<void>;

/**
 * Writes the file to <id>.tmp, then renames it to <id>.<ext> only after the producer
 * finished. A failure leaves no half file: the tmp is removed. Returns the relative
 * storage key and the final size in bytes.
 */
export const writeReportFile = async (
  farmObjectId: Types.ObjectId,
  reportId: Types.ObjectId,
  extension: string,
  produce: TReportFileProducer,
): Promise<TReportWriteResult> => {
  const dir = farmDir(farmObjectId);
  await fs.mkdir(path.join(process.cwd(), dir), { recursive: true });

  const relativeFinal = path.join(dir, `${reportId.toString()}.${extension}`).replaceAll("\\", "/");
  const absoluteFinal = path.join(process.cwd(), relativeFinal);
  const absoluteTmp = `${absoluteFinal}.tmp`;

  try {
    await produce(absoluteTmp);
    const stat = await fs.stat(absoluteTmp);
    await fs.rename(absoluteTmp, absoluteFinal);
    return { key: relativeFinal, size: stat.size };
  } catch (error) {
    await fs.rm(absoluteTmp, { force: true }).catch(() => undefined);
    throw error;
  }
};

/** Streams a stored file after confirming the key points inside this farm's own folder. */
export const readReportFile = async (
  farmObjectId: Types.ObjectId,
  key: string,
): Promise<{ buffer: Buffer; extension: string } | null> => {
  const absolute = path.resolve(process.cwd(), key);
  const allowedRoot = path.resolve(process.cwd(), farmDir(farmObjectId)) + path.sep;
  if (!absolute.startsWith(allowedRoot)) return null;
  const buffer = await fs.readFile(absolute).catch(() => null);
  if (!buffer) return null;
  return { buffer, extension: path.extname(absolute).slice(1) };
};

/** Removes the finished file and any leftover tmp for one report. Safe to repeat. */
export const deleteReportFiles = async (farmObjectId: Types.ObjectId, reportId: Types.ObjectId): Promise<void> => {
  const base = path.join(process.cwd(), farmDir(farmObjectId), reportId.toString());
  await Promise.all([
    fs.rm(base, { force: true }).catch(() => undefined),
    fs.rm(`${base}.pdf`, { force: true }).catch(() => undefined),
    fs.rm(`${base}.xlsx`, { force: true }).catch(() => undefined),
    fs.rm(`${base}.csv`, { force: true }).catch(() => undefined),
    fs.rm(`${base}.json`, { force: true }).catch(() => undefined),
    fs.rm(`${base}.pdf.tmp`, { force: true }).catch(() => undefined),
    fs.rm(`${base}.xlsx.tmp`, { force: true }).catch(() => undefined),
    fs.rm(`${base}.csv.tmp`, { force: true }).catch(() => undefined),
    fs.rm(`${base}.json.tmp`, { force: true }).catch(() => undefined),
  ]);
};

/** Deletes a stored file by its key (expiry job). Safe to repeat. */
export const deleteReportKey = async (farmObjectId: Types.ObjectId, key: string | null): Promise<void> => {
  if (!key) return;
  const absolute = path.resolve(process.cwd(), key);
  const allowedRoot = path.resolve(process.cwd(), farmDir(farmObjectId)) + path.sep;
  if (!absolute.startsWith(allowedRoot)) return;
  await fs.rm(absolute, { force: true }).catch(() => undefined);
};

/** Permanent farm deletion removes its whole reports folder. */
export const removeFarmReports = (farmObjectId: Types.ObjectId): Promise<void> =>
  fs.rm(path.join(process.cwd(), farmDir(farmObjectId)), { recursive: true, force: true }).catch(() => undefined);
