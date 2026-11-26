import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import type { TMeta } from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import { DeviceAssignmentServices } from "./deviceAssignment.services.js";

type TData = Record<string, unknown>;

const param = (req: Request, name: string) => req.params[name] as string;
const queryOf = (req: Request) => req.query as TData;
const requesterOf = (req: Request) => req.user.userId as string;
//express 5 leaves req.body undefined when nothing was sent
const bodyOf = (req: Request) => (req.body ?? {}) as TData;

const send = (res: Response, message: string, data: unknown, statusCode: number = status.OK) =>
  sendResponse(res, { statusCode, success: true, message, data });

const sendPage = (res: Response, message: string, meta: TMeta, data: unknown) =>
  sendResponse(res, { statusCode: status.OK, success: true, message, meta, data });

const assign = catchAsync(async (req, res) => {
  const data = await DeviceAssignmentServices.assign(param(req, "farmId"), requesterOf(req), bodyOf(req), auditContextFromRequest(req));
  send(res, "Device assigned successfully!", data, status.CREATED);
});

const reassign = catchAsync(async (req, res) => {
  const data = await DeviceAssignmentServices.reassign(
    param(req, "farmId"),
    requesterOf(req),
    param(req, "id"),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  send(res, "Device reassigned successfully!", data, status.CREATED);
});

const replace = catchAsync(async (req, res) => {
  const data = await DeviceAssignmentServices.replace(
    param(req, "farmId"),
    requesterOf(req),
    param(req, "id"),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  send(res, "Device replaced successfully!", data, status.CREATED);
});

const remove = catchAsync(async (req, res) => {
  const data = await DeviceAssignmentServices.remove(
    param(req, "farmId"),
    requesterOf(req),
    param(req, "id"),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  send(res, "Device removed from the animal!", data);
});

const cancel = catchAsync(async (req, res) => {
  const data = await DeviceAssignmentServices.cancel(
    param(req, "farmId"),
    requesterOf(req),
    param(req, "id"),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  send(res, "Assignment cancelled!", data);
});

const updateRemarks = catchAsync(async (req, res) => {
  const data = await DeviceAssignmentServices.updateRemarks(
    param(req, "farmId"),
    requesterOf(req),
    param(req, "id"),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  send(res, "Remarks updated!", data);
});

const deleteAssignment = catchAsync(async () => {
  await DeviceAssignmentServices.deleteAssignment();
});

const getAssignments = catchAsync(async (req, res) => {
  const { meta, rows } = await DeviceAssignmentServices.getAssignments(param(req, "farmId"), requesterOf(req), queryOf(req));
  sendPage(res, "Device assignments retrieved successfully!", meta, rows);
});

const getAssignment = catchAsync(async (req, res) => {
  const data = await DeviceAssignmentServices.getAssignment(param(req, "farmId"), requesterOf(req), param(req, "id"));
  send(res, "Device assignment retrieved successfully!", data);
});

const getMeta = catchAsync(async (req, res) => {
  send(res, "Assignment options retrieved successfully!", await DeviceAssignmentServices.getMeta(param(req, "farmId"), requesterOf(req)));
});

const getEligibleDevices = catchAsync(async (req, res) => {
  const data = await DeviceAssignmentServices.getEligibleDevices(param(req, "farmId"), requesterOf(req), queryOf(req));
  send(res, "Assignable devices retrieved successfully!", data);
});

const getEligibleAnimals = catchAsync(async (req, res) => {
  const data = await DeviceAssignmentServices.getEligibleAnimals(param(req, "farmId"), requesterOf(req), queryOf(req));
  send(res, "Eligible animals retrieved successfully!", data);
});

const getDeviceAssignments = catchAsync(async (req, res) => {
  const { meta, rows } = await DeviceAssignmentServices.getDeviceAssignments(
    param(req, "farmId"),
    requesterOf(req),
    param(req, "id"),
    queryOf(req),
  );
  sendPage(res, "Device assignment history retrieved successfully!", meta, rows);
});

const getAnimalDevices = catchAsync(async (req, res) => {
  const data = await DeviceAssignmentServices.getAnimalDevices(param(req, "farmId"), requesterOf(req), param(req, "animalId"));
  send(res, "Animal devices retrieved successfully!", data);
});

export const DeviceAssignmentController = {
  assign,
  reassign,
  replace,
  remove,
  cancel,
  updateRemarks,
  deleteAssignment,
  getAssignments,
  getAssignment,
  getMeta,
  getEligibleDevices,
  getEligibleAnimals,
  getDeviceAssignments,
  getAnimalDevices,
};
