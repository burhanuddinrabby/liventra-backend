import status from "http-status";
import type { ClientSession, Types } from "mongoose";
import AppError from "../../errors/AppError.js";
import { AuditActions, AuditEntityTypes, AuditModules } from "../auditLog/auditLog.constants.js";
import type { TAuditAction } from "../auditLog/auditLog.interface.js";
import type { TAuditContext, TRecordAuditInput } from "../auditLog/auditLog.utils.js";
import { AnimalLifeStatuses } from "../animal/animal.constants.js";
import { readingsOfAssignment } from "../device/device.links.js";
import { DeviceModel } from "../device/device.model.js";
import type { TUndo } from "../feedRecord/feedRecord.utils.js";
import {
  AssignmentStatuses,
  CANCEL_WINDOW_HOURS,
  MAX_REMARKS,
  RemovalReasonValues,
} from "./deviceAssignment.constants.js";
import type { TDeviceAssignmentDoc, TRemovalReason } from "./deviceAssignment.interface.js";
import { DeviceAssignmentModel } from "./deviceAssignment.model.js";

type TId = Types.ObjectId;

export const sessionOpts = (session: ClientSession | null) => (session ? { session } : {});

export const ALREADY_CLOSED = "This assignment was closed by someone else. Reload and try again!";

/** Remarks are a trail: a removal or cancel note is added on a new line, never replacing the old text. */
export const appendRemark = (existing: string | null | undefined, line: string | null | undefined): string | null => {
  if (!line) return existing ?? null;
  const text = existing ? `${existing}\n${line}` : line;
  if (text.length > MAX_REMARKS) {
    throw new AppError(status.BAD_REQUEST, `remarks cannot exceed ${MAX_REMARKS} characters in total!`);
  }
  return text;
};

export const cancelDeadline = (row: Pick<TDeviceAssignmentDoc, "createdAt">): Date | null =>
  row.createdAt ? new Date(row.createdAt.getTime() + CANCEL_WINDOW_HOURS * 60 * 60 * 1000) : null;

export const assignmentAudit = (
  farmId: TId,
  context: TAuditContext | undefined,
  entityId: TId,
  action: TAuditAction,
  event: string,
  data: Pick<TRecordAuditInput, "oldData" | "newData" | "changedFields">,
): TRecordAuditInput => ({
  ...(context ? { context } : {}),
  farmId,
  entityType: AuditEntityTypes.DEVICE_ASSIGNMENT,
  entityId,
  action,
  module: AuditModules.FARM,
  event,
  ...data,
});

export type TCloseInput = {
  removalReason: TRemovalReason;
  removedBy: TId;
  /** default: now */
  removedDate?: Date;
  /** added to the remarks trail */
  remarks?: string | null;
  context?: TAuditContext | undefined;
  event: string;
};

/**
 * The removal workflow: closes one Active row inside the caller's unit of work and returns its
 * audit row (write it in the same unit's audit step). Old rows are closed, never rewritten.
 */
export const closeAssignmentRow = async (
  row: TDeviceAssignmentDoc,
  input: TCloseInput,
  session: ClientSession | null,
  undo: TUndo,
): Promise<TRecordAuditInput> => {
  const removedDate = input.removedDate ?? new Date();
  if (removedDate < row.assignedDate) {
    throw new AppError(status.BAD_REQUEST, `${row.assignmentNo}: the removal date cannot be before the assignment started!`);
  }
  const { lastRecordedAt } = await readingsOfAssignment(row._id, session);
  if (lastRecordedAt && removedDate < lastRecordedAt) {
    throw new AppError(
      status.BAD_REQUEST,
      `${row.assignmentNo}: the removal date cannot be before its last reading (${lastRecordedAt.toISOString()})!`,
    );
  }
  const remarks = appendRemark(row.remarks, input.remarks);
  const result = await DeviceAssignmentModel.updateOne(
    { _id: row._id, status: AssignmentStatuses.ACTIVE },
    {
      $set: {
        status: AssignmentStatuses.REMOVED,
        removedDate,
        removalReason: input.removalReason,
        removedBy: input.removedBy,
        remarks,
      },
    },
    sessionOpts(session),
  );
  if (!result.matchedCount) throw new AppError(status.CONFLICT, ALREADY_CLOSED);
  undo.push(() =>
    DeviceAssignmentModel.updateOne(
      { _id: row._id },
      { $set: { status: AssignmentStatuses.ACTIVE, removedDate: null, removalReason: null, removedBy: null, remarks: row.remarks ?? null } },
    ),
  );
  return assignmentAudit(row.farmId, input.context, row._id, AuditActions.UPDATE, input.event, {
    oldData: { status: AssignmentStatuses.ACTIVE, removedDate: null, removalReason: null, remarks: row.remarks ?? null },
    newData: { status: AssignmentStatuses.REMOVED, removedDate, removalReason: input.removalReason, remarks },
    changedFields: ["status", "removedDate", "removalReason", "removedBy", ...(remarks !== (row.remarks ?? null) ? ["remarks"] : [])],
  });
};

/** Closes the device's open assignment (device deactivation). Null when it has none. */
export const closeDeviceAssignment = async (
  deviceId: TId,
  input: TCloseInput,
  session: ClientSession | null,
  undo: TUndo,
): Promise<TRecordAuditInput | null> => {
  const row = await DeviceAssignmentModel.findOne({ deviceId, status: AssignmentStatuses.ACTIVE }).session(session).lean();
  return row ? closeAssignmentRow(row, input, session, undo) : null;
};

//plan 6 §6.3 + plan 1 §5 #6: a transferred animal's device is removed with Manual Removal
const LIFE_CYCLE_REMOVAL: Record<string, { reason: TRemovalReason; remark: string | null }> = {
  [AnimalLifeStatuses.SOLD]: { reason: RemovalReasonValues.ANIMAL_SOLD, remark: null },
  [AnimalLifeStatuses.DEAD]: { reason: RemovalReasonValues.ANIMAL_DEAD, remark: null },
  [AnimalLifeStatuses.TRANSFERRED]: { reason: RemovalReasonValues.MANUAL_REMOVAL, remark: "Released: the animal was transferred." },
  [AnimalLifeStatuses.ARCHIVED]: { reason: RemovalReasonValues.MANUAL_REMOVAL, remark: "Released: the animal was archived." },
};

export type TReleasedDevice = { assignmentNo: string; deviceId: TId; deviceCode: string | null; deviceType: string | null; removalReason: string };

/**
 * Every place that moves an animal out of Active calls this inside its own unit of work
 * (animal lifecycle and archive in animal.services.ts, the sale in income.services.ts).
 * Reactivating an animal restores nothing.
 */
export const closeAssignmentsForAnimal = async (
  input: { animalId: TId; lifeStatus: string; removedBy: TId; context?: TAuditContext | undefined },
  session: ClientSession | null,
  undo: TUndo,
): Promise<{ released: TReleasedDevice[]; audits: TRecordAuditInput[] }> => {
  const rule = LIFE_CYCLE_REMOVAL[input.lifeStatus];
  if (!rule) return { released: [], audits: [] };
  const rows = await DeviceAssignmentModel.find({ animalId: input.animalId, status: AssignmentStatuses.ACTIVE })
    .session(session)
    .lean();
  if (!rows.length) return { released: [], audits: [] };
  const devices = await DeviceModel.find({ _id: { $in: rows.map((row) => row.deviceId) } })
    .select("deviceCode deviceType")
    .session(session)
    .lean();
  const byId = new Map(devices.map((device) => [String(device._id), device]));

  const released: TReleasedDevice[] = [];
  const audits: TRecordAuditInput[] = [];
  for (const row of rows) {
    audits.push(
      await closeAssignmentRow(
        row,
        {
          removalReason: rule.reason,
          removedBy: input.removedBy,
          remarks: rule.remark,
          context: input.context,
          event: `Device Released (Animal ${input.lifeStatus})`,
        },
        session,
        undo,
      ),
    );
    const device = byId.get(String(row.deviceId));
    released.push({
      assignmentNo: row.assignmentNo,
      deviceId: row.deviceId,
      deviceCode: device?.deviceCode ?? null,
      deviceType: device?.deviceType ?? null,
      removalReason: rule.reason,
    });
  }
  return { released, audits };
};
