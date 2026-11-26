import express from "express";
import auth from "../../middlewares/auth.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { SensorDataController as C } from "./sensorData.controller.js";
import { uploadCsv } from "./sensorData.csv.js";

const member = auth(SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER);

/**
 * /api/v1/farms/:farmId/sensor-data — farm access and roles are enforced in the service.
 * Readings are evidence: there is no PUT, PATCH or DELETE.
 */
const sensorDataRouter = express.Router({ mergeParams: true });

sensorDataRouter.post("/", member, C.createReading);
sensorDataRouter.post("/import/preview", member, uploadCsv, C.previewImport);
sensorDataRouter.post("/import", member, uploadCsv, C.importReadings);
//literal routes stay above /:id
sensorDataRouter.get("/import/template", member, C.getTemplate);
sensorDataRouter.get("/", member, C.getReadings);
sensorDataRouter.get("/trends", member, C.getTrends);
sensorDataRouter.get("/latest", member, C.getLatest);
sensorDataRouter.get("/dashboard", member, C.getDashboard);
sensorDataRouter.get("/alerts", member, C.getAlerts);
sensorDataRouter.get("/meta", member, C.getMeta);
sensorDataRouter.get("/:id", member, C.getReading);

export { sensorDataRouter };
