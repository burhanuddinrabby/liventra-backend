import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { upload } from "../../utils/uploadImage.js";
import { BreedController } from "./breed.controller.js";
import { breedValidations } from "./breed.validations.js";

const breedRouter = express.Router();
const authenticatedRoles = [
  SystemRoles.SUPER_ADMIN,
  SystemRoles.ADMIN,
  SystemRoles.USER,
];

// POST /api/v1/breeds — platform administrators only
breedRouter.post(
  "/",
  auth(SystemRoles.ADMIN, SystemRoles.SUPER_ADMIN),
  validateRequest(breedValidations.createBreedValidation),
  BreedController.createBreed,
);

// GET /api/v1/breeds — active breeds by default; admins may pass isActive=false|all
breedRouter.get(
  "/",
  auth(...authenticatedRoles),
  BreedController.getAllBreeds,
);

// GET /api/v1/breeds/lookup — slim select list for animal registration
breedRouter.get(
  "/lookup",
  auth(...authenticatedRoles),
  BreedController.getBreedLookup,
);

// GET /api/v1/breeds/meta — enum values for frontend forms/filters
breedRouter.get(
  "/meta",
  auth(...authenticatedRoles),
  BreedController.getBreedMeta,
);

// GET /api/v1/breeds/stats — distribution across the breed master list
breedRouter.get(
  "/stats",
  auth(...authenticatedRoles),
  BreedController.getBreedStats,
);

// GET /api/v1/breeds/code/:breedCode — lookup by public breed code
breedRouter.get(
  "/code/:breedCode",
  auth(...authenticatedRoles),
  BreedController.getBreedByCode,
);

// GET /api/v1/breeds/:id — single breed by ObjectId (active or inactive)
breedRouter.get(
  "/:id",
  auth(...authenticatedRoles),
  BreedController.getBreedById,
);

// PATCH /api/v1/breeds/:id — platform administrators only
breedRouter.patch(
  "/:id",
  auth(SystemRoles.ADMIN, SystemRoles.SUPER_ADMIN),
  validateRequest(breedValidations.updateBreedValidation),
  BreedController.updateBreed,
);

// PATCH /api/v1/breeds/:id/image — multipart "image" file and/or an image URL in the body
breedRouter.patch(
  "/:id/image",
  auth(SystemRoles.ADMIN, SystemRoles.SUPER_ADMIN),
  upload.single("image"),
  BreedController.updateBreedImage,
);

// PATCH /api/v1/breeds/:id/status — activate or deactivate (no hard delete)
breedRouter.patch(
  "/:id/status",
  auth(SystemRoles.ADMIN, SystemRoles.SUPER_ADMIN),
  validateRequest(breedValidations.breedStatusValidation),
  BreedController.updateBreedStatus,
);

export { breedRouter };
