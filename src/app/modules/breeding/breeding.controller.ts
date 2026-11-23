import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import { BreedingServices } from "./breeding.services.js";

//farm-level authorization happens in the service; the controller only maps HTTP <-> service
const farmIdOf = (req: Request) => req.params.farmId as string;
const idOf = (req: Request) => req.params.id as string;
const requesterOf = (req: Request) => req.user.userId as string;
const bodyOf = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
const queryOf = (req: Request) => req.query as Record<string, unknown>;

const createBreeding = catchAsync(async (req: Request, res: Response) => {
  const data = await BreedingServices.createBreeding(farmIdOf(req), requesterOf(req), bodyOf(req), auditContextFromRequest(req));
  sendResponse(res, { statusCode: status.CREATED, success: true, message: "Breeding event logged successfully!", data });
});

const getFarmBreedings = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await BreedingServices.getFarmBreedings(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Breeding records retrieved successfully!", meta, data });
});

const getAnimalBreedings = catchAsync(async (req: Request, res: Response) => {
  const data = await BreedingServices.getAnimalBreedings(farmIdOf(req), req.params.animalId as string, requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Animal breeding history retrieved successfully!", data });
});

const getAnalytics = catchAsync(async (req: Request, res: Response) => {
  const data = await BreedingServices.getAnalytics(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Breeding analytics calculated!", data });
});

const getPregnancyChecks = catchAsync(async (req: Request, res: Response) => {
  const data = await BreedingServices.getPregnancyChecks(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Pregnancy checks retrieved successfully!", data });
});

const getEligibility = catchAsync(async (req: Request, res: Response) => {
  const data = await BreedingServices.getEligibility(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Breeding eligibility checked!", data });
});

const getBulls = catchAsync(async (req: Request, res: Response) => {
  const data = await BreedingServices.getBulls(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Bulls retrieved successfully!", data });
});

const getMeta = catchAsync(async (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Breeding metadata retrieved successfully!",
    data: BreedingServices.getMeta(),
  });
});

const getBreeding = catchAsync(async (req: Request, res: Response) => {
  const data = await BreedingServices.getBreeding(farmIdOf(req), idOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Breeding record retrieved successfully!", data });
});

const getAuditLogs = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await BreedingServices.getAuditLogs(farmIdOf(req), idOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Breeding history retrieved successfully!", meta, data });
});

const recordPregnancyResult = catchAsync(async (req: Request, res: Response) => {
  const data = await BreedingServices.recordPregnancyResult(farmIdOf(req), idOf(req), requesterOf(req), bodyOf(req), auditContextFromRequest(req));
  const result = (data.breeding as { pregnancyResult?: string }).pregnancyResult;
  sendResponse(res, { statusCode: status.OK, success: true, message: `Pregnancy result recorded: ${result}!`, data });
});

const updateBreeding = catchAsync(async (req: Request, res: Response) => {
  const data = await BreedingServices.updateBreeding(farmIdOf(req), idOf(req), requesterOf(req), bodyOf(req), auditContextFromRequest(req));
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: data.mode === "unchanged" ? "Nothing to update — the breeding record is unchanged." : "Breeding record corrected!",
    data,
  });
});

const deleteBreeding = catchAsync(async (req: Request, res: Response) => {
  const data = await BreedingServices.deleteBreeding(farmIdOf(req), idOf(req), requesterOf(req), bodyOf(req), auditContextFromRequest(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Breeding entry deleted!", data });
});

export const BreedingController = {
  createBreeding,
  getFarmBreedings,
  getAnimalBreedings,
  getAnalytics,
  getPregnancyChecks,
  getEligibility,
  getBulls,
  getMeta,
  getBreeding,
  getAuditLogs,
  recordPregnancyResult,
  updateBreeding,
  deleteBreeding,
};
