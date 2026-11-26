/*
 * Links between a device and the records that point at it.
 * - Assignments (plan 6): read through DeviceAssignmentModel. Closing one is the assignment
 *   module's removal workflow (`closeDeviceAssignment` in deviceAssignment.utils.ts).
 * - Readings (plan 7): SensorData does not exist yet. The functions marked "PLAN 7 HOOK" are the
 *   only code that touches its collection (raw, like milkRecord.utils.ts): empty today, already
 *   correct once rows appear. Plan 7 replaces them with the model and calls recordDeviceSync()
 *   from the ingestion pipeline.
 */
import mongoose from "mongoose";
import type { ClientSession, Types } from "mongoose";
import { NotificationProducers } from "../notification/notification.producers.js";
import { AssignmentStatuses } from "../deviceAssignment/deviceAssignment.constants.js";
import { DeviceAssignmentModel } from "../deviceAssignment/deviceAssignment.model.js";
import { BatteryTypes, ConnectionStatuses } from "./device.constants.js";
import { DeviceModel } from "./device.model.js";

type TId = Types.ObjectId;

//name Mongoose will derive from the model "SensorData" (plan 7)
const readings = () => mongoose.connection.collection("sensordatas");
const withSession = (session: ClientSession | null) => (session ? { session } : {});

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

/* ---------- PLAN 7 HOOKS (SensorData) ---------- */

/** PLAN 7 HOOK: readings sent by one device. */
export const countReadingsOfDevice = (deviceId: TId, session: ClientSession | null = null) =>
  readings().countDocuments({ deviceId }, withSession(session));

/** PLAN 7 HOOK: newest reading, without the raw vendor payload (Owner only). */
export const latestReadingOf = (deviceId: TId) =>
  readings().findOne(
    { deviceId },
    { sort: { recordedAt: -1 }, projection: { recordedAt: 1, metrics: 1, alerts: 1, source: 1 } },
  );

/**
 * PLAN 7 HOOK: readings stored under one assignment. Decides two plan 6 rules:
 * an assignment with a reading cannot be cancelled, and it cannot be removed before `lastRecordedAt`.
 */
export const readingsOfAssignment = async (
  assignmentId: TId,
  session: ClientSession | null = null,
): Promise<{ count: number; lastRecordedAt: Date | null }> => {
  const [count, last] = await Promise.all([
    readings().countDocuments({ assignmentId }, withSession(session)),
    readings().findOne({ assignmentId }, { ...withSession(session), sort: { recordedAt: -1 }, projection: { recordedAt: 1 } }),
  ]);
  return { count, lastRecordedAt: (last?.recordedAt as Date | undefined) ?? null };
};

/**
 * A successful machine sync: the only way to become Online. Maintenance is kept.
 * `batteryLevel` only when this reading is the newest one. False = unknown or deactivated device.
 */
export const recordDeviceSync = async (
  deviceId: TId,
  values: { batteryLevel?: number; firmwareVersion?: string } = {},
): Promise<boolean> => {
  const { ONLINE, MAINTENANCE } = ConnectionStatuses;
  const device = await DeviceModel.findOneAndUpdate(
    { _id: deviceId, isActive: true },
    [
      {
        $set: {
          lastSyncAt: "$$NOW",
          connectionStatus: { $cond: [{ $eq: ["$connectionStatus", MAINTENANCE] }, MAINTENANCE, ONLINE] },
          ...(values.batteryLevel === undefined
            ? {}
            : {
                batteryLevel: {
                  $cond: [{ $eq: ["$batteryType", BatteryTypes.NOT_APPLICABLE] }, null, values.batteryLevel],
                },
              }),
          ...(values.firmwareVersion ? { firmwareVersion: { $literal: values.firmwareVersion } } : {}),
        },
      },
    ],
    { returnDocument: "after", updatePipeline: true },
  ).lean();
  if (!device) return false;
  await NotificationProducers.deviceChanged(device.farmId, device.deviceCode);
  return true;
};
