import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import { VaccinationServices } from "./vaccination.services.js";

//farm-level authorization happens in the service; the controller only maps HTTP <-> service
const farmIdOf = (req: Request) => req.params.farmId as string;
const idOf = (req: Request) => req.params.id as string;
const requesterOf = (req: Request) => req.user.userId as string;
const bodyOf = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
const queryOf = (req: Request) => req.query as Record<string, unknown>;

const previewVaccination = catchAsync(async (req: Request, res: Response) => {
  const data = await VaccinationServices.previewVaccination(farmIdOf(req), requesterOf(req), bodyOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Vaccination checked (not saved)!", data });
});

const createVaccination = catchAsync(async (req: Request, res: Response) => {
  const data = await VaccinationServices.createVaccination(
    farmIdOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.CREATED,
    success: true,
    message:
      (data.vaccination as { status?: string }).status === "Completed"
        ? "Vaccination recorded successfully!"
        : "Vaccination scheduled successfully!",
    data,
  });
});

const getFarmVaccinations = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await VaccinationServices.getFarmVaccinations(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Vaccinations retrieved successfully!", meta, data });
});

const getAnimalVaccinations = catchAsync(async (req: Request, res: Response) => {
  const data = await VaccinationServices.getAnimalVaccinations(
    farmIdOf(req),
    req.params.animalId as string,
    requesterOf(req),
  );
  sendResponse(res, { statusCode: status.OK, success: true, message: "Animal immunization history retrieved successfully!", data });
});

const getCompliance = catchAsync(async (req: Request, res: Response) => {
  const data = await VaccinationServices.getCompliance(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Vaccination compliance calculated!", data });
});

const getMeta = catchAsync(async (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Vaccination metadata retrieved successfully!",
    data: VaccinationServices.getMeta(),
  });
});

const getAdministrators = catchAsync(async (req: Request, res: Response) => {
  const data = await VaccinationServices.getAdministrators(farmIdOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Farm members retrieved successfully!", data });
});

const getVaccination = catchAsync(async (req: Request, res: Response) => {
  const data = await VaccinationServices.getVaccination(farmIdOf(req), idOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Vaccination retrieved successfully!", data });
});

const getAuditLogs = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await VaccinationServices.getAuditLogs(farmIdOf(req), idOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Vaccination history retrieved successfully!", meta, data });
});

const completeVaccination = catchAsync(async (req: Request, res: Response) => {
  const data = await VaccinationServices.completeVaccination(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, { statusCode: status.OK, success: true, message: "Vaccination completed and stock updated!", data });
});

const changeStatus = catchAsync(async (req: Request, res: Response) => {
  const data = await VaccinationServices.changeStatus(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  const newStatus = (data.vaccination as { status?: string }).status;
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: `Vaccination marked ${newStatus}${data.rescheduled ? " and rescheduled" : ""}!`,
    data,
  });
});

const updateVaccination = catchAsync(async (req: Request, res: Response) => {
  const data = await VaccinationServices.updateVaccination(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: data.mode === "unchanged" ? "Nothing to correct — the record is unchanged." : "Vaccination corrected!",
    data,
  });
});

const deleteVaccination = catchAsync(async (req: Request, res: Response) => {
  const data = await VaccinationServices.deleteVaccination(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, { statusCode: status.OK, success: true, message: "Vaccination draft deleted!", data });
});

export const VaccinationController = {
  previewVaccination,
  createVaccination,
  getFarmVaccinations,
  getAnimalVaccinations,
  getCompliance,
  getMeta,
  getAdministrators,
  getVaccination,
  getAuditLogs,
  completeVaccination,
  changeStatus,
  updateVaccination,
  deleteVaccination,
};
