import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { DeviceAssignmentController } from "./deviceAssignment.controller.js";
import { deviceAssignmentValidations as v } from "./deviceAssignment.validation.js";

const member = auth(SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER);
const C = DeviceAssignmentController;

/**
 * /api/v1/farms/:farmId/device-assignments — farm access and roles are enforced in the service.
 * Read: Owner / Manager / Veterinarian / Worker. Write and pickers: Owner / Manager. DELETE: always 403.
 */
const deviceAssignmentRouter = express.Router({ mergeParams: true });

deviceAssignmentRouter.post("/", member, validateRequest(v.assignValidation), C.assign);
deviceAssignmentRouter.get("/", member, C.getAssignments);
//literal routes stay above /:id
deviceAssignmentRouter.get("/meta", member, C.getMeta);
deviceAssignmentRouter.get("/eligible-devices", member, C.getEligibleDevices);
deviceAssignmentRouter.get("/eligible-animals", member, C.getEligibleAnimals);
deviceAssignmentRouter.get("/:id", member, C.getAssignment);
deviceAssignmentRouter.post("/:id/reassign", member, validateRequest(v.reassignValidation), C.reassign);
deviceAssignmentRouter.post("/:id/replace", member, validateRequest(v.replaceValidation), C.replace);
deviceAssignmentRouter.patch("/:id/remove", member, validateRequest(v.removeValidation), C.remove);
deviceAssignmentRouter.patch("/:id/cancel", member, validateRequest(v.cancelValidation), C.cancel);
deviceAssignmentRouter.patch("/:id/remarks", member, validateRequest(v.remarksValidation), C.updateRemarks);
deviceAssignmentRouter.delete("/:id", member, C.deleteAssignment);

/** /api/v1/farms/:farmId/animals/:animalId/devices — mounted before the animal router. */
const animalDeviceRouter = express.Router({ mergeParams: true });
animalDeviceRouter.get("/", member, C.getAnimalDevices);

export { animalDeviceRouter, deviceAssignmentRouter };
