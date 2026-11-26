// Device (Model 25) enums follow the final DB schema and are stored as-is.
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";
import type { TFarmMemberRole } from "../farmMember/farmMember.interface.js";

export const DeviceTypes = {
  BOLUS: "Bolus",
  NECK_COLLAR: "Neck Collar",
  EAR_TAG: "Ear Tag",
  MILK_METER: "Milk Meter",
  TEMPERATURE_SENSOR: "Temperature Sensor",
  ENVIRONMENT_SENSOR: "Environment Sensor",
  WATER_METER: "Water Meter",
  OTHER: "Other",
} as const;

export const CommunicationProtocols = {
  BLUETOOTH: "Bluetooth",
  WIFI: "WiFi",
  LORAWAN: "LoRaWAN",
  NB_IOT: "NB-IoT",
  LTE: "LTE",
  RFID: "RFID",
  API: "API",
} as const;

export const BatteryTypes = {
  RECHARGEABLE: "Rechargeable",
  REPLACEABLE: "Replaceable",
  INTERNAL: "Internal",
  NOT_APPLICABLE: "Not Applicable",
} as const;

//Online: set by a successful sync only. Offline: no sync for OFFLINE_AFTER_HOURS.
//Disconnected: reported by a user (removed / unreachable).
export const ConnectionStatuses = {
  ONLINE: "Online",
  OFFLINE: "Offline",
  DISCONNECTED: "Disconnected",
  MAINTENANCE: "Maintenance",
} as const;

export const DeviceHealthStatuses = {
  HEALTHY: "Healthy",
  WARNING: "Warning",
  CRITICAL: "Critical",
  FAULTY: "Faulty",
} as const;

//derived, never stored
export const WarrantyStates = { ACTIVE: "Active", EXPIRING: "Expiring", EXPIRED: "Expired", UNKNOWN: "Unknown" } as const;
export const BatteryStates = { NORMAL: "Normal", LOW: "Low", CRITICAL: "Critical", UNKNOWN: "Unknown" } as const;

//DeviceAssignment (Model 26) values needed to close an assignment on deactivation
export const RemovalReasons = [
  "Maintenance",
  "Battery Failure",
  "Device Fault",
  "Animal Sold",
  "Animal Dead",
  "Replacement",
  "Lost",
  "Manual Removal",
] as const;

export const OFFLINE_AFTER_HOURS = 24;
export const WARRANTY_SOON_DAYS = 30;
export const BATTERY_LOW = 20;
export const BATTERY_CRITICAL = 10;

export const DEVICE_CODE_PREFIX = "DEV";
export const DEVICE_CODE_PATTERN = /^DEV-\d{6,}$/i;
export const MAX_NAME = 100;
export const MAX_SERIAL = 100;
export const MAX_FIRMWARE = 50;
export const MAX_NOTES = 1000;
export const MAX_REASON = 300;
export const DEVICE_MAX_LIMIT = 100;
export const DASHBOARD_LIST_LIMIT = 8;

//locked after the first assignment or reading
export const IDENTITY_FIELDS: readonly string[] = ["company", "model", "serialNumber", "deviceType"];

export const DEVICE_SORT_FIELDS = [
  "createdAt",
  "deviceCode",
  "company",
  "deviceType",
  "lastSyncAt",
  "batteryLevel",
  "warrantyExpiry",
] as const;

const { OWNER, MANAGER, VETERINARIAN, WORKER } = FarmMemberRoles;
export const DevicePermissions: Record<"READ" | "WRITE" | "OWNER", readonly TFarmMemberRole[]> = {
  READ: [OWNER, MANAGER, VETERINARIAN, WORKER],
  WRITE: [OWNER, MANAGER],
  OWNER: [OWNER],
};
