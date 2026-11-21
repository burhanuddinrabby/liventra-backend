import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import { FeedRecommendationServices } from "./feedRecommendation.services.js";

//farm-level authorization happens in the service; the controller only maps HTTP <-> service
const farmIdOf = (req: Request) => req.params.farmId as string;
const idOf = (req: Request) => req.params.id as string;
const requesterOf = (req: Request) => req.user.userId as string;
const bodyOf = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
const queryOf = (req: Request) => req.query as Record<string, unknown>;

const previewRecommendation = catchAsync(async (req: Request, res: Response) => {
  const data = await FeedRecommendationServices.previewRecommendation(farmIdOf(req), requesterOf(req), bodyOf(req));
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Recommendation preview generated (not saved)!",
    data,
  });
});

const createRecommendation = catchAsync(async (req: Request, res: Response) => {
  const data = await FeedRecommendationServices.createRecommendation(
    farmIdOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.CREATED,
    success: true,
    message: "Feed recommendation saved successfully!",
    data,
  });
});

const getFarmRecommendations = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await FeedRecommendationServices.getFarmRecommendations(
    farmIdOf(req),
    requesterOf(req),
    queryOf(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Feed recommendations retrieved successfully!",
    meta,
    data,
  });
});

const getAnimalRecommendations = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await FeedRecommendationServices.getAnimalRecommendations(
    farmIdOf(req),
    req.params.animalId as string,
    requesterOf(req),
    queryOf(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Animal feed recommendation history retrieved successfully!",
    meta,
    data,
  });
});

const getMeta = catchAsync(async (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Feed recommendation metadata retrieved successfully!",
    data: FeedRecommendationServices.getMeta(),
  });
});

const getStats = catchAsync(async (req: Request, res: Response) => {
  const data = await FeedRecommendationServices.getStats(farmIdOf(req), requesterOf(req));
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Feed recommendation stats retrieved successfully!",
    data,
  });
});

const getRecommendation = catchAsync(async (req: Request, res: Response) => {
  const data = await FeedRecommendationServices.getRecommendation(farmIdOf(req), idOf(req), requesterOf(req));
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Feed recommendation retrieved successfully!",
    data,
  });
});

const getAuditLogs = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await FeedRecommendationServices.getAuditLogs(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    queryOf(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Recommendation audit logs retrieved successfully!",
    meta,
    data,
  });
});

const updateStatus = catchAsync(async (req: Request, res: Response) => {
  const data = await FeedRecommendationServices.updateStatus(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: `Recommendation status changed to ${String(data.recommendation?.status ?? "")}!`,
    data,
  });
});

const reviewRecommendation = catchAsync(async (req: Request, res: Response) => {
  const data = await FeedRecommendationServices.reviewRecommendation(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Recommendation review recorded!",
    data,
  });
});

const deleteRecommendation = catchAsync(async (req: Request, res: Response) => {
  const data = await FeedRecommendationServices.deleteRecommendation(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Draft recommendation deleted!",
    data,
  });
});

export const FeedRecommendationController = {
  previewRecommendation,
  createRecommendation,
  getFarmRecommendations,
  getAnimalRecommendations,
  getMeta,
  getStats,
  getRecommendation,
  getAuditLogs,
  updateStatus,
  reviewRecommendation,
  deleteRecommendation,
};
