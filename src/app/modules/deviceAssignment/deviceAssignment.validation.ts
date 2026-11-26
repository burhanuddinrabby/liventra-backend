import z from "zod";
import {
  DIRECT_ASSIGNMENT_REASONS,
  MANUAL_REMOVAL_REASONS,
  MAX_REMARKS,
  OldDeviceActions,
  REPLACEMENT_REMOVAL_REASONS,
  ReplaceModes,
} from "./deviceAssignment.constants.js";

// validateRequest discards the parsed result: these schemas reject bad bodies early and the
// service parses every field again. Bodies are strict: assignedBy, removedBy, status, farmId
// and assignmentNo always come from the server.

const ref = z.string().trim().min(1);
const moment = z.string().trim().min(1).nullish();
const remarks = z.string().trim().max(MAX_REMARKS).nullish();
const note = z.string().trim().min(3, { message: "At least 3 characters are required" }).max(MAX_REMARKS);

const assignValidation = z.object({
  body: z
    .object({
      deviceId: ref,
      animalId: ref,
      assignedDate: moment,
      assignmentReason: z.enum(DIRECT_ASSIGNMENT_REASONS as [string, ...string[]]).optional(),
      remarks,
      confirmSameType: z.boolean().optional(),
    })
    .strict(),
});

const reassignValidation = z.object({
  body: z.object({ animalId: ref, date: moment, remarks, confirmSameType: z.boolean().optional() }).strict(),
});

const replaceValidation = z.object({
  body: z
    .object({
      mode: z.enum(ReplaceModes),
      deviceId: ref,
      removalReason: z.enum(REPLACEMENT_REMOVAL_REASONS as [string, ...string[]]).optional(),
      oldDeviceAction: z.enum(OldDeviceActions).optional(),
      date: moment,
      remarks,
      confirmSameType: z.boolean().optional(),
    })
    .strict(),
});

const removeValidation = z.object({
  body: z
    .object({
      removalReason: z.enum(MANUAL_REMOVAL_REASONS as [string, ...string[]]),
      removedDate: moment,
      remarks,
      deviceToMaintenance: z.boolean().optional(),
    })
    .strict(),
});

const cancelValidation = z.object({ body: z.object({ remarks: note }).strict() });

const remarksValidation = z.object({ body: z.object({ remarks: z.string().trim().max(MAX_REMARKS).nullable() }).strict() });

export const deviceAssignmentValidations = {
  assignValidation,
  reassignValidation,
  replaceValidation,
  removeValidation,
  cancelValidation,
  remarksValidation,
};
