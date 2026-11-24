import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import { PregnancyServices } from "./pregnancy.services.js";

//farm-level authorization happens in the service; the controller only maps HTTP <-> service
const farmIdOf = (req: Request) => req.params.farmId as string;
const idOf = (req: Request) => req.params.id as string;
const animalIdOf = (req: Request) => req.params.animalId as string;
const requesterOf = (req: Request) => req.user.userId as string;
const bodyOf = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
const queryOf = (req: Request) => req.query as Record<string, unknown>;

const createPregnancy = catchAsync(async (req: Request, res: Response) => {
  const data = await PregnancyServices.createPregnancy(
    farmIdOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, { statusCode: status.CREATED, success: true, message: "Pregnancy record created successfully!", data });
});

const getFarmPregnancies = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await PregnancyServices.getFarmPregnancies(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Pregnancy records retrieved successfully!", meta, data });
});

const getAnimalPregnancies = catchAsync(async (req: Request, res: Response) => {
  const data = await PregnancyServices.getAnimalPregnancies(farmIdOf(req), animalIdOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Animal pregnancy history retrieved successfully!", data });
});

const getPregnancyAnalytics = catchAsync(async (req: Request, res: Response) => {
  const data = await PregnancyServices.getPregnancyAnalytics(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Pregnancy analytics calculated!", data });
});

const getEligibleBreedings = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await PregnancyServices.getEligibleBreedings(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Confirmed breedings without a pregnancy retrieved successfully!", meta, data });
});

const getPregnancy = catchAsync(async (req: Request, res: Response) => {
  const data = await PregnancyServices.getPregnancy(farmIdOf(req), idOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Pregnancy record retrieved successfully!", data });
});

const getAuditLogs = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await PregnancyServices.getAuditLogs(farmIdOf(req), idOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Pregnancy history retrieved successfully!", meta, data });
});

const deliverPregnancy = catchAsync(async (req: Request, res: Response) => {
  const data = await PregnancyServices.deliverPregnancy(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, { statusCode: status.OK, success: true, message: "Calving recorded successfully!", data });
});

const recordPregnancyOutcome = catchAsync(async (req: Request, res: Response) => {
  const data = await PregnancyServices.recordPregnancyOutcome(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, { statusCode: status.OK, success: true, message: `Pregnancy outcome recorded: ${data.outcome}!`, data });
});

const updatePregnancy = catchAsync(async (req: Request, res: Response) => {
  const data = await PregnancyServices.updatePregnancy(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: data.mode === "unchanged" ? "Nothing to update — the pregnancy record is unchanged." : "Pregnancy record corrected!",
    data,
  });
});

const deletePregnancy = catchAsync(async (req: Request, res: Response) => {
  const data = await PregnancyServices.deletePregnancy(farmIdOf(req), idOf(req), requesterOf(req), bodyOf(req), auditContextFromRequest(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Pregnancy record deletion blocked — use an outcome transition instead!", data });
});

export const PregnancyController = {
  createPregnancy,
  getFarmPregnancies,
  getAnimalPregnancies,
  getPregnancyAnalytics,
  getEligibleBreedings,
  getPregnancy,
  getAuditLogs,
  deliverPregnancy,
  recordPregnancyOutcome,
  updatePregnancy,
  deletePregnancy,
};
