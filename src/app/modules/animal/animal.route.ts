import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import parseMultipartData from "../../middlewares/parseMultipartData.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { upload } from "../../utils/uploadImage.js";
import { AnimalController } from "./animal.controller.js";
import { animalValidations } from "./animal.validation.js";
import { MAX_GALLERY_UPLOAD } from "./animal.constants.js";

/**
 * Animal endpoints (Model 05) — nested under the farm router at /api/v1/farms/:farmId/animals
 *
 * POST   /                              Owner / Manager / Worker        register an animal (generates animalCode + qrCode)
 * GET    /                              Farm Member                     paginated herd list with filters + search
 * GET    /meta                          Farm Member                     enum values for forms/filters
 * GET    /stats                         Farm Member                     dashboard counts (life / health / reproductive / breed ...)
 * GET    /lookup/:identifier            Farm Member                     scanner lookup by animalCode / rfid / qrCode / tagNumber
 * GET    /:animalId                     Farm Member                     full profile + computed age
 * PUT    /:animalId                     Owner / Manager                 descriptive + acquisition metadata
 * PATCH  /:animalId/identification      Owner / Manager                 rfid / tagNumber / qrCode
 * PATCH  /:animalId/location            Owner / Manager / Worker        { shed, pen, stall }
 * PATCH  /:animalId/media               Owner / Manager / Worker        profilePhoto + gallery
 * PATCH  /:animalId/lifecycle           Owner / Manager                 lifeStatus transition (isActive synced)
 * PATCH  /:animalId/status              Owner / Manager / Veterinarian  healthStatus / reproductiveStatus
 * DELETE /:animalId                     Owner                           soft delete => Archived, isActive false
 *
 * `auth` only proves the caller is a logged-in platform user. Farm membership, the farm role,
 * farm status and data isolation (farmId) are enforced in animal.services.ts.
 * Financial fields (purchasePrice, supplierId) are hidden from Worker / Veterinarian.
 */
const animalRouter = express.Router({ mergeParams: true });

const authenticatedRoles = [
  SystemRoles.SUPER_ADMIN,
  SystemRoles.ADMIN,
  SystemRoles.USER,
];

//JSON, or multipart with a "profilePhoto" file and the payload as a JSON string in "data"
animalRouter.post(
  "/",
  auth(...authenticatedRoles),
  upload.single("profilePhoto"),
  parseMultipartData,
  validateRequest(animalValidations.createAnimalValidation),
  AnimalController.createAnimal,
);

animalRouter.get("/", auth(...authenticatedRoles), AnimalController.getFarmAnimals);

//static paths must stay above "/:animalId"
animalRouter.get("/meta", auth(...authenticatedRoles), AnimalController.getAnimalMeta);
animalRouter.get("/stats", auth(...authenticatedRoles), AnimalController.getAnimalStats);
animalRouter.get(
  "/lookup/:identifier",
  auth(...authenticatedRoles),
  AnimalController.lookupAnimal,
);

animalRouter.get("/:animalId", auth(...authenticatedRoles), AnimalController.getAnimalById);

animalRouter.put(
  "/:animalId",
  auth(...authenticatedRoles),
  validateRequest(animalValidations.updateAnimalValidation),
  AnimalController.updateAnimal,
);

animalRouter.patch(
  "/:animalId/identification",
  auth(...authenticatedRoles),
  validateRequest(animalValidations.updateIdentificationValidation),
  AnimalController.updateIdentification,
);

animalRouter.patch(
  "/:animalId/location",
  auth(...authenticatedRoles),
  validateRequest(animalValidations.updateLocationValidation),
  AnimalController.updateLocation,
);

//multipart: "profilePhoto" (1 file) and "gallery" (up to MAX_GALLERY_UPLOAD files) + JSON "data"
animalRouter.patch(
  "/:animalId/media",
  auth(...authenticatedRoles),
  upload.fields([
    { name: "profilePhoto", maxCount: 1 },
    { name: "gallery", maxCount: MAX_GALLERY_UPLOAD },
  ]),
  parseMultipartData,
  AnimalController.updateMedia,
);

animalRouter.patch(
  "/:animalId/lifecycle",
  auth(...authenticatedRoles),
  validateRequest(animalValidations.updateLifecycleValidation),
  AnimalController.updateLifecycle,
);

animalRouter.patch(
  "/:animalId/status",
  auth(...authenticatedRoles),
  validateRequest(animalValidations.updateStatusValidation),
  AnimalController.updateStatus,
);

animalRouter.delete("/:animalId", auth(...authenticatedRoles), AnimalController.archiveAnimal);

export { animalRouter };
