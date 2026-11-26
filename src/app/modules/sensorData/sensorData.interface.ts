import type { Types } from "mongoose";
import type { SensorAlertSeverities, SensorAlertTypes, SensorSources, TMetricKey } from "./sensorData.constants.js";

export type TSensorSource = (typeof SensorSources)[keyof typeof SensorSources];
export type TSensorAlertType = (typeof SensorAlertTypes)[keyof typeof SensorAlertTypes];
export type TSensorAlertSeverity = (typeof SensorAlertSeverities)[keyof typeof SensorAlertSeverities];

/** A missing metric stays absent, never 0. */
export type TSensorMetrics = Partial<Record<TMetricKey, number>>;

export type TSensorAlert = { type: TSensorAlertType; severity: TSensorAlertSeverity; message: string };

/** Readings are evidence: no updatedAt, status, isActive or user id, and every field is immutable. */
export type TSensorData = {
  farmId: Types.ObjectId;
  deviceId: Types.ObjectId;
  assignmentId: Types.ObjectId;
  animalId: Types.ObjectId;
  recordedAt: Date;
  metrics: TSensorMetrics;
  alerts: TSensorAlert[];
  rawPayload?: Record<string, unknown> | null;
  source: TSensorSource;
  createdAt?: Date;
};

export type TSensorDataDoc = TSensorData & { _id: Types.ObjectId };
