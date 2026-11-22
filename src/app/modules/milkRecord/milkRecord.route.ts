import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { MilkRecordController } from "./milkRecord.controller.js";
import { milkRecordValidations } from "./milkRecord.validation.js";

/**
 * MilkRecord endpoints (Model 10) — nested under /api/v1/farms/:farmId
 *
 * POST   /milk-records                     Owner / Manager / Worker   log one milking session (eligibility + withdrawal check, unit normalization)
 * POST   /milk-records/bulk                Owner / Manager / Worker   one session for many animals (per-entry results, dryRun)
 * GET    /milk-records                     Farm Member                list + filters (animalId, milkingSession, milkingMethod, quality, recordedBy, withdrawal, from/to)
 * GET    /milk-records/summary             Farm Member                daily / weekly / monthly totals, session + quality breakdown, top producers
 * GET    /milk-records/meta                Farm Member                enums, limits, permissions
 * GET    /milk-records/check               Farm Member                dry-run eligibility for the entry form (status, lactation, withdrawal, duplicate)
 * GET    /milk-records/recorders           Farm Member                active members selectable as recordedBy (name + role only)
 * GET    /milk-records/:id                 Farm Member                one record with animal + recorder
 * GET    /milk-records/:id/audit-logs      Owner / Manager            create / correction / grade / void history
 * PUT    /milk-records/:id                 Owner / Manager            controlled correction, server recalculation, AuditLog
 * PATCH  /milk-records/:id/quality         Owner / Manager            quick re-grade (e.g. mark "Rejected")
 * DELETE /milk-records/:id                 Owner                      void (default) or hard delete of a duplicate, AuditLog
 * GET    /animals/:animalId/milk-records   Farm Member                animal history, daily totals, session averages, quality trend
 *
 * `auth` only proves a logged-in platform user. Membership, farm role, farm status and
 * farm isolation are enforced in milkRecord.services.ts.
 * Route order matters: /bulk, /summary, /meta, /check, /recorders stay above /:id.
 */
const milkRecordRouter = express.Router({ mergeParams: true });
const animalMilkRecordRouter = express.Router({ mergeParams: true });

const authenticatedRoles = [SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER];

milkRecordRouter.post(
  "/",
  auth(...authenticatedRoles),
  validateRequest(milkRecordValidations.createValidation),
  MilkRecordController.createMilkRecord,
);
milkRecordRouter.post(
  "/bulk",
  auth(...authenticatedRoles),
  validateRequest(milkRecordValidations.bulkValidation),
  MilkRecordController.bulkCreateMilkRecords,
);

milkRecordRouter.get("/", auth(...authenticatedRoles), MilkRecordController.getFarmMilkRecords);
milkRecordRouter.get("/summary", auth(...authenticatedRoles), MilkRecordController.getSummary);
milkRecordRouter.get("/meta", auth(...authenticatedRoles), MilkRecordController.getMeta);
milkRecordRouter.get("/check", auth(...authenticatedRoles), MilkRecordController.checkEligibility);
milkRecordRouter.get("/recorders", auth(...authenticatedRoles), MilkRecordController.getRecorders);
milkRecordRouter.get("/:id", auth(...authenticatedRoles), MilkRecordController.getMilkRecord);
milkRecordRouter.get("/:id/audit-logs", auth(...authenticatedRoles), MilkRecordController.getAuditLogs);

milkRecordRouter.put(
  "/:id",
  auth(...authenticatedRoles),
  validateRequest(milkRecordValidations.updateValidation),
  MilkRecordController.updateMilkRecord,
);
milkRecordRouter.patch(
  "/:id/quality",
  auth(...authenticatedRoles),
  validateRequest(milkRecordValidations.qualityValidation),
  MilkRecordController.updateMilkQuality,
);
milkRecordRouter.delete(
  "/:id",
  auth(...authenticatedRoles),
  validateRequest(milkRecordValidations.deleteValidation),
  MilkRecordController.deleteMilkRecord,
);

// mounted at /farms/:farmId/animals/:animalId/milk-records
animalMilkRecordRouter.get("/", auth(...authenticatedRoles), MilkRecordController.getAnimalMilkRecords);

export { milkRecordRouter, animalMilkRecordRouter };
