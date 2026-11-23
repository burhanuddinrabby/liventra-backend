import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import { TreatmentServices } from "./treatment.services.js";

//farm-level authorization happens in the service; the controller only maps HTTP <-> service
const farmIdOf = (req: Request) => req.params.farmId as string;
const idOf = (req: Request) => req.params.id as string;
const requesterOf = (req: Request) => req.user.userId as string;
const bodyOf = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
const queryOf = (req: Request) => req.query as Record<string, unknown>;

const createTreatment = catchAsync(async (req: Request, res: Response) => {
  const data = await TreatmentServices.createTreatment(farmIdOf(req), requesterOf(req), bodyOf(req), auditContextFromRequest(req));
  sendResponse(res, { statusCode: status.CREATED, success: true, message: "Treatment started successfully!", data });
});

const getFarmTreatments = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await TreatmentServices.getFarmTreatments(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Treatments retrieved successfully!", meta, data });
});

const getAnimalTreatments = catchAsync(async (req: Request, res: Response) => {
  const data = await TreatmentServices.getAnimalTreatments(farmIdOf(req), req.params.animalId as string, requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Animal treatment history retrieved successfully!", data });
});

const getWithdrawals = catchAsync(async (req: Request, res: Response) => {
  const data = await TreatmentServices.getWithdrawals(farmIdOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Active withdrawal periods calculated!", data });
});

const getFollowUps = catchAsync(async (req: Request, res: Response) => {
  const data = await TreatmentServices.getFollowUps(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Treatment follow-ups retrieved successfully!", data });
});

const getStats = catchAsync(async (req: Request, res: Response) => {
  const data = await TreatmentServices.getStats(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Treatment statistics calculated!", data });
});

const getMeta = catchAsync(async (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Treatment metadata retrieved successfully!",
    data: TreatmentServices.getMeta(),
  });
});

const getStaff = catchAsync(async (req: Request, res: Response) => {
  const data = await TreatmentServices.getStaff(farmIdOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Farm members retrieved successfully!", data });
});

const getTreatment = catchAsync(async (req: Request, res: Response) => {
  const data = await TreatmentServices.getTreatment(farmIdOf(req), idOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Treatment retrieved successfully!", data });
});

const getStockOptions = catchAsync(async (req: Request, res: Response) => {
  const data = await TreatmentServices.getStockOptions(farmIdOf(req), idOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Medicine stock options retrieved successfully!", data });
});

const getAuditLogs = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await TreatmentServices.getAuditLogs(farmIdOf(req), idOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Treatment history retrieved successfully!", meta, data });
});

const changeStatus = catchAsync(async (req: Request, res: Response) => {
  const data = await TreatmentServices.changeStatus(farmIdOf(req), idOf(req), requesterOf(req), bodyOf(req), auditContextFromRequest(req));
  const newStatus = (data.treatment as { status?: string }).status;
  sendResponse(res, { statusCode: status.OK, success: true, message: `Treatment marked ${newStatus}!`, data });
});

const consumeInventory = catchAsync(async (req: Request, res: Response) => {
  const data = await TreatmentServices.consumeInventory(farmIdOf(req), idOf(req), requesterOf(req), bodyOf(req), auditContextFromRequest(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Medicine usage recorded and stock updated!", data });
});

const updateTreatment = catchAsync(async (req: Request, res: Response) => {
  const data = await TreatmentServices.updateTreatment(farmIdOf(req), idOf(req), requesterOf(req), bodyOf(req), auditContextFromRequest(req));
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: data.mode === "unchanged" ? "Nothing to update — the treatment is unchanged." : "Treatment updated!",
    data,
  });
});

const deleteTreatment = catchAsync(async (req: Request, res: Response) => {
  const data = await TreatmentServices.deleteTreatment(farmIdOf(req), idOf(req), requesterOf(req), bodyOf(req), auditContextFromRequest(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Treatment entry deleted!", data });
});

export const TreatmentController = {
  createTreatment,
  getFarmTreatments,
  getAnimalTreatments,
  getWithdrawals,
  getFollowUps,
  getStats,
  getMeta,
  getStaff,
  getTreatment,
  getStockOptions,
  getAuditLogs,
  changeStatus,
  consumeInventory,
  updateTreatment,
  deleteTreatment,
};
