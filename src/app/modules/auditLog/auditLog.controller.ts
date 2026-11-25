import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { AuditLogServices } from "./auditLog.services.js";

const param = (req: Request, name: string) => req.params[name] as string;
const queryOf = (req: Request) => req.query as Record<string, unknown>;
const requesterOf = (req: Request) => req.user.userId as string;

const sendList = (res: Response, { meta, logs }: Awaited<ReturnType<typeof AuditLogServices.getFarmLogs>>) =>
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Audit logs retrieved successfully!",
    meta,
    data: logs,
  });

const send = (res: Response, message: string, data: unknown) =>
  sendResponse(res, { statusCode: status.OK, success: true, message, data });

const getFarmLogs = catchAsync(async (req: Request, res: Response) => {
  sendList(res, await AuditLogServices.getFarmLogs(param(req, "farmId"), requesterOf(req), queryOf(req)));
});

const getEntityLogs = catchAsync(async (req: Request, res: Response) => {
  sendList(
    res,
    await AuditLogServices.getEntityLogs(
      param(req, "farmId"),
      requesterOf(req),
      param(req, "entityType"),
      param(req, "entityId"),
      queryOf(req),
    ),
  );
});

const getUserLogs = catchAsync(async (req: Request, res: Response) => {
  sendList(
    res,
    await AuditLogServices.getUserLogs(param(req, "farmId"), requesterOf(req), param(req, "userId"), queryOf(req)),
  );
});

const getSummary = catchAsync(async (req: Request, res: Response) => {
  send(
    res,
    "Audit summary retrieved successfully!",
    await AuditLogServices.getSummary(param(req, "farmId"), requesterOf(req), queryOf(req)),
  );
});

const getMeta = catchAsync(async (req: Request, res: Response) => {
  send(res, "Audit metadata retrieved successfully!", await AuditLogServices.getMeta(param(req, "farmId"), requesterOf(req)));
});

const getFarmLog = catchAsync(async (req: Request, res: Response) => {
  send(
    res,
    "Audit log retrieved successfully!",
    await AuditLogServices.getFarmLog(param(req, "farmId"), requesterOf(req), param(req, "id")),
  );
});

const getPlatformLogs = catchAsync(async (req: Request, res: Response) => {
  sendList(res, await AuditLogServices.getPlatformLogs(requesterOf(req), queryOf(req)));
});

const getPlatformLog = catchAsync(async (req: Request, res: Response) => {
  send(res, "Audit log retrieved successfully!", await AuditLogServices.getPlatformLog(requesterOf(req), param(req, "id")));
});

export const AuditLogController = {
  getFarmLogs,
  getEntityLogs,
  getUserLogs,
  getSummary,
  getMeta,
  getFarmLog,
  getPlatformLogs,
  getPlatformLog,
};
