import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import { FeedFormulaServices } from "./feedFormula.services.js";

type TBody = Record<string, unknown>;
const bodyOf = (req: Request): TBody => (req.body ?? {}) as TBody;
const actorOf = (req: Request) => req.user?.userId as string | undefined;

const createFormula = catchAsync(async (req: Request, res: Response) => {
  const result = await FeedFormulaServices.createFormula(bodyOf(req), auditContextFromRequest(req));
  sendResponse(res, {
    statusCode: status.CREATED,
    success: true,
    message: "Feed formula created successfully!",
    data: result,
  });
});

const getAllFormulas = catchAsync(async (req: Request, res: Response) => {
  const { meta, formulas } = await FeedFormulaServices.getAllFormulas(req.query as TBody, actorOf(req));
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Feed formulas retrieved successfully!",
    meta,
    data: formulas,
  });
});

const getFormulaLookup = catchAsync(async (req: Request, res: Response) => {
  const formulas = await FeedFormulaServices.getFormulaLookup(req.query as TBody);
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Feed formula lookup retrieved successfully!",
    data: formulas,
  });
});

const getFormulaMeta = catchAsync(async (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Feed formula metadata retrieved successfully!",
    data: FeedFormulaServices.getFormulaMeta(),
  });
});

const getFormulaStats = catchAsync(async (_req: Request, res: Response) => {
  const stats = await FeedFormulaServices.getFormulaStats();
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Feed formula statistics retrieved successfully!",
    data: stats,
  });
});

const previewComposition = catchAsync(async (req: Request, res: Response) => {
  const preview = await FeedFormulaServices.previewComposition(bodyOf(req));
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Formula composition calculated successfully!",
    data: preview,
  });
});

const matchFormulas = catchAsync(async (req: Request, res: Response) => {
  const result = await FeedFormulaServices.matchFormulas(bodyOf(req), actorOf(req));
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: result.bestMatch
      ? "Matching feed formula found!"
      : result.requiresManualSelection
        ? "Multiple formulas match; manual selection required!"
        : "No suitable active formula found for this context!",
    data: result,
  });
});

const getFormula = catchAsync(async (req: Request, res: Response) => {
  const formula = await FeedFormulaServices.getFormula(req.params.id as string);
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Feed formula retrieved successfully!",
    data: formula,
  });
});

const getFormulaVersions = catchAsync(async (req: Request, res: Response) => {
  const versions = await FeedFormulaServices.getFormulaVersions(req.params.id as string, actorOf(req));
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Feed formula versions retrieved successfully!",
    data: versions,
  });
});

const getFormulaUsage = catchAsync(async (req: Request, res: Response) => {
  const usage = await FeedFormulaServices.getFormulaUsage(req.params.id as string);
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Feed formula usage retrieved successfully!",
    data: usage,
  });
});

const getFormulaAuditLogs = catchAsync(async (req: Request, res: Response) => {
  const { meta, logs } = await FeedFormulaServices.getFormulaAuditLogs(
    req.params.id as string,
    req.query as TBody,
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Feed formula history retrieved successfully!",
    meta,
    data: logs,
  });
});

const updateFormula = catchAsync(async (req: Request, res: Response) => {
  const result = await FeedFormulaServices.updateFormula(
    req.params.id as string,
    bodyOf(req),
    auditContextFromRequest(req),
  );
  const messages = {
    updated: "Feed formula updated successfully!",
    versioned: "Scientific changes saved as a new formula version!",
    unchanged: "No changes detected; feed formula left as is.",
  } as const;
  sendResponse(res, {
    statusCode: result.mode === "versioned" ? status.CREATED : status.OK,
    success: true,
    message: messages[result.mode],
    data: result,
  });
});

const cloneVersion = catchAsync(async (req: Request, res: Response) => {
  const result = await FeedFormulaServices.cloneVersion(
    req.params.id as string,
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.CREATED,
    success: true,
    message: `New formula version ${result.formula.ruleVersion} created successfully!`,
    data: result,
  });
});

const setDefault = catchAsync(async (req: Request, res: Response) => {
  const formula = await FeedFormulaServices.setDefault(
    req.params.id as string,
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: formula.isDefault
      ? "Feed formula set as the default for its context!"
      : "Feed formula is no longer the default!",
    data: formula,
  });
});

const toggleActive = catchAsync(async (req: Request, res: Response) => {
  const formula = await FeedFormulaServices.toggleActive(
    req.params.id as string,
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: formula.isActive ? "Feed formula activated successfully!" : "Feed formula retired successfully!",
    data: formula,
  });
});

const deleteFormula = catchAsync(async (req: Request, res: Response) => {
  const result = await FeedFormulaServices.deleteFormula(
    req.params.id as string,
    req.query as TBody,
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message:
      result.mode === "deleted"
        ? "Feed formula permanently deleted!"
        : "Feed formula retired (soft deleted) successfully!",
    data: result,
  });
});

export const FeedFormulaController = {
  createFormula,
  getAllFormulas,
  getFormulaLookup,
  getFormulaMeta,
  getFormulaStats,
  previewComposition,
  matchFormulas,
  getFormula,
  getFormulaVersions,
  getFormulaUsage,
  getFormulaAuditLogs,
  updateFormula,
  cloneVersion,
  setDefault,
  toggleActive,
  deleteFormula,
};
