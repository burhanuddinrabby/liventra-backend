import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { BreedServices } from "./breed.services.js";

const isPlatformAdmin = (role?: string): boolean =>
  role === SystemRoles.ADMIN || role === SystemRoles.SUPER_ADMIN;

const createBreed = catchAsync(async (req: Request, res: Response) => {
  const breed = await BreedServices.createBreed(
    req.body as Record<string, unknown>,
    req.file,
  );
  sendResponse(res, {
    statusCode: status.CREATED,
    success: true,
    message: "Breed created successfully!",
    data: breed,
  });
});

const getAllBreeds = catchAsync(async (req: Request, res: Response) => {
  const { meta, breeds } = await BreedServices.getAllBreeds(
    req.query as Record<string, unknown>,
    isPlatformAdmin(req.user.role),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Breeds retrieved successfully!",
    meta,
    data: breeds,
  });
});

const getBreedLookup = catchAsync(async (req: Request, res: Response) => {
  const breeds = await BreedServices.getBreedLookup(
    req.query as Record<string, unknown>,
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Breed lookup retrieved successfully!",
    data: breeds,
  });
});

const getBreedMeta = catchAsync(async (_req: Request, res: Response) => {
  const meta = BreedServices.getBreedMeta();
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Breed metadata retrieved successfully!",
    data: meta,
  });
});

const getBreedStats = catchAsync(async (_req: Request, res: Response) => {
  const stats = await BreedServices.getBreedStats();
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Breed statistics retrieved successfully!",
    data: stats,
  });
});

const getBreedById = catchAsync(async (req: Request, res: Response) => {
  const breed = await BreedServices.getBreedById(req.params.id as string);
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Breed retrieved successfully!",
    data: breed,
  });
});

const getBreedByCode = catchAsync(async (req: Request, res: Response) => {
  const breed = await BreedServices.getBreedByCode(
    req.params.breedCode as string,
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Breed retrieved successfully!",
    data: breed,
  });
});

const updateBreed = catchAsync(async (req: Request, res: Response) => {
  const breed = await BreedServices.updateBreed(
    req.params.id as string,
    req.body as Record<string, unknown>,
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Breed updated successfully!",
    data: breed,
  });
});

const updateBreedImage = catchAsync(async (req: Request, res: Response) => {
  const breed = await BreedServices.updateBreedImage(
    req.params.id as string,
    req.file,
    req.body?.image as string | undefined,
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Breed image updated successfully!",
    data: breed,
  });
});

const updateBreedStatus = catchAsync(async (req: Request, res: Response) => {
  const isActive = req.body.isActive as boolean;
  const breed = await BreedServices.updateBreedStatus(
    req.params.id as string,
    isActive,
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: isActive
      ? "Breed activated successfully!"
      : "Breed deactivated successfully!",
    data: breed,
  });
});

export const BreedController = {
  createBreed,
  getAllBreeds,
  getBreedLookup,
  getBreedMeta,
  getBreedStats,
  getBreedById,
  getBreedByCode,
  updateBreed,
  updateBreedImage,
  updateBreedStatus,
};
