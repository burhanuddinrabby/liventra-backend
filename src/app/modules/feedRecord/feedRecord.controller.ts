import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import { FeedRecordServices } from "./feedRecord.services.js";

//farm-level authorization happens in the service; the controller only maps HTTP <-> service
const farmIdOf = (req: Request) => req.params.farmId as string;
const idOf = (req: Request) => req.params.id as string;
const requesterOf = (req: Request) => req.user.userId as string;
const bodyOf = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
const queryOf = (req: Request) => req.query as Record<string, unknown>;

const previewFeedRecord = catchAsync(async (req: Request, res: Response) => {
  const data = await FeedRecordServices.previewFeedRecord(farmIdOf(req), requesterOf(req), bodyOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Feeding preview calculated (not saved)!", data });
});

const createFeedRecord = catchAsync(async (req: Request, res: Response) => {
  const data = await FeedRecordServices.createFeedRecord(
    farmIdOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, { statusCode: status.CREATED, success: true, message: "Feeding logged successfully!", data });
});

const getFarmFeedRecords = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await FeedRecordServices.getFarmFeedRecords(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Feed records retrieved successfully!", meta, data });
});

const getAnimalFeedRecords = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await FeedRecordServices.getAnimalFeedRecords(
    farmIdOf(req),
    req.params.animalId as string,
    requesterOf(req),
    queryOf(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Animal feeding history retrieved successfully!",
    meta,
    data,
  });
});

const getMeta = catchAsync(async (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Feed record metadata retrieved successfully!",
    data: FeedRecordServices.getMeta(),
  });
});

const getStats = catchAsync(async (req: Request, res: Response) => {
  const data = await FeedRecordServices.getStats(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Feed record stats retrieved successfully!", data });
});

const getFeeders = catchAsync(async (req: Request, res: Response) => {
  const data = await FeedRecordServices.getFeeders(farmIdOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Farm feeders retrieved successfully!", data });
});

const getAdherence = catchAsync(async (req: Request, res: Response) => {
  const data = await FeedRecordServices.getAdherence(
    farmIdOf(req),
    req.params.recommendationId as string,
    requesterOf(req),
    queryOf(req),
  );
  sendResponse(res, { statusCode: status.OK, success: true, message: "Feeding adherence calculated!", data });
});

const getFeedRecord = catchAsync(async (req: Request, res: Response) => {
  const data = await FeedRecordServices.getFeedRecord(farmIdOf(req), idOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Feed record retrieved successfully!", data });
});

const getAuditLogs = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await FeedRecordServices.getAuditLogs(farmIdOf(req), idOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Feed record history retrieved successfully!", meta, data });
});

const updateFeedRecord = catchAsync(async (req: Request, res: Response) => {
  const data = await FeedRecordServices.updateFeedRecord(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: data.mode === "unchanged" ? "Nothing to correct — the record is unchanged." : "Feed record corrected and inventory reconciled!",
    data,
  });
});

const voidFeedRecord = catchAsync(async (req: Request, res: Response) => {
  const data = await FeedRecordServices.voidFeedRecord(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, { statusCode: status.OK, success: true, message: "Feed record voided and stock restored!", data });
});

export const FeedRecordController = {
  previewFeedRecord,
  createFeedRecord,
  getFarmFeedRecords,
  getAnimalFeedRecords,
  getMeta,
  getStats,
  getFeeders,
  getAdherence,
  getFeedRecord,
  getAuditLogs,
  updateFeedRecord,
  voidFeedRecord,
};
