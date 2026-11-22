import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import { DiseaseServices } from "./disease.services.js";

type TBody = Record<string, unknown>;
const bodyOf = (req: Request): TBody => (req.body ?? {}) as TBody;
//custom string userId (U-YY-NNNN) from the verified JWT
const actorOf = (req: Request) => req.user?.userId as string | undefined;

const createDisease = catchAsync(async (req: Request, res: Response) => {
  const disease = await DiseaseServices.createDisease(bodyOf(req), auditContextFromRequest(req));
  sendResponse(res, {
    statusCode: status.CREATED,
    success: true,
    message: "Disease created successfully!",
    data: disease,
  });
});

const getAllDiseases = catchAsync(async (req: Request, res: Response) => {
  const { meta, diseases } = await DiseaseServices.getAllDiseases(req.query as TBody, actorOf(req));
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Diseases retrieved successfully!",
    meta,
    data: diseases,
  });
});

const getDiseaseLookup = catchAsync(async (req: Request, res: Response) => {
  const diseases = await DiseaseServices.getDiseaseLookup(req.query as TBody);
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Disease lookup retrieved successfully!",
    data: diseases,
  });
});

const getDiseaseMeta = catchAsync(async (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Disease metadata retrieved successfully!",
    data: DiseaseServices.getDiseaseMeta(),
  });
});

const getDiseaseStats = catchAsync(async (_req: Request, res: Response) => {
  const stats = await DiseaseServices.getDiseaseStats();
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Disease statistics retrieved successfully!",
    data: stats,
  });
});

const searchBySymptoms = catchAsync(async (req: Request, res: Response) => {
  const result = await DiseaseServices.searchBySymptoms(req.query as TBody);
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Reference matches retrieved — not a diagnosis.",
    data: result,
  });
});

const checkDiseaseName = catchAsync(async (req: Request, res: Response) => {
  const result = await DiseaseServices.checkDiseaseName(req.query as TBody);
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: result.matches.length ? "Possible duplicate disease names found." : "Disease name is available.",
    data: result,
  });
});

const getDisease = catchAsync(async (req: Request, res: Response) => {
  const disease = await DiseaseServices.getDisease(req.params.id as string, actorOf(req));
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Disease retrieved successfully!",
    data: disease,
  });
});

const getRecommendedVaccines = catchAsync(async (req: Request, res: Response) => {
  const result = await DiseaseServices.getRecommendedVaccines(req.params.id as string, actorOf(req));
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Recommended vaccines retrieved successfully!",
    data: result,
  });
});

const getDiseaseUsage = catchAsync(async (req: Request, res: Response) => {
  const usage = await DiseaseServices.getDiseaseUsage(req.params.id as string);
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Disease usage retrieved successfully!",
    data: usage,
  });
});

const getDiseaseAuditLogs = catchAsync(async (req: Request, res: Response) => {
  const { meta, logs } = await DiseaseServices.getDiseaseAuditLogs(req.params.id as string, req.query as TBody);
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Disease history retrieved successfully!",
    meta,
    data: logs,
  });
});

const updateDisease = catchAsync(async (req: Request, res: Response) => {
  const result = await DiseaseServices.updateDisease(
    req.params.id as string,
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: !result.changedFields.length
      ? "No changes detected."
      : result.clinicalChanged
        ? "Disease updated! Changes apply to future health records only."
        : "Disease updated successfully!",
    data: result.disease,
  });
});

const updateRecommendedVaccines = catchAsync(async (req: Request, res: Response) => {
  const result = await DiseaseServices.updateRecommendedVaccines(
    req.params.id as string,
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message:
      result.added || result.removed
        ? `Recommended vaccines updated (${result.added} added, ${result.removed} removed).`
        : "Recommended vaccines already up to date.",
    data: result.disease,
  });
});

const toggleActive = catchAsync(async (req: Request, res: Response) => {
  const disease = await DiseaseServices.toggleActive(
    req.params.id as string,
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: disease.isActive ? "Disease activated successfully!" : "Disease deactivated successfully!",
    data: disease,
  });
});

const deleteDisease = catchAsync(async (req: Request, res: Response) => {
  const result = await DiseaseServices.deleteDisease(
    req.params.id as string,
    req.query as TBody,
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message:
      result.mode === "deleted"
        ? "Disease permanently deleted!"
        : result.hardDeleteBlocked
          ? "Disease is referenced by treatment/vaccine records, so it was deactivated instead of deleted."
          : "Disease deactivated (soft deleted) successfully!",
    data: result,
  });
});

export const DiseaseController = {
  createDisease,
  getAllDiseases,
  getDiseaseLookup,
  getDiseaseMeta,
  getDiseaseStats,
  searchBySymptoms,
  checkDiseaseName,
  getDisease,
  getRecommendedVaccines,
  getDiseaseUsage,
  getDiseaseAuditLogs,
  updateDisease,
  updateRecommendedVaccines,
  toggleActive,
  deleteDisease,
};
