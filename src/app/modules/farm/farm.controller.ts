import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { FarmServices } from "./farm.services.js";

const createFarm = catchAsync(async (req: Request, res: Response) => {
  const farm = await FarmServices.createFarm(req.user.userId, req?.file, req.body);
  sendResponse(res, {
    statusCode: status.CREATED,
    success: true,
    message: "Farm created successfully!",
    data: farm,
  });
});

const getMyFarms = catchAsync(async (req: Request, res: Response) => {
  const { meta, farms } = await FarmServices.getMyFarms(
    req.user.userId,
    req.query as Record<string, unknown>,
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Farms retrieved successfully!",
    meta,
    data: farms,
  });
});
/* 

const getFarmById = catchAsync(async (req: Request, res: Response) => {
const isAdmin = req.user.role === "admin" || req.user.role === "superAdmin";
const farm = await FarmServices.getFarmById(
req.params.id as string,
isAdmin ? undefined : req.user.userId,
);
sendResponse(res, {
statusCode: status.OK,
success: true,
message: "Farm retrieved successfully!",
data: farm,
});
});

const updateFarm = catchAsync(async (req: Request, res: Response) => {
const farm = await FarmServices.updateFarm(
req.params.id as string,
req.user.userId,
req.body,
);
sendResponse(res, {
statusCode: status.OK,
success: true,
message: "Farm updated successfully!",
data: farm,
});
});

const deactivateFarm = catchAsync(async (req: Request, res: Response) => {
const farm = await FarmServices.updateFarmStatus(
req.params.id as string,
FarmStatuses.INACTIVE,
req.user.userId,
);
sendResponse(res, {
statusCode: status.OK,
success: true,
message: "Farm deactivated successfully!",
data: farm,
});
});

const reactivateFarm = catchAsync(async (req: Request, res: Response) => {
const farm = await FarmServices.updateFarmStatus(
req.params.id as string,
FarmStatuses.ACTIVE,
req.user.userId,
);
sendResponse(res, {
statusCode: status.OK,
success: true,
message: "Farm reactivated successfully!",
data: farm,
});
});

const updateFarmStatus = catchAsync(async (req: Request, res: Response) => {
const farm = await FarmServices.updateFarmStatus(
req.params.id as string,
req.body.status,
);
sendResponse(res, {
statusCode: status.OK,
success: true,
message: "Farm status updated successfully!",
data: farm,
});
}); */

export const FarmController = {
  createFarm,
  getMyFarms,
  /* 
  getFarmById,
  updateFarm,
  deactivateFarm,
  reactivateFarm,
  updateFarmStatus, */
};
