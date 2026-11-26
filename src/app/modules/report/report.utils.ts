import status from "http-status";
import { isValidObjectId, Types } from "mongoose";
import AppError from "../../errors/AppError.js";
import { DAY_MS, parseCalendarDate } from "../feedRecord/feedRecord.utils.js";
import { FUTURE_TOLERANCE_HOURS } from "./report.constants.js";

/**
 * Rejects any filter object that smells of raw MongoDB query syntax: a key that starts
 * with `$` ($where, $expr, …) or contains a dot (dotted field paths) at any depth. This
 * runs before the per-type allowlist, so a client can never reach the database with
 * operator syntax even if a type forgot to re-validate a nested value.
 */
export const assertSafeFilterKeys = (value: unknown, pathLabel = "filters"): void => {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertSafeFilterKeys(item, `${pathLabel}[${i}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith("$") || key.includes(".")) {
      throw new AppError(status.BAD_REQUEST, `A filter key may not start with "$" or contain "." (${pathLabel}.${key}).`);
    }
    assertSafeFilterKeys(child, `${pathLabel}.${key}`);
  }
};

export const asPlainObject = (value: unknown, field = "filters"): Record<string, unknown> => {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(status.BAD_REQUEST, `${field} must be an object!`);
  }
  return value as Record<string, unknown>;
};

/** Validates and normalizes a report date range into UTC calendar-day bounds (half-open). */
export const parseReportRange = (
  value: unknown,
  maxDays: number,
): { from: Date; to: Date; toExclusive: Date } => {
  const range = asPlainObject(value, "dateRange");
  if (range.from === undefined || range.to === undefined) {
    throw new AppError(status.BAD_REQUEST, "dateRange.from and dateRange.to are required!");
  }
  const from = parseCalendarDate("dateRange.from", range.from);
  const to = parseCalendarDate("dateRange.to", range.to);
  if (from.getTime() > to.getTime()) {
    throw new AppError(status.BAD_REQUEST, "dateRange.from must not be after dateRange.to!");
  }
  const futureLimit = Date.now() + FUTURE_TOLERANCE_HOURS * 3_600_000;
  if (to.getTime() > futureLimit) {
    throw new AppError(status.BAD_REQUEST, "dateRange.to cannot be in the future!");
  }
  //inclusive day count
  const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (days > maxDays) {
    throw new AppError(status.BAD_REQUEST, `The date range cannot exceed ${maxDays} days for this report!`);
  }
  //half-open: records with a business date >= from and < day after to
  const toExclusive = new Date(to.getTime() + DAY_MS);
  return { from, to, toExclusive };
};

/** A comma-/array-supplied list of ObjectIds, all required to be valid. */
export const parseIdList = (field: string, value: unknown, max: number): Types.ObjectId[] => {
  const raw = Array.isArray(value)
    ? value
    : String(value)
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
  if (raw.length > max) throw new AppError(status.BAD_REQUEST, `${field} cannot contain more than ${max} ids!`);
  return raw.map((id) => {
    if (typeof id !== "string" || !isValidObjectId(id)) {
      throw new AppError(status.BAD_REQUEST, `${field} must contain valid ids!`);
    }
    return new Types.ObjectId(id);
  });
};

export const parseFilterEnum = (field: string, value: unknown, allowed: readonly string[]): string => {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new AppError(status.BAD_REQUEST, `${field} must be one of: ${allowed.join(", ")}!`);
  }
  return value;
};

/** Stable deep-equality for the 60 s duplicate guard (order-independent for objects). */
export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const ak = Object.keys(a as Record<string, unknown>).sort();
  const bk = Object.keys(b as Record<string, unknown>).sort();
  if (ak.length !== bk.length || !ak.every((k, i) => k === bk[i])) return false;
  return ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};

/** Human-readable file size for notification / UI copy. */
export const formatBytes = (bytes: number | null): string => {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};
