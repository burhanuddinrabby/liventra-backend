import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { WeightRecordController } from "./weightRecord.controller.js";
import { weightRecordValidations } from "./weightRecord.validation.js";

/**
 * WeightRecord endpoints (Model 11) — nested under /api/v1/farms/:farmId
 *
 * POST   /weight-records                         Owner / Manager / Worker   log one measurement (eligibility, unit normalization, ADG, currentWeight sync)
 * GET    /weight-records                         Farm Member                farm-wide logs + filters (animalId, method, date range, stale, measuredBy)
 * GET    /weight-records/growth-summary          Farm Member                farm / breed growth analytics, target vs actual ADG, overdue animals
 * GET    /weight-records/meta                    Farm Member                enums, limits, permissions, unit factors
 * GET    /weight-records/check                   Farm Member                dry-run entry check (previous weight, predicted ADG, currentWeight impact)
 * GET    /weight-records/recorders               Farm Member                active members selectable as measuredBy (name + role only)
 * GET    /weight-records/:id                     Farm Member                one entry with provenance, recorder and neighbours
 * GET    /weight-records/:id/audit-logs          Owner / Manager            create / correction / void history
 * PUT    /weight-records/:id                     Owner / Manager            controlled correction, ADG chain recalculation, AuditLog
 * DELETE /weight-records/:id                     Owner                      void (default) or hard delete of a duplicate, ADG + currentWeight re-sync
 * GET    /animals/:animalId/weight-records       Farm Member                chronological growth trajectory, kg weights, ADG progression
 *
 * `auth` only proves a logged-in platform user. Membership, farm role, farm status and
 * farm isolation are enforced in weightRecord.services.ts.
 * Route order matters: /growth-summary, /meta, /check, /recorders stay above /:id.
 */
const weightRecordRouter = express.Router({ mergeParams: true });
const animalWeightRecordRouter = express.Router({ mergeParams: true });

const authenticatedRoles = [SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER];

weightRecordRouter.post(
  "/",
  auth(...authenticatedRoles),
  validateRequest(weightRecordValidations.createValidation),
  WeightRecordController.createWeightRecord,
);

weightRecordRouter.get("/", auth(...authenticatedRoles), WeightRecordController.getFarmWeightRecords);
weightRecordRouter.get("/growth-summary", auth(...authenticatedRoles), WeightRecordController.getGrowthSummary);
weightRecordRouter.get("/meta", auth(...authenticatedRoles), WeightRecordController.getMeta);
weightRecordRouter.get("/check", auth(...authenticatedRoles), WeightRecordController.checkWeightEntry);
weightRecordRouter.get("/recorders", auth(...authenticatedRoles), WeightRecordController.getRecorders);
weightRecordRouter.get("/:id", auth(...authenticatedRoles), WeightRecordController.getWeightRecord);
weightRecordRouter.get("/:id/audit-logs", auth(...authenticatedRoles), WeightRecordController.getAuditLogs);

weightRecordRouter.put(
  "/:id",
  auth(...authenticatedRoles),
  validateRequest(weightRecordValidations.updateValidation),
  WeightRecordController.updateWeightRecord,
);
weightRecordRouter.delete(
  "/:id",
  auth(...authenticatedRoles),
  validateRequest(weightRecordValidations.deleteValidation),
  WeightRecordController.deleteWeightRecord,
);

// mounted at /farms/:farmId/animals/:animalId/weight-records
animalWeightRecordRouter.get("/", auth(...authenticatedRoles), WeightRecordController.getAnimalWeightRecords);

export { weightRecordRouter, animalWeightRecordRouter };
