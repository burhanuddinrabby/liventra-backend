import type { Types } from "mongoose";
import type {
  BatteryTypes,
  CommunicationProtocols,
  ConnectionStatuses,
  DeviceHealthStatuses,
  DeviceTypes,
} from "./device.constants.js";

type TValue<T> = T[keyof T];

//current state of one physical device: no animalId and no readings
export type TDevice = {
  deviceCode: string;
  farmId: Types.ObjectId;
  company: string;
  model: string;
  serialNumber: string;
  deviceType: TValue<typeof DeviceTypes>;
  communicationProtocol?: TValue<typeof CommunicationProtocols> | null;
  firmwareVersion?: string | null;
  installationDate?: Date | null;
  purchaseDate?: Date | null;
  warrantyExpiry?: Date | null;
  batteryType: TValue<typeof BatteryTypes>;
  //null = not applicable or not reported; 0 = empty
  batteryLevel?: number | null;
  lastSyncAt?: Date | null;
  connectionStatus: TValue<typeof ConnectionStatuses>;
  healthStatus: TValue<typeof DeviceHealthStatuses>;
  notes?: string | null;
  isActive: boolean;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
};

export type TDeviceDoc = TDevice & { _id: Types.ObjectId };
