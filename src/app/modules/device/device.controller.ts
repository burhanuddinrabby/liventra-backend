import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import type { TMeta } from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import type { TAuditContext } from "../auditLog/auditLog.utils.js";
import { DeviceServices } from "./device.services.js";

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

const createDevice = catchAsync(async (req: Request, res: Response) => {
  const context = auditContextFromRequest(req);
  const device = await DeviceServices.createDevice(param(req, "farmId"), requesterOf(req), bodyOf(req), context);
  send(res, "Device registered successfully!", device, status.CREATED);
});

const getDevices = catchAsync(async (req: Request, res: Response) => {
  const { meta, devices } = await DeviceServices.getDevices(param(req, "farmId"), requesterOf(req), queryOf(req));
  sendPage(res, "Devices retrieved successfully!", meta, devices);
});

const getDashboard = catchAsync(async (req: Request, res: Response) => {
  const data = await DeviceServices.getDashboard(param(req, "farmId"), requesterOf(req));
  send(res, "Device dashboard retrieved successfully!", data);
});

const getMeta = catchAsync(async (req: Request, res: Response) => {
  send(res, "Device options retrieved successfully!", await DeviceServices.getMeta(param(req, "farmId"), requesterOf(req)));
});

const lookup = catchAsync(async (req: Request, res: Response) => {
  const data = await DeviceServices.lookup(param(req, "farmId"), requesterOf(req), queryOf(req));
  send(res, "Devices retrieved successfully!", data);
});

const getDevice = catchAsync(async (req: Request, res: Response) => {
  const data = await DeviceServices.getDevice(param(req, "farmId"), requesterOf(req), param(req, "id"));
  send(res, "Device retrieved successfully!", data);
});

const getAuditLogs = catchAsync(async (req: Request, res: Response) => {
  const { meta, logs } = await DeviceServices.getAuditLogs(
    param(req, "farmId"),
    requesterOf(req),
    param(req, "id"),
    queryOf(req),
  );
  sendPage(res, "Device history retrieved successfully!", meta, logs);
});

// eslint-disable-next-line no-unused-vars
type TWrite = (farmId: string, requester: string, ref: string, context: TAuditContext, body: TData) => Promise<unknown>;

const write = (message: string, work: TWrite) =>
  catchAsync(async (req: Request, res: Response) => {
    const context = auditContextFromRequest(req);
    send(res, message, await work(param(req, "farmId"), requesterOf(req), param(req, "id"), context, bodyOf(req)));
  });

export const DeviceController = {
  createDevice,
  getDevices,
  getDashboard,
  getMeta,
  lookup,
  getDevice,
  getAuditLogs,
  updateDevice: write("Device updated successfully!", DeviceServices.updateDevice),
  changeStatus: write("Device status changed successfully!", DeviceServices.changeStatus),
  deactivate: write("Device deactivated successfully!", DeviceServices.deactivate),
  reactivate: write("Device reactivated successfully!", DeviceServices.reactivate),
  deleteDevice: write("Device deleted successfully!", DeviceServices.deleteDevice),
};
