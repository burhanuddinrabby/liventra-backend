import type { Request } from "express";
import { Types } from "mongoose";
import { UserModel } from "../auth/auth.model.js";
import { AUDIT_LOG_NO_PREFIX, AuditDeviceTypes, AuditStatuses } from "./auditLog.constants.js";
import { AuditCounterModel, AuditLogModel } from "./auditLog.model.js";
import type {
  TAuditAction,
  TAuditDeviceType,
  TAuditEntityType,
  TAuditModule,
} from "./auditLog.interface.js";

//example: LOG-000001 (atomic counter, safe under concurrent writes)
const generateLogNo = async (): Promise<string> => {
  const counter = await AuditCounterModel.findOneAndUpdate(
    { _id: "auditLog" },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  return `${AUDIT_LOG_NO_PREFIX}-${String(counter?.seq ?? 1).padStart(6, "0")}`;
};

const detectDeviceType = (userAgent?: string): TAuditDeviceType => {
  if (!userAgent) return AuditDeviceTypes.API;
  if (/ipad|tablet/i.test(userAgent)) return AuditDeviceTypes.TABLET;
  if (/mobi|android|iphone/i.test(userAgent)) return AuditDeviceTypes.MOBILE;
  if (/mozilla|chrome|safari|firefox|edge/i.test(userAgent)) return AuditDeviceTypes.DESKTOP;
  return AuditDeviceTypes.API;
};

//request metadata stored with each audit row (never the token or request body)
export type TAuditContext = {
  //custom string userId from the JWT (U-YY-NNNN); resolved to the User _id on write
  actorUserId?: string;
  ipAddress?: string;
  userAgent?: string;
};

export const auditContextFromRequest = (req: Request): TAuditContext => {
  const context: TAuditContext = {};
  const actor = req.user?.userId as string | undefined;
  if (actor) context.actorUserId = actor;
  if (req.ip) context.ipAddress = req.ip;
  const userAgent = req.get("user-agent");
  if (userAgent) context.userAgent = userAgent;
  return context;
};

type TRecordAuditInput = {
  context?: TAuditContext | undefined;
  farmId?: Types.ObjectId | string | null;
  entityType: TAuditEntityType;
  entityId?: Types.ObjectId | string | null;
  action: TAuditAction;
  module: TAuditModule;
  event?: string;
  oldData?: Record<string, unknown> | null;
  newData?: Record<string, unknown> | null;
  changedFields?: string[];
};

/**
 * Best-effort audit write. The business change is already committed when this
 * runs (the project has no multi-document transactions), so a failed audit insert
 * is logged to the console instead of failing the user's request.
 */
export const recordAuditLog = async (input: TRecordAuditInput): Promise<void> => {
  try {
    let userObjectId: Types.ObjectId | null = null;
    if (input.context?.actorUserId) {
      const actor = await UserModel.findOne({ userId: input.context.actorUserId })
        .select("_id")
        .lean();
      userObjectId = (actor?._id as Types.ObjectId | undefined) ?? null;
    }

    const logNo = await generateLogNo();
    await AuditLogModel.create({
      logNo,
      farmId: input.farmId ? new Types.ObjectId(String(input.farmId)) : null,
      userId: userObjectId,
      entityType: input.entityType,
      entityId: input.entityId ? new Types.ObjectId(String(input.entityId)) : null,
      action: input.action,
      module: input.module,
      ...(input.event ? { event: input.event } : {}),
      oldData: input.oldData ?? null,
      newData: input.newData ?? null,
      changedFields: input.changedFields ?? [],
      ...(input.context?.ipAddress ? { ipAddress: input.context.ipAddress } : {}),
      ...(input.context?.userAgent ? { userAgent: input.context.userAgent } : {}),
      deviceType: detectDeviceType(input.context?.userAgent),
      status: AuditStatuses.SUCCESS,
    });
  } catch (error) {
    console.error("Failed to write audit log:", error);
  }
};
