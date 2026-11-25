// Notification (Model 23) enums follow the final DB schema and are stored as-is.
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";
import type { TFarmMemberRole } from "../farmMember/farmMember.interface.js";

export const NotificationTypes = {
  REMINDER: "Reminder",
  ALERT: "Alert",
  WARNING: "Warning",
  INFORMATION: "Information",
  SUCCESS: "Success",
} as const;

export const NotificationPriorities = { LOW: "Low", MEDIUM: "Medium", HIGH: "High", CRITICAL: "Critical" } as const;

export const NotificationReferenceTypes = {
  ANIMAL: "Animal",
  FEED_RECOMMENDATION: "FeedRecommendation",
  VACCINATION: "Vaccination",
  TREATMENT: "Treatment",
  INVENTORY: "Inventory",
  PREGNANCY: "Pregnancy",
  SENSOR_DATA: "SensorData",
  MANUAL: "Manual",
} as const;

export const NotificationStatuses = { ACTIVE: "Active", ARCHIVED: "Archived", EXPIRED: "Expired" } as const;

export type TNotificationType = (typeof NotificationTypes)[keyof typeof NotificationTypes];
export type TNotificationPriority = (typeof NotificationPriorities)[keyof typeof NotificationPriorities];
export type TNotificationReferenceType = (typeof NotificationReferenceTypes)[keyof typeof NotificationReferenceTypes];
export type TNotificationStatus = (typeof NotificationStatuses)[keyof typeof NotificationStatuses];

export type TNotificationEvent = {
  //fixed English text: also the event key of the duplicate guard, so never change a used title
  title: string;
  type: TNotificationType;
  priority: TNotificationPriority;
  referenceType: TNotificationReferenceType;
  roles: readonly TFarmMemberRole[];
};

const { OWNER, MANAGER, WORKER, VETERINARIAN } = FarmMemberRoles;
const { REMINDER, ALERT, WARNING, SUCCESS } = NotificationTypes;
const { MEDIUM, HIGH, CRITICAL } = NotificationPriorities;
const { ANIMAL, FEED_RECOMMENDATION, VACCINATION, TREATMENT, INVENTORY, PREGNANCY } = NotificationReferenceTypes;

const define = (
  title: string,
  type: TNotificationType,
  priority: TNotificationPriority,
  referenceType: TNotificationReferenceType,
  roles: readonly TFarmMemberRole[],
): TNotificationEvent => ({ title, type, priority, referenceType, roles });

const CLINICAL = [OWNER, MANAGER, VETERINARIAN];
const STOCK = [OWNER, MANAGER];

export const NotificationEvents = {
  VACCINATION_DUE_SOON: define("Vaccination Due Soon", REMINDER, MEDIUM, VACCINATION, CLINICAL),
  VACCINATION_DUE_TOMORROW: define("Vaccination Due Tomorrow", REMINDER, HIGH, VACCINATION, CLINICAL),
  VACCINATION_OVERDUE: define("Vaccination Overdue", WARNING, HIGH, VACCINATION, CLINICAL),
  FOLLOW_UP_DUE: define("Treatment Follow-up Due", REMINDER, HIGH, TREATMENT, CLINICAL),
  WITHDRAWAL_ACTIVE: define("Medicine Withdrawal Active", WARNING, HIGH, TREATMENT, [OWNER, MANAGER, WORKER]),
  CONTAGIOUS_DISEASE: define("Contagious Disease Detected", ALERT, CRITICAL, TREATMENT, CLINICAL),
  PREGNANCY_CHECK_DUE: define("Pregnancy Check Due", REMINDER, MEDIUM, ANIMAL, CLINICAL),
  PREGNANCY_CONFIRMED: define("Pregnancy Confirmed", SUCCESS, MEDIUM, PREGNANCY, CLINICAL),
  CALVING_SOON: define("Calving Soon", REMINDER, MEDIUM, PREGNANCY, [...CLINICAL, WORKER]),
  CALVING_IN_3_DAYS: define("Calving In 3 Days", REMINDER, HIGH, PREGNANCY, [...CLINICAL, WORKER]),
  CALVING_OVERDUE: define("Calving Overdue", WARNING, CRITICAL, PREGNANCY, [...CLINICAL, WORKER]),
  BIRTH_RECORDED: define("Birth Recorded", SUCCESS, MEDIUM, PREGNANCY, CLINICAL),
  FEED_PLAN_READY: define("Feed Recommendation Ready", REMINDER, MEDIUM, FEED_RECOMMENDATION, [OWNER, MANAGER, WORKER]),
  LOW_STOCK: define("Low Stock", ALERT, HIGH, INVENTORY, STOCK),
  OUT_OF_STOCK: define("Out of Stock", ALERT, CRITICAL, INVENTORY, STOCK),
  ITEM_EXPIRING_SOON: define("Item Expiring Soon", WARNING, MEDIUM, INVENTORY, STOCK),
  ITEM_EXPIRING_THIS_WEEK: define("Item Expiring This Week", WARNING, HIGH, INVENTORY, STOCK),
  ITEM_EXPIRED: define("Item Expired", WARNING, HIGH, INVENTORY, STOCK),
} as const;

//days before the due day a stage starts
export const LeadDays = {
  VACCINATION_SOON: 7,
  VACCINATION_TOMORROW: 1,
  FOLLOW_UP: 1,
  PREGNANCY_CHECK: 3,
  CALVING_SOON: 14,
  CALVING_NEAR: 3,
  EXPIRY_SOON: 30,
  EXPIRY_NEAR: 7,
} as const;
export const DUE_KEEP_DAYS = 1;
export const OVERDUE_KEEP_DAYS = 30;

export const NOTIFICATION_NO_PREFIX = "NOT";
export const NOTIFICATION_MAX_LIMIT = 100;
export const MAX_TITLE_LENGTH = 120;
export const MAX_MESSAGE_LENGTH = 1000;

export const ANNOUNCEMENT_EVENT = "Announcement Sent";
export const ANNOUNCEMENT_MAX_DAYS = 90;
export const ANNOUNCEMENT_DEFAULT_DAYS = 30;
export const ANNOUNCEMENTS_PER_HOUR = 10;
//Critical is reserved for system events: only the Owner can clear it
export const ANNOUNCEMENT_PRIORITIES = [
  NotificationPriorities.LOW,
  NotificationPriorities.MEDIUM,
  NotificationPriorities.HIGH,
] as const;
