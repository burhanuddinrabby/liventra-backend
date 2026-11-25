import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import { AnimalServices } from "./animal.services.js";

//farm-level authorization happens in the service; the controller only maps HTTP <-> service
const farmIdOf = (req: Request) => req.params.farmId as string;
const animalIdOf = (req: Request) => req.params.animalId as string;
const requesterOf = (req: Request) => req.user.userId as string;
const bodyOf = (req: Request) => (req.body ?? {}) as Record<string, unknown>;

const createAnimal = catchAsync(async (req: Request, res: Response) => {
  const animal = await AnimalServices.createAnimal(
    farmIdOf(req),
    requesterOf(req),
    bodyOf(req),
    req.file,
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.CREATED,
    success: true,
    message: "Animal registered successfully!",
    data: animal,
  });
});

const getFarmAnimals = catchAsync(async (req: Request, res: Response) => {
  const { meta, animals } = await AnimalServices.getFarmAnimals(
    farmIdOf(req),
    requesterOf(req),
    req.query as Record<string, unknown>,
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Animals retrieved successfully!",
    meta,
    data: animals,
  });
});

const getAnimalMeta = catchAsync(async (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Animal metadata retrieved successfully!",
    data: AnimalServices.getAnimalMeta(),
  });
});

const getAnimalStats = catchAsync(async (req: Request, res: Response) => {
  const stats = await AnimalServices.getAnimalStats(farmIdOf(req), requesterOf(req));
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Animal statistics retrieved successfully!",
    data: stats,
  });
});

const getAnimalById = catchAsync(async (req: Request, res: Response) => {
  const animal = await AnimalServices.getAnimalById(
    farmIdOf(req),
    requesterOf(req),
    animalIdOf(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Animal retrieved successfully!",
    data: animal,
  });
});

const lookupAnimal = catchAsync(async (req: Request, res: Response) => {
  const result = await AnimalServices.lookupAnimal(
    farmIdOf(req),
    requesterOf(req),
    req.params.identifier as string,
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: `Animal found by ${result.matchedBy}!`,
    data: result,
  });
});

//shared shape for the PUT/PATCH handlers that take (farmId, user, animalId, body)
type TAnimalUpdateService = typeof AnimalServices.updateAnimal;

const makeUpdateHandler = (service: TAnimalUpdateService, message: string) =>
  catchAsync(async (req: Request, res: Response) => {
    const animal = await service(farmIdOf(req), requesterOf(req), animalIdOf(req), bodyOf(req), auditContextFromRequest(req));
    sendResponse(res, { statusCode: status.OK, success: true, message, data: animal });
  });

const updateAnimal = makeUpdateHandler(
  AnimalServices.updateAnimal,
  "Animal profile updated successfully!",
);
const updateIdentification = makeUpdateHandler(
  AnimalServices.updateIdentification,
  "Animal identification updated successfully!",
);
const updateLocation = makeUpdateHandler(
  AnimalServices.updateLocation,
  "Animal location updated successfully!",
);
const updateLifecycle = makeUpdateHandler(
  AnimalServices.updateLifecycle,
  "Animal life status updated successfully!",
);
const updateStatus = makeUpdateHandler(
  AnimalServices.updateStatus,
  "Animal status updated successfully!",
);

const updateMedia = catchAsync(async (req: Request, res: Response) => {
  const animal = await AnimalServices.updateMedia(
    farmIdOf(req),
    requesterOf(req),
    animalIdOf(req),
    bodyOf(req),
    (req.files ?? {}) as {
      profilePhoto?: Express.Multer.File[];
      gallery?: Express.Multer.File[];
    },
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Animal media updated successfully!",
    data: animal,
  });
});

const archiveAnimal = catchAsync(async (req: Request, res: Response) => {
  const animal = await AnimalServices.archiveAnimal(
    farmIdOf(req),
    requesterOf(req),
    animalIdOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Animal archived successfully!",
    data: animal,
  });
});

export const AnimalController = {
  createAnimal,
  getFarmAnimals,
  getAnimalMeta,
  getAnimalStats,
  getAnimalById,
  lookupAnimal,
  updateAnimal,
  updateIdentification,
  updateLocation,
  updateMedia,
  updateLifecycle,
  updateStatus,
  archiveAnimal,
};
