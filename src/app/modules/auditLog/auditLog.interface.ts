import type { Types } from "mongoose";
import type {
  AuditActions,
  AuditDeviceTypes,
  AuditEntityTypes,
  AuditModules,
  AuditStatuses,
} from "./auditLog.constants.js";

export type TAuditEntityType = (typeof AuditEntityTypes)[keyof typeof AuditEntityTypes];
export type TAuditAction = (typeof AuditActions)[keyof typeof AuditActions];
export type TAuditModule = (typeof AuditModules)[keyof typeof AuditModules];
export type TAuditStatus = (typeof AuditStatuses)[keyof typeof AuditStatuses];
export type TAuditDeviceType = (typeof AuditDeviceTypes)[keyof typeof AuditDeviceTypes];

export type TAuditLog = {
  logNo: string;
  //null for platform-level master data (breeds, feed ingredients)
  farmId: Types.ObjectId | null;
  //null for system-generated actions
  userId: Types.ObjectId | null;
  entityType: TAuditEntityType;
  entityId: Types.ObjectId | null;
  action: TAuditAction;
  module: TAuditModule;
  //human summary, e.g. "Ingredient Price Changed"
  event?: string;
  oldData: Record<string, unknown> | null;
  newData: Record<string, unknown> | null;
  changedFields: string[];
  ipAddress?: string;
  userAgent?: string;
  deviceType?: TAuditDeviceType;
  requestId?: string;
  status: TAuditStatus;
  createdAt?: Date;
};
