import status from "http-status";
import { isValidObjectId, Types } from "mongoose";
import type { ClientSession } from "mongoose";
import AppError from "../../errors/AppError.js";
import { runInTransaction } from "../feedRecommendation/feedRecommendation.utils.js";
import { MAX_TEXT_LENGTH } from "./feedRecord.constants.js";

export type TPayload = Record<string, unknown>;

export const DAY_MS = 24 * 60 * 60 * 1000;

export const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const isBlank = (value: unknown) =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");

export const parseObjectId = (field: string, value: unknown): Types.ObjectId => {
  if (typeof value !== "string" || !isValidObjectId(value)) {
    throw new AppError(status.BAD_REQUEST, `${field} must be a valid id!`);
  }
  return new Types.ObjectId(value);
};

export const parseEnum = (field: string, value: unknown, allowed: readonly string[]): string => {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new AppError(status.BAD_REQUEST, `${field} must be one of: ${allowed.join(", ")}!`);
  }
  return value;
};

//comma-separated enum list from a query string
export const parseEnumList = (field: string, value: unknown, allowed: readonly string[]): string[] =>
  String(value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => parseEnum(field, v, allowed));

export const parseNumber = (
  field: string,
  value: unknown,
  { min, max, exclusiveMin = false }: { min: number; max: number; exclusiveMin?: boolean },
): number => {
  const num = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isFinite(num)) {
    throw new AppError(status.BAD_REQUEST, `${field} must be a number!`);
  }
  if (exclusiveMin ? num <= min : num < min) {
    throw new AppError(status.BAD_REQUEST, `${field} must be ${exclusiveMin ? "greater than" : "at least"} ${min}!`);
  }
  if (num > max) throw new AppError(status.BAD_REQUEST, `${field} cannot exceed ${max}!`);
  return num;
};

export const parseText = (field: string, value: unknown): string | undefined => {
  if (isBlank(value)) return undefined;
  if (typeof value !== "string") throw new AppError(status.BAD_REQUEST, `${field} must be text!`);
  const text = value.trim();
  if (text.length > MAX_TEXT_LENGTH) {
    throw new AppError(status.BAD_REQUEST, `${field} cannot exceed ${MAX_TEXT_LENGTH} characters!`);
  }
  return text;
};

export const parseBoolean = (value: unknown): boolean => value === true || value === "true";

/**
 * A feeding happens on a calendar day; the time of day is the feedingSession.
 * "2026-08-17" (or the date part of an ISO string) is stored as 2026-08-17T00:00:00Z,
 * so the day never shifts with the server's or the client's time zone.
 */
export const parseCalendarDate = (field: string, value: unknown): Date => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? "").trim());
  if (!match) throw new AppError(status.BAD_REQUEST, `${field} must be a date (YYYY-MM-DD)!`);
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(d)) {
    throw new AppError(status.BAD_REQUEST, `${field} is not a valid calendar date!`);
  }
  return date;
};

//query range: from = start of day, to = end of day (inclusive)
export const parseDateRange = (query: TPayload, field = "feedingDate") => {
  const range: Record<string, Date> = {};
  if (!isBlank(query.from)) range.$gte = parseCalendarDate("from", query.from);
  if (!isBlank(query.to)) range.$lte = new Date(parseCalendarDate("to", query.to).getTime() + DAY_MS - 1);
  if (range.$gte && range.$lte && range.$gte > range.$lte) {
    throw new AppError(status.BAD_REQUEST, "from must be before to!");
  }
  return Object.keys(range).length ? { [field]: range } : {};
};

export const dayKey = (date: Date | string) => new Date(date).toISOString().slice(0, 10);

export const parsePaging = (query: TPayload, maxLimit: number, defaultLimit = 10) => {
  const page = Math.max(Math.floor(Number(query.page)) || 1, 1);
  const limit = Math.min(Math.max(Math.floor(Number(query.limit)) || defaultLimit, 1), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
};

export const pageMeta = (page: number, limit: number, total: number) => ({
  page,
  limit,
  totalEntries: total,
  totalPage: Math.ceil(total / limit),
});

export type TUndo = (() => Promise<unknown>)[];

/**
 * Runs `work` in a MongoDB transaction (all-or-nothing). On a standalone mongod
 * (no transactions) `work` runs without a session; every write then registers an
 * undo step, and on failure the steps run in reverse so no half-applied
 * FeedRecord/stock state remains (spec §69–70 compensation).
 */
export const executeAtomically = <T>(
  // eslint-disable-next-line no-unused-vars
  work: (session: ClientSession | null, undo: TUndo) => Promise<T>,
): Promise<T> =>
  runInTransaction(async (session) => {
    const undo: TUndo = [];
    try {
      return await work(session, undo);
    } catch (error) {
      if (!session) {
        for (const step of undo.reverse()) {
          try {
            await step();
          } catch (undoError) {
            console.error("FeedRecord compensation step failed:", undoError);
          }
        }
      }
      throw error;
    }
  });
