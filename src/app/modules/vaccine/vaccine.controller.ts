import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import { VaccineServices } from "./vaccine.services.js";

type TBody = Record<string, unknown>;
const bodyOf = (req: Request): TBody => (req.body ?? {}) as TBody;

const createVaccine = catchAsync(async (req: Request, res: Response) => {
  const vaccine = await VaccineServices.createVaccine(bodyOf(req), auditContextFromRequest(req));
  sendResponse(res, {
    statusCode: status.CREATED,
    success: true,
    message: "Vaccine created successfully!",
    data: vaccine,
  });
});

const getAllVaccines = catchAsync(async (req: Request, res: Response) => {
  const { meta, vaccines } = await VaccineServices.getAllVaccines(req.query as TBody);
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Vaccines retrieved successfully!",
    meta,
    data: vaccines,
  });
});

const getVaccineLookup = catchAsync(async (req: Request, res: Response) => {
  const vaccines = await VaccineServices.getVaccineLookup(req.query as TBody);
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Vaccine lookup retrieved successfully!",
    data: vaccines,
  });
});

const getVaccineMeta = catchAsync(async (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Vaccine metadata retrieved successfully!",
    data: VaccineServices.getVaccineMeta(),
  });
});

const getVaccineStats = catchAsync(async (_req: Request, res: Response) => {
  const stats = await VaccineServices.getVaccineStats();
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Vaccine statistics retrieved successfully!",
    data: stats,
  });
});

const getVaccine = catchAsync(async (req: Request, res: Response) => {
  const vaccine = await VaccineServices.getVaccine(req.params.id as string);
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Vaccine retrieved successfully!",
    data: vaccine,
  });
});

const getSchedulePreview = catchAsync(async (req: Request, res: Response) => {
  const schedule = await VaccineServices.getSchedulePreview(
    req.params.id as string,
    req.query as TBody,
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Vaccine schedule preview generated successfully!",
    data: schedule,
  });
});

const getVaccineUsage = catchAsync(async (req: Request, res: Response) => {
  const usage = await VaccineServices.getVaccineUsage(req.params.id as string);
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Vaccine usage retrieved successfully!",
    data: usage,
  });
});

const getVaccineAuditLogs = catchAsync(async (req: Request, res: Response) => {
  const { meta, logs } = await VaccineServices.getVaccineAuditLogs(
    req.params.id as string,
    req.query as TBody,
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Vaccine history retrieved successfully!",
    meta,
    data: logs,
  });
});

const updateVaccine = catchAsync(async (req: Request, res: Response) => {
  const result = await VaccineServices.updateVaccine(
    req.params.id as string,
    bodyOf(req),
    auditContextFromRequest(req),
  );
  //no-op updates return the unchanged document itself
  const vaccine = "vaccine" in result ? result.vaccine : result;
  const protocolChanged = "protocolChanged" in result ? result.protocolChanged : false;
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: protocolChanged
      ? "Vaccine updated! Protocol changes apply to future vaccinations only."
      : "Vaccine updated successfully!",
    data: vaccine,
  });
});

const toggleActive = catchAsync(async (req: Request, res: Response) => {
  const vaccine = await VaccineServices.toggleActive(
    req.params.id as string,
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: vaccine.isActive
      ? "Vaccine activated successfully!"
      : "Vaccine retired from the catalog!",
    data: vaccine,
  });
});

const deleteVaccine = catchAsync(async (req: Request, res: Response) => {
  const result = await VaccineServices.deleteVaccine(
    req.params.id as string,
    req.query as TBody,
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message:
      result.mode === "deleted"
        ? "Vaccine permanently deleted!"
        : "Vaccine retired (soft deleted) successfully!",
    data: result,
  });
});

export const VaccineController = {
  createVaccine,
  getAllVaccines,
  getVaccineLookup,
  getVaccineMeta,
  getVaccineStats,
  getVaccine,
  getSchedulePreview,
  getVaccineUsage,
  getVaccineAuditLogs,
  updateVaccine,
  toggleActive,
  deleteVaccine,
};
