import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import { FeedIngredientServices } from "./feedIngredient.services.js";

type TBody = Record<string, unknown>;
const bodyOf = (req: Request): TBody => (req.body ?? {}) as TBody;

const createIngredient = catchAsync(async (req: Request, res: Response) => {
  const ingredient = await FeedIngredientServices.createIngredient(
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.CREATED,
    success: true,
    message: "Feed ingredient created successfully!",
    data: ingredient,
  });
});

const getAllIngredients = catchAsync(async (req: Request, res: Response) => {
  const { meta, ingredients } = await FeedIngredientServices.getAllIngredients(
    req.query as TBody,
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Feed ingredients retrieved successfully!",
    meta,
    data: ingredients,
  });
});

const getIngredientLookup = catchAsync(async (req: Request, res: Response) => {
  const ingredients = await FeedIngredientServices.getIngredientLookup(req.query as TBody);
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Feed ingredient lookup retrieved successfully!",
    data: ingredients,
  });
});

const getIngredientMeta = catchAsync(async (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Feed ingredient metadata retrieved successfully!",
    data: FeedIngredientServices.getIngredientMeta(),
  });
});

const getIngredientStats = catchAsync(async (_req: Request, res: Response) => {
  const stats = await FeedIngredientServices.getIngredientStats();
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Feed ingredient statistics retrieved successfully!",
    data: stats,
  });
});

const getIngredient = catchAsync(async (req: Request, res: Response) => {
  const ingredient = await FeedIngredientServices.getIngredient(req.params.id as string);
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Feed ingredient retrieved successfully!",
    data: ingredient,
  });
});

const getIngredientUsage = catchAsync(async (req: Request, res: Response) => {
  const usage = await FeedIngredientServices.getIngredientUsage(req.params.id as string);
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Feed ingredient usage retrieved successfully!",
    data: usage,
  });
});

const getIngredientAuditLogs = catchAsync(async (req: Request, res: Response) => {
  const { meta, logs } = await FeedIngredientServices.getIngredientAuditLogs(
    req.params.id as string,
    req.query as TBody,
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Feed ingredient history retrieved successfully!",
    meta,
    data: logs,
  });
});

const updateIngredient = catchAsync(async (req: Request, res: Response) => {
  const ingredient = await FeedIngredientServices.updateIngredient(
    req.params.id as string,
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Feed ingredient updated successfully!",
    data: ingredient,
  });
});

const updateAvailability = catchAsync(async (req: Request, res: Response) => {
  const ingredient = await FeedIngredientServices.updateAvailability(
    req.params.id as string,
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: ingredient.isAvailable
      ? "Feed ingredient marked as available!"
      : "Feed ingredient marked as unavailable!",
    data: ingredient,
  });
});

const toggleActive = catchAsync(async (req: Request, res: Response) => {
  const ingredient = await FeedIngredientServices.toggleActive(
    req.params.id as string,
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: ingredient.isActive
      ? "Feed ingredient activated successfully!"
      : "Feed ingredient retired from the catalog!",
    data: ingredient,
  });
});

const deleteIngredient = catchAsync(async (req: Request, res: Response) => {
  const result = await FeedIngredientServices.deleteIngredient(
    req.params.id as string,
    req.query as TBody,
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message:
      result.mode === "deleted"
        ? "Feed ingredient permanently deleted!"
        : "Feed ingredient retired (soft deleted) successfully!",
    data: result,
  });
});

export const FeedIngredientController = {
  createIngredient,
  getAllIngredients,
  getIngredientLookup,
  getIngredientMeta,
  getIngredientStats,
  getIngredient,
  getIngredientUsage,
  getIngredientAuditLogs,
  updateIngredient,
  updateAvailability,
  toggleActive,
  deleteIngredient,
};
