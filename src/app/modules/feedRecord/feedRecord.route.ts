import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { FeedRecordController } from "./feedRecord.controller.js";
import { feedRecordValidations } from "./feedRecord.validation.js";

/**
 * FeedRecord endpoints (Model 09) — nested under /api/v1/farms/:farmId
 *
 * POST   /feed-records/preview                       Owner / Manager / Worker   validate + price + stock check, nothing saved
 * POST   /feed-records                               Owner / Manager / Worker   log a feeding, atomically deduct stock
 * GET    /feed-records                               Farm Member                list + filters (animalId, feedingSession, recommendationId, fedBy, ingredientId, from/to)
 * GET    /feed-records/meta                          Farm Member                sessions, units, permissions, limits
 * GET    /feed-records/stats                         Farm Member                totals, sessions, top ingredients, daily trend
 * GET    /feed-records/feeders                       Farm Member                active members selectable as fedBy (name + role only)
 * GET    /feed-records/adherence/:recommendationId   Farm Member                recommended vs actual variance
 * GET    /feed-records/:id                           Farm Member                one feeding with linked plan + stock ledger
 * GET    /feed-records/:id/audit-logs                Owner / Manager            create / correction / void history
 * PUT    /feed-records/:id                           Owner / Manager            controlled correction, net stock reconciliation
 * DELETE /feed-records/:id                           Owner                      void + restore stock (never a silent delete)
 * GET    /animals/:animalId/feed-records             Farm Member                animal history + daily summaries
 *
 * `auth` only proves a logged-in platform user. Membership, farm role, farm status and
 * farm isolation are enforced in feedRecord.services.ts.
 * Route order matters: /preview, /meta, /stats, /feeders, /adherence stay above /:id.
 */
const feedRecordRouter = express.Router({ mergeParams: true });
const animalFeedRecordRouter = express.Router({ mergeParams: true });

const authenticatedRoles = [SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER];

feedRecordRouter.post(
  "/preview",
  auth(...authenticatedRoles),
  validateRequest(feedRecordValidations.previewValidation),
  FeedRecordController.previewFeedRecord,
);

feedRecordRouter.post(
  "/",
  auth(...authenticatedRoles),
  validateRequest(feedRecordValidations.createValidation),
  FeedRecordController.createFeedRecord,
);

feedRecordRouter.get("/", auth(...authenticatedRoles), FeedRecordController.getFarmFeedRecords);
feedRecordRouter.get("/meta", auth(...authenticatedRoles), FeedRecordController.getMeta);
feedRecordRouter.get("/stats", auth(...authenticatedRoles), FeedRecordController.getStats);
feedRecordRouter.get("/feeders", auth(...authenticatedRoles), FeedRecordController.getFeeders);
feedRecordRouter.get(
  "/adherence/:recommendationId",
  auth(...authenticatedRoles),
  FeedRecordController.getAdherence,
);
feedRecordRouter.get("/:id", auth(...authenticatedRoles), FeedRecordController.getFeedRecord);
feedRecordRouter.get("/:id/audit-logs", auth(...authenticatedRoles), FeedRecordController.getAuditLogs);

feedRecordRouter.put(
  "/:id",
  auth(...authenticatedRoles),
  validateRequest(feedRecordValidations.updateValidation),
  FeedRecordController.updateFeedRecord,
);

feedRecordRouter.delete(
  "/:id",
  auth(...authenticatedRoles),
  validateRequest(feedRecordValidations.voidValidation),
  FeedRecordController.voidFeedRecord,
);

// mounted at /farms/:farmId/animals/:animalId/feed-records
animalFeedRecordRouter.get("/", auth(...authenticatedRoles), FeedRecordController.getAnimalFeedRecords);

export { feedRecordRouter, animalFeedRecordRouter };
