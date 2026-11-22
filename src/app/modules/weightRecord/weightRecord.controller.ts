import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import { WeightRecordServices } from "./weightRecord.services.js";

//farm-level authorization happens in the service; the controller only maps HTTP <-> service
const farmIdOf = (req: Request) => req.params.farmId as string;
const idOf = (req: Request) => req.params.id as string;
const requesterOf = (req: Request) => req.user.userId as string;
const bodyOf = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
const queryOf = (req: Request) => req.query as Record<string, unknown>;

const checkWeightEntry = catchAsync(async (req: Request, res: Response) => {
  const data = await WeightRecordServices.checkWeightEntry(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Weight entry checked!", data });
});

const createWeightRecord = catchAsync(async (req: Request, res: Response) => {
  const data = await WeightRecordServices.createWeightRecord(
    farmIdOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.CREATED,
    success: true,
    message: data.warnings.length
      ? "Weight record logged — check the warnings in the response."
      : "Weight record logged successfully!",
    data,
  });
});

const getFarmWeightRecords = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await WeightRecordServices.getFarmWeightRecords(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Weight records retrieved successfully!",
    meta,
    data,
  });
});

const getAnimalWeightRecords = catchAsync(async (req: Request, res: Response) => {
  const { data } = await WeightRecordServices.getAnimalWeightRecords(
    farmIdOf(req),
    req.params.animalId as string,
    requesterOf(req),
    queryOf(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Animal growth trajectory retrieved successfully!",
    data,
  });
});

const getGrowthSummary = catchAsync(async (req: Request, res: Response) => {
  const data = await WeightRecordServices.getGrowthSummary(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Growth summary retrieved successfully!",
    data,
  });
});

const getMeta = catchAsync(async (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Weight record metadata retrieved successfully!",
    data: WeightRecordServices.getMeta(),
  });
});

const getRecorders = catchAsync(async (req: Request, res: Response) => {
  const data = await WeightRecordServices.getRecorders(farmIdOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Farm recorders retrieved successfully!", data });
});

const getWeightRecord = catchAsync(async (req: Request, res: Response) => {
  const data = await WeightRecordServices.getWeightRecord(farmIdOf(req), idOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Weight record retrieved successfully!", data });
});

const getAuditLogs = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await WeightRecordServices.getAuditLogs(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    queryOf(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Weight record history retrieved successfully!",
    meta,
    data,
  });
});

const updateWeightRecord = catchAsync(async (req: Request, res: Response) => {
  const data = await WeightRecordServices.updateWeightRecord(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: data.mode === "unchanged" ? "Nothing to correct — the record is unchanged." : "Weight record corrected!",
    data,
  });
});

const deleteWeightRecord = catchAsync(async (req: Request, res: Response) => {
  const data = await WeightRecordServices.deleteWeightRecord(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: data.mode === "hard" ? "Weight record permanently deleted!" : "Weight record voided!",
    data,
  });
});

export const WeightRecordController = {
  checkWeightEntry,
  createWeightRecord,
  getFarmWeightRecords,
  getAnimalWeightRecords,
  getGrowthSummary,
  getMeta,
  getRecorders,
  getWeightRecord,
  getAuditLogs,
  updateWeightRecord,
  deleteWeightRecord,
};
