import { model, Schema } from "mongoose";
import {
  BatteryTypes,
  CommunicationProtocols,
  ConnectionStatuses,
  DEVICE_CODE_PREFIX,
  DeviceHealthStatuses,
  DeviceTypes,
  MAX_FIRMWARE,
  MAX_NAME,
  MAX_NOTES,
  MAX_SERIAL,
} from "./device.constants.js";
import type { TDevice } from "./device.interface.js";

const deviceSchema = new Schema<TDevice>(
  {
    deviceCode: { type: String, required: true, unique: true, immutable: true },
    farmId: { type: Schema.Types.ObjectId, ref: "Farm", required: true, immutable: true },
    company: { type: String, required: true, trim: true, maxlength: MAX_NAME },
    model: { type: String, required: true, trim: true, maxlength: MAX_NAME },
    serialNumber: { type: String, required: true, trim: true, uppercase: true, maxlength: MAX_SERIAL },
    deviceType: { type: String, enum: Object.values(DeviceTypes), required: true },
    communicationProtocol: { type: String, enum: [...Object.values(CommunicationProtocols), null], default: null },
    firmwareVersion: { type: String, trim: true, maxlength: MAX_FIRMWARE, default: null },
    installationDate: { type: Date, default: null },
    purchaseDate: { type: Date, default: null },
    warrantyExpiry: { type: Date, default: null },
    batteryType: { type: String, enum: Object.values(BatteryTypes), required: true },
    batteryLevel: { type: Number, min: 0, max: 100, default: null },
    lastSyncAt: { type: Date, default: null },
    connectionStatus: {
      type: String,
      enum: Object.values(ConnectionStatuses),
      required: true,
      default: ConnectionStatuses.OFFLINE,
    },
    healthStatus: {
      type: String,
      enum: Object.values(DeviceHealthStatuses),
      required: true,
      default: DeviceHealthStatuses.HEALTHY,
    },
    notes: { type: String, trim: true, maxlength: MAX_NOTES, default: null },
    isActive: { type: Boolean, required: true, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

//vendors can share numbers, so a serial is unique together with its company (any letter case, all farms)
deviceSchema.index({ company: 1, serialNumber: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });
deviceSchema.index({ farmId: 1, isActive: 1 });
deviceSchema.index({ farmId: 1, connectionStatus: 1 });
deviceSchema.index({ farmId: 1, healthStatus: 1 });
deviceSchema.index({ farmId: 1, deviceType: 1 });

export const DeviceModel = model<TDevice>("Device", deviceSchema);

type TDeviceCounter = { _id: string; seq: number };

const deviceCounterSchema = new Schema<TDeviceCounter>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);

export const DeviceCounterModel = model<TDeviceCounter>("DeviceCounter", deviceCounterSchema);

/** DEV-000001 (atomic, never inside a transaction; gaps are harmless). */
export const generateDeviceCode = async (): Promise<string> => {
  const counter = await DeviceCounterModel.findOneAndUpdate(
    { _id: "device" },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  return `${DEVICE_CODE_PREFIX}-${String(counter?.seq ?? 1).padStart(6, "0")}`;
};
