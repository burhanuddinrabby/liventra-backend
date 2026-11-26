import z from "zod";
import {
  BatteryTypes,
  CommunicationProtocols,
  ConnectionStatuses,
  DeviceHealthStatuses,
  DeviceTypes,
  MAX_FIRMWARE,
  MAX_NAME,
  MAX_NOTES,
  MAX_REASON,
  MAX_SERIAL,
  RemovalReasons,
} from "./device.constants.js";

// validateRequest discards the parsed result: these schemas reject bad bodies early and the
// service parses every field again. Bodies are strict, so server-managed fields are refused.

const text = (max: number) => z.string().trim().min(1).max(max);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}/, { message: "Use YYYY-MM-DD" });

const details = {
  communicationProtocol: z.enum(CommunicationProtocols).nullish(),
  firmwareVersion: z.string().trim().max(MAX_FIRMWARE).nullish(),
  installationDate: day.nullish(),
  purchaseDate: day.nullish(),
  warrantyExpiry: day.nullish(),
  batteryLevel: z.number().min(0).max(100).nullish(),
  notes: z.string().trim().max(MAX_NOTES).nullish(),
};

const identity = {
  company: text(MAX_NAME),
  model: text(MAX_NAME),
  serialNumber: text(MAX_SERIAL),
  deviceType: z.enum(DeviceTypes),
  batteryType: z.enum(BatteryTypes),
};

const reason = z.string().trim().min(3, { message: "A reason of at least 3 characters is required" }).max(MAX_REASON);

const createValidation = z.object({ body: z.object({ ...identity, ...details }).strict() });

//null clears an optional field
const updateValidation = z.object({ body: z.object({ ...identity, ...details }).partial().strict() });

const statusValidation = z.object({
  body: z
    .object({
      //Online is set by a sync only
      connectionStatus: z
        .enum([ConnectionStatuses.MAINTENANCE, ConnectionStatuses.DISCONNECTED, ConnectionStatuses.OFFLINE])
        .optional(),
      healthStatus: z.enum(DeviceHealthStatuses).optional(),
      reason,
    })
    .strict(),
});

const deactivateValidation = z.object({
  body: z.object({ reason, removalReason: z.enum(RemovalReasons).optional() }).strict(),
});

export const deviceValidations = { createValidation, updateValidation, statusValidation, deactivateValidation };
