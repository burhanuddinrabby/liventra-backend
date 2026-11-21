import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { FeedFormulaController } from "./feedFormula.controller.js";
import { feedFormulaValidations } from "./feedFormula.validation.js";

/**
 * /api/v1/feed-formulas — global feeding blueprints (Model 07), not farm-scoped.
 * Reads: any signed-in user (inactive history: admins only, enforced in the service).
 * Writes: platform admin / superAdmin.
 * Match: farm members (membership checked in the service) and admins.
 *
 * Route order matters: /lookup, /meta, /stats, /preview, /match must stay above /:id.
 * `:id` accepts a Mongo _id or a formulaCode (FF-000001).
 */
const feedFormulaRouter = express.Router();

const authenticatedRoles = [SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER];
const adminRoles = [SystemRoles.ADMIN, SystemRoles.SUPER_ADMIN];

// POST /feed-formulas — create a formula; nutrition + cost calculated server-side
feedFormulaRouter.post(
  "/",
  auth(...adminRoles),
  validateRequest(feedFormulaValidations.createFeedFormulaValidation),
  FeedFormulaController.createFormula,
);

// GET /feed-formulas — paginated list; filters breedId, stage, purpose, season, isDefault,
// isActive (admins: false|all), ruleVersion, ingredientId, minCost/maxCost, searchTerm
feedFormulaRouter.get("/", auth(...authenticatedRoles), FeedFormulaController.getAllFormulas);

// GET /feed-formulas/lookup — slim active list for selectors
feedFormulaRouter.get("/lookup", auth(...authenticatedRoles), FeedFormulaController.getFormulaLookup);

// GET /feed-formulas/meta — enums, units, formulation basis for forms/filters
feedFormulaRouter.get("/meta", auth(...authenticatedRoles), FeedFormulaController.getFormulaMeta);

// GET /feed-formulas/stats — counts by status / stage / purpose / season
feedFormulaRouter.get("/stats", auth(...authenticatedRoles), FeedFormulaController.getFormulaStats);

// POST /feed-formulas/preview — dry-run nutrition/cost calculation for the formula builder
feedFormulaRouter.post(
  "/preview",
  auth(...adminRoles),
  validateRequest(feedFormulaValidations.previewValidation),
  FeedFormulaController.previewComposition,
);

// POST /feed-formulas/match — ranked active formulas for an animal context
feedFormulaRouter.post(
  "/match",
  auth(...authenticatedRoles),
  validateRequest(feedFormulaValidations.matchValidation),
  FeedFormulaController.matchFormulas,
);

// GET /feed-formulas/:id — full specification with populated ingredients and current cost
feedFormulaRouter.get("/:id", auth(...authenticatedRoles), FeedFormulaController.getFormula);

// GET /feed-formulas/:id/versions — every formula sharing the exact context, newest rule first
feedFormulaRouter.get("/:id/versions", auth(...authenticatedRoles), FeedFormulaController.getFormulaVersions);

// GET /feed-formulas/:id/usage — FeedRecommendation reference count (admins)
feedFormulaRouter.get("/:id/usage", auth(...adminRoles), FeedFormulaController.getFormulaUsage);

// GET /feed-formulas/:id/audit-logs — change history (admins)
feedFormulaRouter.get("/:id/audit-logs", auth(...adminRoles), FeedFormulaController.getFormulaAuditLogs);

// PUT /feed-formulas/:id — metadata in place; scientific changes may create a new version
feedFormulaRouter.put(
  "/:id",
  auth(...adminRoles),
  validateRequest(feedFormulaValidations.updateFeedFormulaValidation),
  FeedFormulaController.updateFormula,
);

// POST /feed-formulas/:id/clone-version — new record + ruleVersion for traceability
feedFormulaRouter.post(
  "/:id/clone-version",
  auth(...adminRoles),
  validateRequest(feedFormulaValidations.cloneVersionValidation),
  FeedFormulaController.cloneVersion,
);

// PATCH /feed-formulas/:id/set-default — one active default per exact context
feedFormulaRouter.patch(
  "/:id/set-default",
  auth(...adminRoles),
  validateRequest(feedFormulaValidations.setDefaultValidation),
  FeedFormulaController.setDefault,
);

// PATCH /feed-formulas/:id/toggle-active — retire / reactivate
feedFormulaRouter.patch(
  "/:id/toggle-active",
  auth(...adminRoles),
  validateRequest(feedFormulaValidations.toggleActiveValidation),
  FeedFormulaController.toggleActive,
);

// DELETE /feed-formulas/:id — soft-retire; ?hard=true only when no recommendation uses it
feedFormulaRouter.delete("/:id", auth(...adminRoles), FeedFormulaController.deleteFormula);

export { feedFormulaRouter };
