// DeviceAssignment (Model 26) enums follow the final DB schema and are stored as-is.
// The schema writes the closed status as "Remove"; the spec and plan 1 §4 use "Removed".
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";
import type { TFarmMemberRole } from "../farmMember/farmMember.interface.js";
import { DeviceTypes, RemovalReasons } from "../device/device.constants.js";

export { RemovalReasons };

export const AssignmentReasons = {
  NEW_INSTALLATION: "New Installation",
  REPLACEMENT: "Replacement",
  DEVICE_UPGRADE: "Device Upgrade",
  REASSIGNMENT: "Reassignment",
  TESTING: "Testing",
} as const;

export const AssignmentStatuses = {
  ACTIVE: "Active",
  REMOVED: "Removed",
  CANCELLED: "Cancelled",
} as const;

export const RemovalReasonValues = {
  MAINTENANCE: "Maintenance",
  BATTERY_FAILURE: "Battery Failure",
  DEVICE_FAULT: "Device Fault",
  ANIMAL_SOLD: "Animal Sold",
  ANIMAL_DEAD: "Animal Dead",
  REPLACEMENT: "Replacement",
  LOST: "Lost",
  MANUAL_REMOVAL: "Manual Removal",
} as const;

//POST / starts an assignment with one of these; Replacement / Device Upgrade come from POST /:id/replace
export const DIRECT_ASSIGNMENT_REASONS: readonly string[] = [
  AssignmentReasons.NEW_INSTALLATION,
  AssignmentReasons.REASSIGNMENT,
  AssignmentReasons.TESTING,
];

//Animal Sold / Animal Dead are written by the animal life cycle only
export const MANUAL_REMOVAL_REASONS: readonly string[] = [
  RemovalReasonValues.MAINTENANCE,
  RemovalReasonValues.BATTERY_FAILURE,
  RemovalReasonValues.DEVICE_FAULT,
  RemovalReasonValues.REPLACEMENT,
  RemovalReasonValues.LOST,
  RemovalReasonValues.MANUAL_REMOVAL,
];

//POST /:id/replace with mode "replacement": why the old device came off
export const REPLACEMENT_REMOVAL_REASONS: readonly string[] = [
  RemovalReasonValues.DEVICE_FAULT,
  RemovalReasonValues.BATTERY_FAILURE,
  RemovalReasonValues.LOST,
];

export const ReplaceModes = { REPLACEMENT: "replacement", UPGRADE: "upgrade" } as const;

//what happens to the old device of a replace / upgrade
export const OldDeviceActions = { NONE: "none", FAULTY: "faulty", DEACTIVATE: "deactivate" } as const;

//farm-level hardware: the schema needs an animal, so in this version they are assigned per animal (plan 1 §4 #9)
export const PER_ANIMAL_NOTE_TYPES: readonly string[] = [
  DeviceTypes.ENVIRONMENT_SENSOR,
  DeviceTypes.WATER_METER,
  DeviceTypes.MILK_METER,
];

export const CANCEL_WINDOW_HOURS = 24;
export const ASSIGNMENT_NO_PREFIX = "ASN";
export const ASSIGNMENT_NO_PATTERN = /^ASN-\d{6,}$/i;
export const MAX_REMARKS = 1000;
export const ASSIGNMENT_MAX_LIMIT = 100;
export const PICKER_LIMIT = 50;

export const ASSIGNMENT_SORT_FIELDS = ["assignedDate", "removedDate", "assignmentNo", "createdAt"] as const;

const { OWNER, MANAGER, VETERINARIAN, WORKER } = FarmMemberRoles;
export const AssignmentPermissions: Record<"READ" | "WRITE" | "OWNER", readonly TFarmMemberRole[]> = {
  READ: [OWNER, MANAGER, VETERINARIAN, WORKER],
  WRITE: [OWNER, MANAGER],
  //deactivating the old device during a replacement is a device-owner action (plan 5)
  OWNER: [OWNER],
};
