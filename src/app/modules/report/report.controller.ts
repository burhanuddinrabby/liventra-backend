import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import { ReportServices } from "./report.services.js";

//farm-level authorization happens in the service; the controller only maps HTTP <-> service
const farmIdOf = (req: Request) => req.params.farmId as string;
const idOf = (req: Request) => req.params.id as string;
const requesterOf = (req: Request) => req.user.userId as string;
const bodyOf = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
const queryOf = (req: Request) => req.query as Record<string, unknown>;

const getMeta = catchAsync(async (req: Request, res: Response) => {
  const data = await ReportServices.getMeta(farmIdOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Report options retrieved!", data });
});

const previewCount = catchAsync(async (req: Request, res: Response) => {
  const data = await ReportServices.previewCount(farmIdOf(req), requesterOf(req), bodyOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Row count estimated!", data });
});

const createReport = catchAsync(async (req: Request, res: Response) => {
  const data = await ReportServices.createReport(
    farmIdOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.ACCEPTED,
    success: true,
    message: "Report generation has been queued.",
    data,
  });
});

const listReports = catchAsync(async (req: Request, res: Response) => {
  const { data, meta } = await ReportServices.listReports(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Reports retrieved!", meta, data });
});

const getReport = catchAsync(async (req: Request, res: Response) => {
  const data = await ReportServices.getReport(farmIdOf(req), requesterOf(req), idOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Report retrieved!", data });
});

const downloadReport = catchAsync(async (req: Request, res: Response) => {
  const file = await ReportServices.downloadReport(
    farmIdOf(req),
    requesterOf(req),
    idOf(req),
    auditContextFromRequest(req),
  );
  res
    .set({
      "Content-Type": file.mime,
      "Content-Disposition": `attachment; filename="${file.fileName}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    })
    .send(file.buffer);
});

const retryReport = catchAsync(async (req: Request, res: Response) => {
  const data = await ReportServices.retryReport(
    farmIdOf(req),
    requesterOf(req),
    idOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, { statusCode: status.ACCEPTED, success: true, message: "A new report has been queued.", data });
});

const deleteReport = catchAsync(async (req: Request, res: Response) => {
  const data = await ReportServices.deleteReport(farmIdOf(req), requesterOf(req), idOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Reports cannot be deleted.", data });
});

export const ReportController = {
  getMeta,
  previewCount,
  createReport,
  listReports,
  getReport,
  downloadReport,
  retryReport,
  deleteReport,
};
