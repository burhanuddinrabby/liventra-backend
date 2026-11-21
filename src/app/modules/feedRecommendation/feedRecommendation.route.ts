import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { FeedRecommendationController } from "./feedRecommendation.controller.js";
import { feedRecommendationValidations } from "./feedRecommendation.validation.js";

/**
 * FeedRecommendation endpoints (Model 08) — nested under /api/v1/farms/:farmId
 *
 * POST   /feed-recommendations/preview          Owner / Manager / Worker / Vet  live unsaved recommendation
 * POST   /feed-recommendations                  Owner / Manager                 official snapshot (REC-YYYY-NNNNNN), supersedes the previous plan
 * GET    /feed-recommendations                  Farm Member                     list + filters (animalId, status, ruleVersion, formulaId, season, stage, from/to)
 * GET    /feed-recommendations/meta             Farm Member                     enums, transitions, rule factors
 * GET    /feed-recommendations/stats            Farm Member                     counts by status / rule version, active-plan cost
 * GET    /feed-recommendations/:id              Farm Member                     one snapshot by _id or recommendationNo
 * GET    /feed-recommendations/:id/audit-logs   Owner / Manager / Vet           status + review history
 * PATCH  /feed-recommendations/:id/status       Owner / Manager                 Draft → Confirmed | Rejected, Confirmed → Rejected
 * PATCH  /feed-recommendations/:id/review       Owner / Manager / Vet           Confirmed → Expert Approved | Rejected
 * DELETE /feed-recommendations/:id              Owner                           Draft only
 * GET    /animals/:animalId/feed-recommendations Farm Member                    animal timeline + active plan
 *
 * `auth` only proves a logged-in platform user. Membership, farm role, farm status and
 * farm isolation are enforced in feedRecommendation.services.ts.
 * Route order matters: /preview, /meta, /stats must stay above /:id.
 */
const feedRecommendationRouter = express.Router({ mergeParams: true });
const animalFeedRecommendationRouter = express.Router({ mergeParams: true });

const authenticatedRoles = [SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER];

feedRecommendationRouter.post(
  "/preview",
  auth(...authenticatedRoles),
  validateRequest(feedRecommendationValidations.previewValidation),
  FeedRecommendationController.previewRecommendation,
);

feedRecommendationRouter.post(
  "/",
  auth(...authenticatedRoles),
  validateRequest(feedRecommendationValidations.createValidation),
  FeedRecommendationController.createRecommendation,
);

feedRecommendationRouter.get("/", auth(...authenticatedRoles), FeedRecommendationController.getFarmRecommendations);
feedRecommendationRouter.get("/meta", auth(...authenticatedRoles), FeedRecommendationController.getMeta);
feedRecommendationRouter.get("/stats", auth(...authenticatedRoles), FeedRecommendationController.getStats);
feedRecommendationRouter.get("/:id", auth(...authenticatedRoles), FeedRecommendationController.getRecommendation);
feedRecommendationRouter.get(
  "/:id/audit-logs",
  auth(...authenticatedRoles),
  FeedRecommendationController.getAuditLogs,
);

feedRecommendationRouter.patch(
  "/:id/status",
  auth(...authenticatedRoles),
  validateRequest(feedRecommendationValidations.statusValidation),
  FeedRecommendationController.updateStatus,
);

feedRecommendationRouter.patch(
  "/:id/review",
  auth(...authenticatedRoles),
  validateRequest(feedRecommendationValidations.reviewValidation),
  FeedRecommendationController.reviewRecommendation,
);

feedRecommendationRouter.delete("/:id", auth(...authenticatedRoles), FeedRecommendationController.deleteRecommendation);

// mounted at /farms/:farmId/animals/:animalId/feed-recommendations
animalFeedRecommendationRouter.get(
  "/",
  auth(...authenticatedRoles),
  FeedRecommendationController.getAnimalRecommendations,
);

export { feedRecommendationRouter, animalFeedRecommendationRouter };
