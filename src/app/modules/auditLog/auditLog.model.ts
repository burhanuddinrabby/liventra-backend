import { model, Schema } from "mongoose";
import {
  AuditActions,
  AuditDeviceTypes,
  AuditEntityTypes,
  AuditModules,
  AuditStatuses,
} from "./auditLog.constants.js";
import type { TAuditLog } from "./auditLog.interface.js";

// Audit rows are append-only evidence: every field is immutable and the API has
// no update/delete path for them.
const auditLogSchema = new Schema<TAuditLog>(
  {
    logNo: { type: String, required: true, unique: true, immutable: true },
    farmId: { type: Schema.Types.ObjectId, ref: "Farm", default: null, immutable: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, immutable: true },
    entityType: {
      type: String,
      enum: Object.values(AuditEntityTypes),
      required: true,
      immutable: true,
    },
    entityId: { type: Schema.Types.ObjectId, default: null, immutable: true },
    action: {
      type: String,
      enum: Object.values(AuditActions),
      required: true,
      immutable: true,
    },
    module: {
      type: String,
      enum: Object.values(AuditModules),
      required: true,
      immutable: true,
    },
    event: { type: String, trim: true, immutable: true },
    oldData: { type: Schema.Types.Mixed, default: null, immutable: true },
    newData: { type: Schema.Types.Mixed, default: null, immutable: true },
    changedFields: { type: [String], default: [], immutable: true },
    ipAddress: { type: String, immutable: true },
    userAgent: { type: String, immutable: true },
    deviceType: { type: String, enum: Object.values(AuditDeviceTypes), immutable: true },
    requestId: { type: String, immutable: true },
    status: {
      type: String,
      enum: Object.values(AuditStatuses),
      required: true,
      default: AuditStatuses.SUCCESS,
      immutable: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// entity timeline ("history of this record") and farm/user audit screens
auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ farmId: 1, createdAt: -1 });
auditLogSchema.index({ userId: 1, createdAt: -1 });

export const AuditLogModel = model<TAuditLog>("AuditLog", auditLogSchema);

// Atomic sequence for logNo. Audit writes can happen concurrently, so the
// last-row+1 pattern used for display IDs elsewhere would collide here.
type TAuditCounter = { _id: string; seq: number };

const auditCounterSchema = new Schema<TAuditCounter>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);

export const AuditCounterModel = model<TAuditCounter>("AuditCounter", auditCounterSchema);
