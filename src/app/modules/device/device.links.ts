/*
 * HOOKS for DeviceAssignment (plan 6) and SensorData (plan 7). Neither model exists yet, so this
 * file is the only place that touches their collections (raw, like milkRecord.utils.ts):
 * empty today, and already correct once the rows appear.
 * Plan 6: replace the assignment functions with the model / service (closeActiveAssignment must
 *   become its removal workflow) and add assignment audit rows.
 * Plan 7: replace the reading functions and call recordDeviceSync() from the ingestion pipeline.
 */
import mongoose from "mongoose";
import type { ClientSession, Types } from "mongoose";
import { NotificationProducers } from "../notification/notification.producers.js";
import { BatteryTypes, ConnectionStatuses } from "./device.constants.js";
import type { RemovalReasons } from "./device.constants.js";
import { DeviceModel } from "./device.model.js";

type TId = Types.ObjectId;

//names Mongoose derives from the models "DeviceAssignment" and "SensorData"
const assignments = () => mongoose.connection.collection("deviceassignments");
const readings = () => mongoose.connection.collection("sensordatas");
const withSession = (session: ClientSession | null) => (session ? { session } : {});

export type TCurrentAssignment = { _id: TId; assignmentNo: string; deviceId: TId; animalId: TId; assignedDate: Date };

/** deviceId → open assignment. */
export const activeAssignmentsOf = async (farmId: TId, deviceIds: TId[]): Promise<Map<string, TCurrentAssignment>> => {
  if (!deviceIds.length) return new Map();
  const rows = (await assignments()
    .find({ farmId, deviceId: { $in: deviceIds }, status: "Active" })
    .project({ assignmentNo: 1, deviceId: 1, animalId: 1, assignedDate: 1 })
    .toArray()) as TCurrentAssignment[];
  return new Map(rows.map((row) => [String(row.deviceId), row]));
};

export const assignedDeviceIds = async (farmId: TId): Promise<TId[]> =>
  (await assignments().distinct("deviceId", { farmId, status: "Active" })) as TId[];

export const hasActiveAssignment = async (deviceId: TId, session: ClientSession | null): Promise<boolean> =>
  (await assignments().findOne({ deviceId, status: "Active" }, withSession(session))) !== null;

/** Any assignment (closed ones too) or reading: identity is locked and the device cannot be deleted. */
export const countDeviceHistory = async (deviceId: TId, session: ClientSession | null = null) => ({
  assignments: await assignments().countDocuments({ deviceId }, withSession(session)),
  readings: await readings().countDocuments({ deviceId }, withSession(session)),
});

/** Newest reading, without the raw vendor payload (Owner only, plan 7). */
export const latestReadingOf = (deviceId: TId) =>
  readings().findOne(
    { deviceId },
    { sort: { recordedAt: -1 }, projection: { recordedAt: 1, metrics: 1, alerts: 1, source: 1 } },
  );

/** Closes the open assignment in the caller's unit of work. Returns its undo step (standalone MongoDB). */
export const closeActiveAssignment = async (
  deviceId: TId,
  reason: (typeof RemovalReasons)[number],
  removedBy: TId,
  session: ClientSession | null,
): Promise<() => Promise<unknown>> => {
  const now = new Date();
  const row = await assignments().findOneAndUpdate(
    { deviceId, status: "Active" },
    { $set: { status: "Removed", removedDate: now, removalReason: reason, removedBy, updatedAt: now } },
    { ...withSession(session), returnDocument: "before" },
  );
  return async () => {
    if (!row) return;
    const { removedDate = null, removalReason = null, removedBy: previous = null, updatedAt = now } = row;
    await assignments().updateOne(
      { _id: row._id },
      { $set: { status: "Active", removedDate, removalReason, removedBy: previous, updatedAt } },
    );
  };
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
