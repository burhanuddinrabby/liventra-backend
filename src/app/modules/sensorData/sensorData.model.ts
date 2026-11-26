import { model, Schema } from "mongoose";
import {
  MAX_ALERT_MESSAGE,
  METRIC_KEYS,
  SENSOR_METRICS,
  SensorAlertSeverities,
  SensorAlertTypes,
  SensorSources,
} from "./sensorData.constants.js";
import type { TSensorAlert, TSensorData, TSensorMetrics } from "./sensorData.interface.js";

//no defaults: a metric that was not measured stays absent
const metricsSchema = new Schema<TSensorMetrics>(
  Object.fromEntries(
    METRIC_KEYS.map((key) => {
      const { min, max } = SENSOR_METRICS[key];
      return [key, { type: Number, min, ...(max === null ? {} : { max }), immutable: true }];
    }),
  ),
  { _id: false, strict: "throw" },
);

const alertSchema = new Schema<TSensorAlert>(
  {
    type: { type: String, enum: Object.values(SensorAlertTypes), required: true },
    severity: { type: String, enum: Object.values(SensorAlertSeverities), required: true },
    message: { type: String, required: true, maxlength: MAX_ALERT_MESSAGE },
  },
  { _id: false },
);

/**
 * A normal collection, not a time-series one: time-series collections cannot hold the unique
 * {deviceId, recordedAt} index, which is the only duplicate guard (there is no event id).
 */
const sensorDataSchema = new Schema<TSensorData>(
  {
    farmId: { type: Schema.Types.ObjectId, ref: "Farm", required: true, immutable: true },
    deviceId: { type: Schema.Types.ObjectId, ref: "Device", required: true, immutable: true },
    assignmentId: { type: Schema.Types.ObjectId, ref: "DeviceAssignment", required: true, immutable: true },
    animalId: { type: Schema.Types.ObjectId, ref: "Animal", required: true, immutable: true },
    recordedAt: { type: Date, required: true, immutable: true },
    metrics: { type: metricsSchema, required: true, immutable: true },
    alerts: { type: [alertSchema], default: [], immutable: true },
    rawPayload: { type: Schema.Types.Mixed, default: undefined, immutable: true },
    source: { type: String, enum: Object.values(SensorSources), required: true, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

sensorDataSchema.index({ farmId: 1, recordedAt: -1 });
sensorDataSchema.index({ animalId: 1, recordedAt: -1 });
sensorDataSchema.index({ assignmentId: 1, recordedAt: -1 });
//a second message for the same moment is a duplicate
sensorDataSchema.index({ deviceId: 1, recordedAt: 1 }, { unique: true, name: "one_reading_per_device_and_moment" });
//alerts list and dashboard: only readings that carry an alert
sensorDataSchema.index(
  { farmId: 1, recordedAt: -1, "alerts.type": 1 },
  { partialFilterExpression: { "alerts.type": { $exists: true } }, name: "alerts_by_farm" },
);

export const SensorDataModel = model<TSensorData>("SensorData", sensorDataSchema);

export const SENSOR_INDEX_HINTS = {
  farm: { farmId: 1, recordedAt: -1 },
  animal: { animalId: 1, recordedAt: -1 },
  assignment: { assignmentId: 1, recordedAt: -1 },
  device: "one_reading_per_device_and_moment",
  alerts: "alerts_by_farm",
} as const;
