/*
 * Sensor alert rules (plan 7 §7.3). Only the battery rules are on: medical limits stay off
 * until a veterinarian gives values (set `threshold` and `enabled: true` then).
 * Alerts are observations, not a diagnosis: nothing here touches Animal.healthStatus or creates
 * a Treatment.
 */
import { BATTERY_CRITICAL, BATTERY_LOW } from "../device/device.constants.js";
import {
  MAX_ALERT_MESSAGE,
  MAX_ALERTS_PER_READING,
  SENSOR_METRICS,
  SEVERITY_ORDER,
  SensorAlertSeverities,
  SensorAlertTypes,
} from "./sensorData.constants.js";
import type { TMetricKey } from "./sensorData.constants.js";
import type { TSensorAlert, TSensorAlertSeverity, TSensorAlertType, TSensorMetrics } from "./sensorData.interface.js";

export type TSensorRule = {
  id: string;
  type: TSensorAlertType;
  metric: TMetricKey;
  severity: TSensorAlertSeverity;
  //"at most" (lte) or "at least" (gte) the threshold
  op: "lte" | "gte";
  threshold: number | null;
  enabled: boolean;
};

const { BATTERY, TEMPERATURE, RUMINATION, ACTIVITY, WATER_INTAKE, FEED_INTAKE, MILK_YIELD, HEART_RATE, RESPIRATION } =
  SensorAlertTypes;
const { MEDIUM, HIGH } = SensorAlertSeverities;

const off = (id: string, type: TSensorAlertType, metric: TMetricKey, op: "lte" | "gte"): TSensorRule => ({
  id,
  type,
  metric,
  severity: HIGH,
  op,
  threshold: null,
  enabled: false,
});

export const SENSOR_ALERT_RULES: readonly TSensorRule[] = [
  { id: "battery-critical", type: BATTERY, metric: "batteryLevel", severity: HIGH, op: "lte", threshold: BATTERY_CRITICAL, enabled: true },
  { id: "battery-low", type: BATTERY, metric: "batteryLevel", severity: MEDIUM, op: "lte", threshold: BATTERY_LOW, enabled: true },
  //medical limits: off until a veterinarian gives values
  off("temperature-high", TEMPERATURE, "bodyTemperature", "gte"),
  off("temperature-low", TEMPERATURE, "bodyTemperature", "lte"),
  off("rumination-low", RUMINATION, "ruminationMinutes", "lte"),
  off("activity-low", ACTIVITY, "activityScore", "lte"),
  off("water-low", WATER_INTAKE, "waterIntake", "lte"),
  off("feed-low", FEED_INTAKE, "feedIntake", "lte"),
  off("milk-low", MILK_YIELD, "milkYield", "lte"),
  off("heart-rate-high", HEART_RATE, "heartRate", "gte"),
  off("respiration-high", RESPIRATION, "respirationRate", "gte"),
];

const rank = (severity: string) => SEVERITY_ORDER.indexOf(severity);

const messageFor = (rule: TSensorRule, value: number) => {
  const { unit } = SENSOR_METRICS[rule.metric];
  const shown = unit === "%" ? `${value}%` : `${value} ${unit}`;
  return `${rule.type} ${shown} (${rule.op === "lte" ? "at or below" : "at or above"} ${rule.threshold}${unit === "%" ? "%" : ` ${unit}`})`;
};

/** The most severe matching enabled rule per alert type. */
export const evaluateRules = (metrics: TSensorMetrics, rules: readonly TSensorRule[] = SENSOR_ALERT_RULES): TSensorAlert[] => {
  const best = new Map<string, TSensorAlert>();
  for (const rule of rules) {
    if (!rule.enabled || rule.threshold === null) continue;
    const value = metrics[rule.metric];
    if (value === undefined) continue;
    const hit = rule.op === "lte" ? value <= rule.threshold : value >= rule.threshold;
    if (!hit) continue;
    const current = best.get(rule.type);
    if (!current || rank(rule.severity) > rank(current.severity)) {
      best.set(rule.type, { type: rule.type, severity: rule.severity, message: messageFor(rule, value) });
    }
  }
  return [...best.values()];
};

/* ---------- vendor alerts (phase B adapters, and any source that sends them) ---------- */

const TYPE_WORDS: [RegExp, TSensorAlertType][] = [
  [/batt/i, BATTERY],
  [/temp|fever|heat\s*stress/i, TEMPERATURE],
  [/rumin/i, RUMINATION],
  [/activ|motion|step/i, ACTIVITY],
  [/water|drink/i, WATER_INTAKE],
  [/feed|eat/i, FEED_INTAKE],
  [/milk/i, MILK_YIELD],
  [/heart|pulse|bpm/i, HEART_RATE],
  [/resp|breath/i, RESPIRATION],
];

const SEVERITY_WORDS: [RegExp, TSensorAlertSeverity][] = [
  [/crit|sever|emerg/i, SensorAlertSeverities.CRITICAL],
  [/high|alarm|major|danger/i, SensorAlertSeverities.HIGH],
  [/med|warn|moder/i, SensorAlertSeverities.MEDIUM],
  [/low|info|minor|notice/i, SensorAlertSeverities.LOW],
];

const pick = <T>(words: [RegExp, T][], value: unknown): T | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  return words.find(([pattern]) => pattern.test(value))?.[1] ?? null;
};

/** Maps vendor alerts onto the vocabulary; ones whose type cannot be mapped are dropped. */
export const mapVendorAlerts = (input: unknown): TSensorAlert[] => {
  if (!Array.isArray(input)) return [];
  const alerts: TSensorAlert[] = [];
  for (const item of input.slice(0, MAX_ALERTS_PER_READING)) {
    if (!item || typeof item !== "object") continue;
    const { type, severity, message } = item as Record<string, unknown>;
    const mapped = pick(TYPE_WORDS, type);
    if (!mapped) continue;
    alerts.push({
      type: mapped,
      severity: pick(SEVERITY_WORDS, severity) ?? MEDIUM,
      message: (typeof message === "string" && message.trim() ? message.trim() : `Vendor alert: ${String(type)}`).slice(
        0,
        MAX_ALERT_MESSAGE,
      ),
    });
  }
  return alerts;
};

/** Rule alerts win over a vendor alert of the same type only when they are more severe. */
export const mergeAlerts = (ruleAlerts: TSensorAlert[], vendorAlerts: TSensorAlert[]): TSensorAlert[] => {
  const byType = new Map<string, TSensorAlert>();
  for (const alert of [...vendorAlerts, ...ruleAlerts]) {
    const current = byType.get(alert.type);
    if (!current || rank(alert.severity) > rank(current.severity)) byType.set(alert.type, alert);
  }
  return [...byType.values()].slice(0, MAX_ALERTS_PER_READING);
};

/** Battery alerts and High / Critical ones become notifications (plan 7 §7.3). */
export const isNotifiable = (alert: TSensorAlert) => alert.type === BATTERY || rank(alert.severity) >= rank(HIGH);
