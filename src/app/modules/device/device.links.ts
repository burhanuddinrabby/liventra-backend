/*
 * Links between a device and the records that point at it.
 * - Assignments (plan 6): read through DeviceAssignmentModel. Closing one is the assignment
 *   module's removal workflow (`closeDeviceAssignment` in deviceAssignment.utils.ts).
 * - Readings (plan 7): read through SensorDataModel. recordDeviceSync() is called by the
 *   ingestion pipeline (sensorData.pipeline.ts) after readings are stored.
 */
import type { ClientSession, Types } from "mongoose";
import { NotificationProducers } from "../notification/notification.producers.js";
import { AssignmentStatuses } from "../deviceAssignment/deviceAssignment.constants.js";
import { DeviceAssignmentModel } from "../deviceAssignment/deviceAssignment.model.js";
import { BatteryTypes, ConnectionStatuses } from "./device.constants.js";
import { MACHINE_SOURCES } from "../sensorData/sensorData.constants.js";
import { SensorDataModel } from "../sensorData/sensorData.model.js";
import { DeviceModel } from "./device.model.js";

type TId = Types.ObjectId;

const ANIMAL_FIELDS = "animalCode name tagNumber lifeStatus";

export type TCurrentAssignment = {
  _id: TId;
  assignmentNo: string;
  deviceId: TId;
  animalId: TId;
  assignedDate: Date;
  assignmentReason: string;
  animal: { _id: TId; animalCode: string; name?: string | null; tagNumber?: string | null; lifeStatus: string } | null;
};

/** deviceId → open assignment, with the animal it is on. */
export const activeAssignmentsOf = async (farmId: TId, deviceIds: TId[]): Promise<Map<string, TCurrentAssignment>> => {
  if (!deviceIds.length) return new Map();
  const rows = await DeviceAssignmentModel.find({ farmId, deviceId: { $in: deviceIds }, status: AssignmentStatuses.ACTIVE })
    .select("assignmentNo deviceId animalId assignedDate assignmentReason")
    .populate<{ animalId: TCurrentAssignment["animal"] }>("animalId", ANIMAL_FIELDS)
    .lean();
  return new Map(
    rows.map((row) => {
      const animal = row.animalId;
      return [
        String(row.deviceId),
        {
          _id: row._id,
          assignmentNo: row.assignmentNo,
          deviceId: row.deviceId,
          animalId: animal?._id as TId,
          assignedDate: row.assignedDate,
          assignmentReason: row.assignmentReason,
          animal,
        },
      ];
    }),
  );
};

export const assignedDeviceIds = async (farmId: TId): Promise<TId[]> =>
  DeviceAssignmentModel.distinct("deviceId", { farmId, status: AssignmentStatuses.ACTIVE });

export const hasActiveAssignment = async (deviceId: TId, session: ClientSession | null): Promise<boolean> =>
  (await DeviceAssignmentModel.exists({ deviceId, status: AssignmentStatuses.ACTIVE }).session(session)) !== null;

/** Any assignment (closed and cancelled ones too) or reading: identity is locked and the device cannot be deleted. */
export const countDeviceHistory = async (deviceId: TId, session: ClientSession | null = null) => ({
  assignments: await DeviceAssignmentModel.countDocuments({ deviceId }).session(session),
  readings: await countReadingsOfDevice(deviceId, session),
});

/* ---------- readings (SensorData, plan 7) ---------- */

/** Readings sent by one device. */
export const countReadingsOfDevice = (deviceId: TId, session: ClientSession | null = null) =>
  SensorDataModel.countDocuments({ deviceId }).session(session);

/** Newest reading, without the raw vendor payload (Owner only, on the reading page). */
export const latestReadingOf = (deviceId: TId) =>
  SensorDataModel.findOne({ deviceId })
    .sort({ recordedAt: -1 })
    .select("recordedAt metrics alerts source animalId assignmentId")
    .lean();

/**
 * Readings stored under one assignment. Decides two plan 6 rules:
 * an assignment with a reading cannot be cancelled, and it cannot be removed before `lastRecordedAt`.
 */
export const readingsOfAssignment = async (
  assignmentId: TId,
  session: ClientSession | null = null,
): Promise<{ count: number; lastRecordedAt: Date | null }> => {
  const [count, last] = await Promise.all([
    SensorDataModel.countDocuments({ assignmentId }).session(session),
    SensorDataModel.findOne({ assignmentId }).sort({ recordedAt: -1 }).select("recordedAt").session(session).lean(),
  ]);
  return { count, lastRecordedAt: last?.recordedAt ?? null };
};

/**
 * Device state after stored readings (plan 7 §7.2). Only a machine source (API / MQTT /
 * Bluetooth) sets `lastSyncAt` = server time and Online; manual entry and import never do.
 * Maintenance is kept. `batteryLevel` is passed only when it comes from the device's newest
 * reading. False = unknown or deactivated device, or nothing to change.
 */
export const recordDeviceSync = async (
  deviceId: TId,
  values: { source: string; batteryLevel?: number; firmwareVersion?: string },
): Promise<boolean> => {
  const { ONLINE, MAINTENANCE } = ConnectionStatuses;
  const machine = MACHINE_SOURCES.includes(values.source);
  if (!machine && values.batteryLevel === undefined) return false;
  const device = await DeviceModel.findOneAndUpdate(
    { _id: deviceId, isActive: true },
    [
      {
        $set: {
          ...(machine
            ? {
                lastSyncAt: "$$NOW",
                connectionStatus: { $cond: [{ $eq: ["$connectionStatus", MAINTENANCE] }, MAINTENANCE, ONLINE] },
              }
            : {}),
          ...(values.batteryLevel === undefined
            ? {}
            : {
                batteryLevel: {
                  $cond: [{ $eq: ["$batteryType", BatteryTypes.NOT_APPLICABLE] }, null, values.batteryLevel],
                },
              }),
          ...(machine && values.firmwareVersion ? { firmwareVersion: { $literal: values.firmwareVersion } } : {}),
        },
      },
    ],
    { returnDocument: "after", updatePipeline: true },
  ).lean();
  if (!device) return false;
  await NotificationProducers.deviceChanged(device.farmId, device.deviceCode);
  return true;
};
