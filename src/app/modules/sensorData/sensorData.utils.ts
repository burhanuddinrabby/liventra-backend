import config from "../../config/index.js";
import { METRIC_KEYS, SENSOR_METRICS } from "./sensorData.constants.js";
import type { TMetricKey } from "./sensorData.constants.js";
import type { TSensorMetrics } from "./sensorData.interface.js";

export class RowError extends Error {}

/** Offset (ms) of `timeZone` at the instant `utcMs`: wall clock − UTC. */
export const zoneOffset = (utcMs: number, timeZone: string): number => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(utcMs))
      .map((part) => [part.type, part.value]),
  );
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return wall - Math.floor(utcMs / 1000) * 1000;
};

const MOMENT =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * ISO-like moment. With `Z` or an offset it is exact; without one it is wall-clock time in
 * APP_TIMEZONE (plan 7 §7.4). Date only = midnight there. Other formats (11/20/2026 …) are
 * refused because they are ambiguous.
 */
export const parseMoment = (value: unknown, timeZone = config.app_timezone): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string") return null;
  const match = MOMENT.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", ms = "0", zone] = match;
  const fields = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms.padEnd(3, "0"))] as const;
  const asUtc = Date.UTC(...fields);
  const check = new Date(asUtc);
  if (
    Number.isNaN(asUtc) ||
    check.getUTCDate() !== fields[2] ||
    check.getUTCMonth() !== fields[1] ||
    fields[3] > 23 ||
    fields[4] > 59 ||
    fields[5] > 59
  ) {
    return null;
  }
  if (zone) {
    if (zone.toUpperCase() === "Z") return check;
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60 * 1000;
    return new Date(asUtc - offset);
  }
  //wall clock in the farm's zone; a second pass settles DST edges
  let utc = asUtc - zoneOffset(asUtc, timeZone);
  utc = asUtc - zoneOffset(utc, timeZone);
  return new Date(utc);
};

/** Missing / empty stays absent (never 0). Unknown keys and impossible values are refused. */
export const normalizeMetrics = (input: unknown): TSensorMetrics => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RowError("metrics must be an object!");
  const entries = Object.entries(input as Record<string, unknown>);
  const unknown = entries.map(([key]) => key).filter((key) => !METRIC_KEYS.includes(key as TMetricKey));
  if (unknown.length) throw new RowError(`Unknown metric: ${unknown.join(", ")}!`);
  const metrics: TSensorMetrics = {};
  for (const [key, raw] of entries) {
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) continue;
    const value = typeof raw === "string" ? Number(raw.trim()) : raw;
    if (typeof value !== "number" || !Number.isFinite(value)) throw new RowError(`${key} must be a finite number!`);
    const rule = SENSOR_METRICS[key as TMetricKey];
    if (value < rule.min) {
      throw new RowError(rule.min === 0 ? `${key} cannot be negative!` : `${key} cannot be below ${rule.min}!`);
    }
    if (rule.max !== null && value > rule.max) throw new RowError(`${key} cannot exceed ${rule.max}!`);
    if (rule.integer && !Number.isInteger(value)) throw new RowError(`${key} must be a whole number!`);
    metrics[key as TMetricKey] = value;
  }
  if (!Object.keys(metrics).length) throw new RowError("At least one metric is required!");
  return metrics;
};

export const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
