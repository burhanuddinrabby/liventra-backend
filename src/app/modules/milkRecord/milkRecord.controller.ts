import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import { MilkRecordServices } from "./milkRecord.services.js";

//farm-level authorization happens in the service; the controller only maps HTTP <-> service
const farmIdOf = (req: Request) => req.params.farmId as string;
const idOf = (req: Request) => req.params.id as string;
const requesterOf = (req: Request) => req.user.userId as string;
const bodyOf = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
const queryOf = (req: Request) => req.query as Record<string, unknown>;

const checkEligibility = catchAsync(async (req: Request, res: Response) => {
  const data = await MilkRecordServices.checkEligibilityForForm(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Milk logging eligibility checked!", data });
});

const createMilkRecord = catchAsync(async (req: Request, res: Response) => {
  const data = await MilkRecordServices.createMilkRecord(
    farmIdOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.CREATED,
    success: true,
    message: data.withdrawal.active
      ? "Milk logged — WARNING: animal is inside a medicine withdrawal period!"
      : "Milk record logged successfully!",
    data,
  });
});

const bulkCreateMilkRecords = catchAsync(async (req: Request, res: Response) => {
  const data = await MilkRecordServices.bulkCreateMilkRecords(
    farmIdOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: data.dryRun || data.saved === 0 ? status.OK : status.CREATED,
    success: true,
    message: data.dryRun
      ? `Checked ${data.created.length + data.failedCount} entries (nothing saved).`
      : `${data.saved} milk record(s) saved, ${data.failedCount} failed.`,
    data,
  });
});

const getFarmMilkRecords = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await MilkRecordServices.getFarmMilkRecords(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Milk records retrieved successfully!", meta, data });
});

const getAnimalMilkRecords = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await MilkRecordServices.getAnimalMilkRecords(
    farmIdOf(req),
    req.params.animalId as string,
    requesterOf(req),
    queryOf(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Animal milk history retrieved successfully!",
    meta,
    data,
  });
});

const getSummary = catchAsync(async (req: Request, res: Response) => {
  const data = await MilkRecordServices.getSummary(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Milk production summary retrieved!", data });
});

const getMeta = catchAsync(async (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Milk record metadata retrieved successfully!",
    data: MilkRecordServices.getMeta(),
  });
});

const getRecorders = catchAsync(async (req: Request, res: Response) => {
  const data = await MilkRecordServices.getRecorders(farmIdOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Farm recorders retrieved successfully!", data });
});

const getMilkRecord = catchAsync(async (req: Request, res: Response) => {
  const data = await MilkRecordServices.getMilkRecord(farmIdOf(req), idOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Milk record retrieved successfully!", data });
});

const getAuditLogs = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await MilkRecordServices.getAuditLogs(farmIdOf(req), idOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Milk record history retrieved successfully!", meta, data });
});

const updateMilkRecord = catchAsync(async (req: Request, res: Response) => {
  const data = await MilkRecordServices.updateMilkRecord(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: data.mode === "unchanged" ? "Nothing to correct — the record is unchanged." : "Milk record corrected!",
    data,
  });
});

const updateMilkQuality = catchAsync(async (req: Request, res: Response) => {
  const data = await MilkRecordServices.updateMilkQuality(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: data.mode === "unchanged" ? "Quality is unchanged." : "Milk quality updated!",
    data,
  });
});

const deleteMilkRecord = catchAsync(async (req: Request, res: Response) => {
  const data = await MilkRecordServices.deleteMilkRecord(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: data.mode === "hard" ? "Milk record permanently deleted!" : "Milk record voided!",
    data,
  });
});

export const MilkRecordController = {
  checkEligibility,
  createMilkRecord,
  bulkCreateMilkRecords,
  getFarmMilkRecords,
  getAnimalMilkRecords,
  getSummary,
  getMeta,
  getRecorders,
  getMilkRecord,
  getAuditLogs,
  updateMilkRecord,
  updateMilkQuality,
  deleteMilkRecord,
};
