import { model, Schema } from "mongoose";
import {
  MAX_MESSAGE_LENGTH,
  MAX_TITLE_LENGTH,
  NOTIFICATION_NO_PREFIX,
  NotificationPriorities,
  NotificationReferenceTypes,
  NotificationStatuses,
  NotificationTypes,
} from "./notification.constants.js";
import type { TNotification } from "./notification.interface.js";

const notificationSchema = new Schema<TNotification>(
  {
    notificationNo: { type: String, required: true, unique: true, immutable: true },
    farmId: { type: Schema.Types.ObjectId, ref: "Farm", required: true, immutable: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    title: { type: String, required: true, immutable: true, maxlength: MAX_TITLE_LENGTH },
    message: { type: String, required: true, maxlength: MAX_MESSAGE_LENGTH },
    type: { type: String, enum: Object.values(NotificationTypes), required: true, immutable: true },
    priority: { type: String, enum: Object.values(NotificationPriorities), required: true, immutable: true },
    referenceType: { type: String, enum: Object.values(NotificationReferenceTypes), required: true, immutable: true },
    referenceId: { type: Schema.Types.ObjectId, default: null, immutable: true },
    isRead: { type: Boolean, required: true, default: false },
    readAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    status: {
      type: String,
      enum: Object.values(NotificationStatuses),
      required: true,
      default: NotificationStatuses.ACTIVE,
    },
  },
  { timestamps: true },
);

//inbox
notificationSchema.index({ farmId: 1, userId: 1, status: 1, isRead: 1, createdAt: -1 });
//all farms of one user
notificationSchema.index({ userId: 1, status: 1, createdAt: -1 });
notificationSchema.index({ farmId: 1, referenceType: 1, referenceId: 1 });
//expire job
notificationSchema.index({ status: 1, expiresAt: 1 });
//one active row per event and recipient
notificationSchema.index(
  { farmId: 1, userId: 1, referenceType: 1, referenceId: 1, title: 1 },
  {
    unique: true,
    partialFilterExpression: { status: NotificationStatuses.ACTIVE, referenceId: { $type: "objectId" } },
  },
);

export const NotificationModel = model<TNotification>("Notification", notificationSchema);

type TNotificationCounter = { _id: string; seq: number };

const notificationCounterSchema = new Schema<TNotificationCounter>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);

const NotificationCounterModel = model<TNotificationCounter>("NotificationCounter", notificationCounterSchema);

/** NOT-2026-000001 (atomic, never inside a transaction; gaps are harmless). */
export const generateNotificationNo = async (): Promise<string> => {
  const year = new Date().getFullYear();
  const counter = await NotificationCounterModel.findOneAndUpdate(
    { _id: `notification-${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  return `${NOTIFICATION_NO_PREFIX}-${year}-${String(counter?.seq ?? 1).padStart(6, "0")}`;
};
