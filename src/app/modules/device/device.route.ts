import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { DeviceController } from "./device.controller.js";
import { deviceValidations } from "./device.validation.js";

const member = auth(SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER);

/** /api/v1/farms/:farmId/devices — farm access and roles are enforced in the service. */
const deviceRouter = express.Router({ mergeParams: true });

deviceRouter.post("/", member, validateRequest(deviceValidations.createValidation), DeviceController.createDevice);
deviceRouter.get("/", member, DeviceController.getDevices);
//literal routes stay above /:id
deviceRouter.get("/dashboard", member, DeviceController.getDashboard);
deviceRouter.get("/meta", member, DeviceController.getMeta);
deviceRouter.get("/lookup", member, DeviceController.lookup);
deviceRouter.get("/:id", member, DeviceController.getDevice);
deviceRouter.get("/:id/audit-logs", member, DeviceController.getAuditLogs);
deviceRouter.put("/:id", member, validateRequest(deviceValidations.updateValidation), DeviceController.updateDevice);
deviceRouter.patch("/:id/status", member, validateRequest(deviceValidations.statusValidation), DeviceController.changeStatus);
deviceRouter.patch(
  "/:id/deactivate",
  member,
  validateRequest(deviceValidations.deactivateValidation),
  DeviceController.deactivate,
);
deviceRouter.patch("/:id/reactivate", member, DeviceController.reactivate);
deviceRouter.delete("/:id", member, DeviceController.deleteDevice);

export { deviceRouter };
