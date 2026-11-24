import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import status from "http-status";
import { model, Schema } from "mongoose";
import type { ClientSession, Types } from "mongoose";
import multer from "multer";
import AppError from "../../errors/AppError.js";
import { FarmStatuses } from "../farm/farm.constants.js";
import { FarmModel } from "../farm/farm.model.js";
import type { TFarmMemberRole } from "../farmMember/farmMember.interface.js";
import { FarmMemberServices } from "../farmMember/farmMember.service.js";
import { DAY_MS, isBlank, parseCalendarDate, parseNumber } from "../feedRecord/feedRecord.utils.js";
import type { TPayload } from "../feedRecord/feedRecord.utils.js";
import { roundMoney } from "../inventory/inventory.utils.js";
import {
  FUTURE_TOLERANCE_HOURS,
  MAX_AMOUNT,
  MAX_ATTACHMENT_BYTES,
  MAX_BACKDATE_DAYS,
  MAX_DESCRIPTION,
  MAX_REASON,
  SERVER_MANAGED_FIELDS,
  TRAIL_LINE,
} from "./finance.constants.js";

/* ------------------------------- numbering -------------------------------- */

// Atomic per-year sequence, outside any transaction (gaps are harmless).
type TFinanceCounter = { _id: string; seq: number };
const financeCounterSchema = new Schema<TFinanceCounter>(
  { _id: { type: String, required: true }, seq: { type: Number, required: true, default: 0 } },
  { versionKey: false },
);
const FinanceCounterModel = model<TFinanceCounter>("FinanceCounter", financeCounterSchema);

/** EXP-2026-000001 / INC-2026-000001. */
export const generateFinanceNo = async (prefix: string): Promise<string> => {
  const year = new Date().getFullYear();
  const counter = await FinanceCounterModel.findOneAndUpdate(
    { _id: `${prefix}-${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  return `${prefix}-${year}-${String(counter?.seq ?? 1).padStart(6, "0")}`;
};

/* ------------------------------ authorization ----------------------------- */

export type TFinanceAccess = {
  //User _id of the caller (Animal.updatedBy references User)
  userObjectId: Types.ObjectId;
  farmObjectId: Types.ObjectId;
  farmStatus: string;
  role: TFarmMemberRole;
  //null only for a super admin without a membership row (read-only here)
  memberObjectId: Types.ObjectId | null;
};

export const can = (access: TFinanceAccess, allowed: readonly string[]) => allowed.includes(access.role);

export const requireRole = (access: TFinanceAccess, allowed: readonly string[], action: string) => {
  if (!can(access, allowed)) {
    throw new AppError(status.FORBIDDEN, `Your farm role (${access.role}) is not allowed to ${action}!`);
  }
};

/** Active membership (super admin / Farm.ownerId act as Owner) + farm role check. */
export const resolveFinanceAccess = async (
  farmId: string,
  requesterUserId: string,
  allowed: readonly string[],
  action: string,
): Promise<TFinanceAccess> => {
  const access = await FarmMemberServices.resolveFarmAccess(farmId, requesterUserId);
  const role = FarmMemberServices.getActorRole(access);
  if (!role) throw new AppError(status.FORBIDDEN, "You are not an active member of this farm!");
  if (!allowed.includes(role)) {
    throw new AppError(status.FORBIDDEN, `Your farm role (${role}) is not allowed to ${action}!`);
  }
  let memberObjectId = (access.membership?._id as Types.ObjectId | undefined) ?? null;
  if (!memberObjectId && access.isOwnerAccount) {
    const row = await FarmMemberServices.ensureOwnerMembership(access.farm._id, access.user._id);
    memberObjectId = (row?._id as Types.ObjectId | undefined) ?? null;
  }
  const farm = await FarmModel.findById(access.farm._id).select("status").lean();
  return {
    userObjectId: access.user._id,
    farmObjectId: access.farm._id,
    farmStatus: farm?.status ?? FarmStatuses.ACTIVE,
    role,
    memberObjectId,
  };
};

/** Writes need an Active farm and a FarmMember row to sign them. */
export const requireWriter = (access: TFinanceAccess): Types.ObjectId => {
  if (access.farmStatus !== FarmStatuses.ACTIVE) {
    throw new AppError(
      status.FORBIDDEN,
      `This farm is ${access.farmStatus} — financial records can only be changed on an Active farm!`,
    );
  }
  if (!access.memberObjectId) {
    throw new AppError(status.FORBIDDEN, "An active farm membership is required to change financial records!");
  }
  return access.memberObjectId;
};

/* --------------------------------- parsing -------------------------------- */

export const sessionOpts = (session: ClientSession | null) => (session ? { session } : {});

export const rejectServerFields = (body: TPayload) => {
  const sent = SERVER_MANAGED_FIELDS.filter((field) => field in body);
  if (sent.length) {
    throw new AppError(status.BAD_REQUEST, `${sent.join(", ")} cannot be sent — the server manages these values.`);
  }
};

export const parseText = (field: string, value: unknown, max: number): string | null => {
  if (isBlank(value)) return null;
  if (typeof value !== "string") throw new AppError(status.BAD_REQUEST, `${field} must be text!`);
  const text = value.trim();
  if (text.length > max) throw new AppError(status.BAD_REQUEST, `${field} cannot exceed ${max} characters!`);
  return text;
};

export const requireReason = (value: unknown, action: string): string => {
  const text = parseText("reason", value, MAX_REASON);
  if (!text || text.length < 3) {
    throw new AppError(status.BAD_REQUEST, `reason is required to ${action} (at least 3 characters)!`);
  }
  //one line only, so it can never forge another trail line
  return text.replace(/\s+/g, " ");
};

/** Money: rounded to 2 decimals and strictly positive (0.001 must not round to 0). */
export const parseAmount = (field: string, value: unknown): number => {
  const amount = roundMoney(parseNumber(field, value, { min: 0, max: MAX_AMOUNT, exclusiveMin: true }));
  if (amount <= 0) throw new AppError(status.BAD_REQUEST, `${field} must be greater than 0!`);
  return amount;
};

/** Business date (UTC-midnight day): may be backdated, never in the future. */
export const parseBusinessDate = (field: string, value: unknown): Date => {
  const date = parseCalendarDate(field, isBlank(value) ? new Date().toISOString() : value);
  if (date.getTime() > Date.now() + FUTURE_TOLERANCE_HOURS * 3_600_000) {
    throw new AppError(status.BAD_REQUEST, `${field} cannot be in the future!`);
  }
  if (date.getTime() < Date.now() - MAX_BACKDATE_DAYS * DAY_MS) {
    throw new AppError(status.BAD_REQUEST, `${field} is too far in the past!`);
  }
  return date;
};

/* ------------------------- description + audit trail ---------------------- */

/** Splits the stored description into what the user wrote and the server's notes. */
export const splitDescription = (stored?: string | null) => {
  const lines = (stored ?? "").split(/\r?\n/);
  return {
    text: lines.filter((line) => !TRAIL_LINE.test(line.trim())).join("\n").trim(),
    trail: lines.filter((line) => TRAIL_LINE.test(line.trim())),
  };
};

/** User text, with any line that imitates a server note removed. */
export const parseDescription = (value: unknown): string | null => {
  const text = parseText("description", value, MAX_DESCRIPTION);
  return text ? splitDescription(text).text || null : null;
};

/** New user text, keeping every note the server already wrote. */
export const withDescriptionText = (stored: string | null | undefined, text: string | null) =>
  [text ?? "", ...splitDescription(stored).trail].filter(Boolean).join("\n");

export const appendTrail = (stored: string | null | undefined, label: string, date: Date, note: string) =>
  [stored ?? "", `[${label} ${date.toISOString().slice(0, 10)}] ${note}`.trim()].filter(Boolean).join("\n");

/* -------------------------------- receipts -------------------------------- */

/**
 * Receipts are private: they are kept on disk (no public CDN, no static route) and only
 * streamed by GET /:id/attachment after the same farm / role check as the record.
 */
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
}).single("attachment");

export const uploadAttachment = (req: Request, res: Response, next: NextFunction) => {
  attachmentUpload(req, res, (error: unknown) => {
    if (!error) return next();
    const tooLarge = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
    next(
      new AppError(
        status.BAD_REQUEST,
        tooLarge
          ? "The attachment cannot exceed 5 MB!"
          : "The attachment could not be read — send one file in the `attachment` field.",
      ),
    );
  });
};

//content sniffing: the client's mimetype and file name are never trusted
const sniff = (buffer: Buffer): string | null => {
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") {
    return "webp";
  }
  return null;
};

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const financeDir = (farmObjectId: Types.ObjectId) => path.join("uploads", "finance", String(farmObjectId));

export const saveAttachment = async (farmObjectId: Types.ObjectId, buffer: Buffer): Promise<string> => {
  const extension = sniff(buffer);
  if (!extension) throw new AppError(status.BAD_REQUEST, "The attachment must be a PDF, JPG, PNG or WebP file!");
  const dir = financeDir(farmObjectId);
  await fs.mkdir(path.join(process.cwd(), dir), { recursive: true });
  const relative = path.join(dir, `${randomUUID()}.${extension}`).replaceAll("\\", "/");
  await fs.writeFile(path.join(process.cwd(), relative), buffer);
  return relative;
};

export const discardAttachment = (relative: string) =>
  fs.unlink(path.join(process.cwd(), relative)).catch(() => undefined);

export const readAttachment = async (farmObjectId: Types.ObjectId, relative: string, name: string) => {
  const absolute = path.resolve(process.cwd(), relative);
  //a stored path can only ever point into this farm's own folder
  if (!absolute.startsWith(path.resolve(process.cwd(), financeDir(farmObjectId)) + path.sep)) {
    throw new AppError(status.NOT_FOUND, "The attachment file is not available!");
  }
  const extension = path.extname(absolute).slice(1);
  const buffer = await fs.readFile(absolute).catch(() => null);
  if (!buffer) throw new AppError(status.NOT_FOUND, "The attachment file is not available!");
  return { buffer, mime: MIME[extension] ?? "application/octet-stream", fileName: `${name}.${extension}` };
};

/** Permanent farm deletion removes its receipts too. */
export const removeFarmAttachments = (farmObjectId: Types.ObjectId) =>
  fs.rm(path.join(process.cwd(), financeDir(farmObjectId)), { recursive: true, force: true }).catch(() => undefined);
