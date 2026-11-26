// SensorData (Model 27) values follow the final DB schema and are stored as-is.
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";
import type { TFarmMemberRole } from "../farmMember/farmMember.interface.js";

export const SensorSources = {
  API: "API",
  MQTT: "MQTT",
  BLUETOOTH: "Bluetooth",
  MANUAL_IMPORT: "Manual Import",
} as const;

//only these mean "the device itself sent it": they set lastSyncAt and Online (plan 7 §7.2)
export const MACHINE_SOURCES: readonly string[] = [SensorSources.API, SensorSources.MQTT, SensorSources.BLUETOOTH];

/**
 * The metric keys of the schema, with the unit the app fixes for each (shown in the UI).
 * Only impossible values are refused: not finite, negative (except temperature), battery outside
 * 0–100, more rumination minutes than a day has, a temperature no thermometer on an animal reads,
 * or a fractional step count.
 */
export const SENSOR_METRICS = {
  bodyTemperature: { unit: "°C", min: -50, max: 100, integer: false },
  ruminationMinutes: { unit: "min/24 h", min: 0, max: 1440, integer: false },
  activityScore: { unit: "score", min: 0, max: null, integer: false },
  steps: { unit: "steps", min: 0, max: null, integer: true },
  waterIntake: { unit: "L", min: 0, max: null, integer: false },
  feedIntake: { unit: "kg", min: 0, max: null, integer: false },
  milkYield: { unit: "L", min: 0, max: null, integer: false },
  heartRate: { unit: "beats/min", min: 0, max: null, integer: false },
  respirationRate: { unit: "breaths/min", min: 0, max: null, integer: false },
  batteryLevel: { unit: "%", min: 0, max: 100, integer: false },
} as const;

export type TMetricKey = keyof typeof SENSOR_METRICS;
export const METRIC_KEYS = Object.keys(SENSOR_METRICS) as TMetricKey[];

export const SensorAlertTypes = {
  TEMPERATURE: "Temperature",
  RUMINATION: "Rumination",
  ACTIVITY: "Activity",
  WATER_INTAKE: "Water Intake",
  FEED_INTAKE: "Feed Intake",
  MILK_YIELD: "Milk Yield",
  HEART_RATE: "Heart Rate",
  RESPIRATION: "Respiration",
  BATTERY: "Battery",
} as const;

export const SensorAlertSeverities = { LOW: "Low", MEDIUM: "Medium", HIGH: "High", CRITICAL: "Critical" } as const;
export const SEVERITY_ORDER: readonly string[] = ["Low", "Medium", "High", "Critical"];

//pipeline limits (plan 7 §7.2)
export const FUTURE_SKEW_MS = 5 * 60 * 1000;
export const IMPORT_MAX_AGE_DAYS = 730;
export const MACHINE_MAX_AGE_DAYS = 30;
export const RAW_PAYLOAD_MAX_BYTES = 8 * 1024;
export const MAX_ALERT_MESSAGE = 300;
export const MAX_ALERTS_PER_READING = 20;

//CSV import (plan 7 §7.4)
export const CSV_MAX_BYTES = 2 * 1024 * 1024;
export const CSV_MAX_ROWS = 5000;
export const CSV_DEVICE_COLUMNS = ["deviceCode", "serialNumber"] as const;
export const INSERT_CHUNK = 1000;

//read limits
export const LIST_DEFAULT_HOURS = 24;
export const LIST_MAX_DAYS = 31;
export const ALERTS_DEFAULT_DAYS = 7;
export const TREND_DEFAULT_DAYS = 7;
export const TREND_MAX_DAYS = { hour: 31, day: 366 } as const;
export const TrendBuckets = { HOUR: "hour", DAY: "day" } as const;
export const SENSOR_MAX_LIMIT = 100;
export const STALE_AFTER_HOURS = 24;
export const DASHBOARD_LIST_LIMIT = 10;

//notifications (plan 7 §7.3): one per animal + title per 6 h, only for readings under 24 h old
export const NOTIFY_EVERY_HOURS = 6;
export const NOTIFY_MAX_AGE_HOURS = 24;
export const LIVE_EVENT_MAX_READINGS = 20;

const { OWNER, MANAGER, VETERINARIAN, WORKER } = FarmMemberRoles;
export const SensorPermissions: Record<"READ" | "MANUAL" | "IMPORT" | "RAW", readonly TFarmMemberRole[]> = {
  READ: [OWNER, MANAGER, VETERINARIAN, WORKER],
  MANUAL: [OWNER, MANAGER, VETERINARIAN],
  IMPORT: [OWNER, MANAGER],
  //the vendor payload may carry vendor identifiers: Owner only
  RAW: [OWNER],
};
