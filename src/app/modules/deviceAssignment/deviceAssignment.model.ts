import { model, Schema } from "mongoose";
import { DeviceCounterModel } from "../device/device.model.js";
import {
  ASSIGNMENT_NO_PREFIX,
  AssignmentReasons,
  AssignmentStatuses,
  MAX_REMARKS,
  RemovalReasons,
} from "./deviceAssignment.constants.js";
import type { TDeviceAssignment } from "./deviceAssignment.interface.js";

const deviceAssignmentSchema = new Schema<TDeviceAssignment>(
  {
    assignmentNo: { type: String, required: true, unique: true, immutable: true },
    farmId: { type: Schema.Types.ObjectId, ref: "Farm", required: true, immutable: true },
    //who, what and since when never change: a correction is a new row
    deviceId: { type: Schema.Types.ObjectId, ref: "Device", required: true, immutable: true },
    animalId: { type: Schema.Types.ObjectId, ref: "Animal", required: true, immutable: true },
    assignedDate: { type: Date, required: true, immutable: true },
    removedDate: { type: Date, default: null },
    assignmentReason: { type: String, enum: Object.values(AssignmentReasons), required: true, immutable: true },
    removalReason: { type: String, enum: [...RemovalReasons, null], default: null },
    assignedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    removedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    status: {
      type: String,
      enum: Object.values(AssignmentStatuses),
      required: true,
      default: AssignmentStatuses.ACTIVE,
    },
    remarks: { type: String, trim: true, maxlength: MAX_REMARKS, default: null },
  },
  { timestamps: true },
);

deviceAssignmentSchema.index({ farmId: 1, status: 1 });
deviceAssignmentSchema.index({ animalId: 1, status: 1 });
deviceAssignmentSchema.index({ deviceId: 1, assignedDate: -1 });
//the real guard against double assignment (a pre-check can race): one Active row per device
deviceAssignmentSchema.index(
  { deviceId: 1 },
  { unique: true, partialFilterExpression: { status: AssignmentStatuses.ACTIVE }, name: "one_active_assignment_per_device" },
);

export const DeviceAssignmentModel = model<TDeviceAssignment>("DeviceAssignment", deviceAssignmentSchema);

/** ASN-000001 (atomic, never inside a transaction; gaps are harmless). */
export const generateAssignmentNo = async (): Promise<string> => {
  const counter = await DeviceCounterModel.findOneAndUpdate(
    { _id: "deviceAssignment" },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  return `${ASSIGNMENT_NO_PREFIX}-${String(counter?.seq ?? 1).padStart(6, "0")}`;
};
