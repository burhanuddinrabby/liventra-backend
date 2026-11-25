import type { Types } from "mongoose";
import type {
  TNotificationPriority,
  TNotificationReferenceType,
  TNotificationStatus,
  TNotificationType,
} from "./notification.constants.js";

export type TNotification = {
  notificationNo: string;
  farmId: Types.ObjectId;
  userId: Types.ObjectId;
  title: string;
  message: string;
  type: TNotificationType;
  priority: TNotificationPriority;
  referenceType: TNotificationReferenceType;
  referenceId?: Types.ObjectId | null;
  isRead: boolean;
  readAt?: Date | null;
  expiresAt?: Date | null;
  status: TNotificationStatus;
  createdAt?: Date;
  updatedAt?: Date;
};
