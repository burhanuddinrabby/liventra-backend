import express, { type NextFunction, type Request, type Response } from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { FarmController } from "./farm.controller.js";
import { farmValidations } from "./farm.validations.js";
import { upload } from "../../utils/uploadImage.js";

const farmRouter = express.Router();
const authenticatedRoles = [
  SystemRoles.SUPER_ADMIN,
  SystemRoles.ADMIN,
  SystemRoles.USER,
];

// POST /api/v1/farms
farmRouter.post(
  "/",
  auth(...authenticatedRoles),
  upload.single("logo"), (req: Request, res: Response, next: NextFunction) => {
    req.body = JSON.parse(req?.body?.data);
    next();
  },
  validateRequest(farmValidations.createFarmValidation),
  FarmController.createFarm,
);
// GET /api/v1/farms — platform administrators only: all registered farms, paginated
farmRouter.get(
  "/",
  auth(SystemRoles.ADMIN, SystemRoles.SUPER_ADMIN),
  FarmController.getAllFarms,
);

// GET /api/v1/farms/my-farms — currently returns farms owned by the authenticated user
farmRouter.get("/my-farms", auth(...authenticatedRoles), FarmController.getMyFarms);

// GET /api/v1/farms/:farmId — only a member of the targeted farm (currently the owner)
farmRouter.get(
  "/:farmId",
  auth(...authenticatedRoles),
  FarmController.getFarmById,
);

// PUT /api/v1/farms/:farmId — only a member of the targeted farm (currently the owner)
farmRouter.put(
  "/:farmId",
  auth(...authenticatedRoles),
  validateRequest(farmValidations.updateFarmValidation),
  FarmController.updateFarm,
);

// PATCH /api/v1/farms/:farmId/logo — multipart "logo" file and/or a logo URL in the body
farmRouter.patch(
  "/:farmId/logo",
  auth(...authenticatedRoles),
  upload.single("logo"),
  validateRequest(farmValidations.updateFarmLogoValidation),
  FarmController.updateFarmLogo,
);

// PATCH /api/v1/farms/:farmId/status — platform administrators only
farmRouter.patch(
  "/:farmId/status",
  auth(SystemRoles.ADMIN, SystemRoles.SUPER_ADMIN),
  validateRequest(farmValidations.statusValidation),
  FarmController.updateFarmStatus,
);

// POST /api/v1/farms/:farmId/transfer-ownership — farm owner or super admin only
farmRouter.post(
  "/:farmId/transfer-ownership",
  auth(...authenticatedRoles),
  validateRequest(farmValidations.transferOwnershipValidation),
  FarmController.transferFarmOwnership,
);
/* 

// PATCH /api/v1/farms/:id/deactivate
farmRouter.patch(
  "/:id/deactivate",
  auth(...authenticatedRoles),
  FarmController.deactivateFarm,
);

// PATCH /api/v1/farms/:id/reactivate
farmRouter.patch(
  "/:id/reactivate",
  auth(...authenticatedRoles),
  FarmController.reactivateFarm,
); */

export { farmRouter };


/*

PATCH   /api/v1/farms/:farmId/logo   Owner/Manager    Uploads or updates the farm logo URL used in UI dashboards and exported PDF reports.

GET    /api/v1/farms   Admin / SuperAdmin    System admin endpoint to query/list all registered farms across the platform with pagination.

PATCH   /api/v1/farms/:farmId/status   Admin / SuperAdmin    Updates administrative status (Active, Inactive, Suspended).

POST    /api/v1/farms/:farmId/transfer-ownership   Owner / SuperAdmin    Reassigns ownerId and synchronizes the corresponding FarmMember roles.

*/