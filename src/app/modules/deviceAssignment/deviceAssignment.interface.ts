import type { Types } from "mongoose";
import type { AssignmentReasons, AssignmentStatuses, RemovalReasonValues } from "./deviceAssignment.constants.js";

type TValue<T> = T[keyof T];

export type TAssignmentReason = TValue<typeof AssignmentReasons>;
export type TRemovalReason = TValue<typeof RemovalReasonValues>;
export type TAssignmentStatus = TValue<typeof AssignmentStatuses>;

//one device on one animal for one period; closed rows are never rewritten
export type TDeviceAssignment = {
  assignmentNo: string;
  farmId: Types.ObjectId;
  deviceId: Types.ObjectId;
  animalId: Types.ObjectId;
  assignedDate: Date;
  removedDate?: Date | null;
  assignmentReason: TAssignmentReason;
  removalReason?: TRemovalReason | null;
  assignedBy: Types.ObjectId;
  removedBy?: Types.ObjectId | null;
  status: TAssignmentStatus;
  remarks?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

export type TDeviceAssignmentDoc = TDeviceAssignment & { _id: Types.ObjectId };
