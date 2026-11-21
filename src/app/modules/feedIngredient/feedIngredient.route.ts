import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { FeedIngredientController } from "./feedIngredient.controller.js";
import { feedIngredientValidations } from "./feedIngredient.validation.js";

/**
 * /api/v1/feed-ingredients — global master catalog (Model 06), not farm-scoped.
 * Reads: any signed-in user. Writes: platform admin / superAdmin, except
 * availability, which farm Owners/Managers may also toggle (checked in the service).
 *
 * Route order matters: /lookup, /meta, /stats must stay above /:id.
 * `:id` accepts a Mongo _id or an ingredientCode (ING-00001).
 */
const feedIngredientRouter = express.Router();

const authenticatedRoles = [SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER];
const adminRoles = [SystemRoles.ADMIN, SystemRoles.SUPER_ADMIN];

// POST /feed-ingredients — register a canonical ingredient (code auto-generated)
feedIngredientRouter.post(
  "/",
  auth(...adminRoles),
  validateRequest(feedIngredientValidations.createFeedIngredientValidation),
  FeedIngredientController.createIngredient,
);

// GET /feed-ingredients — paginated list; filters category, unit, isAvailable,
// isActive (default true; false|all for retired), supplierId, minPrice/maxPrice, searchTerm
feedIngredientRouter.get("/", auth(...authenticatedRoles), FeedIngredientController.getAllIngredients);

// GET /feed-ingredients/lookup — slim active list for formula builders / cost estimators
feedIngredientRouter.get(
  "/lookup",
  auth(...authenticatedRoles),
  FeedIngredientController.getIngredientLookup,
);

// GET /feed-ingredients/meta — enum values + nutrition units for forms/filters
feedIngredientRouter.get("/meta", auth(...authenticatedRoles), FeedIngredientController.getIngredientMeta);

// GET /feed-ingredients/stats — catalog counts (active/retired/available) by category
feedIngredientRouter.get(
  "/stats",
  auth(...authenticatedRoles),
  FeedIngredientController.getIngredientStats,
);

// GET /feed-ingredients/:id — full nutrition/pricing profile by _id or ingredientCode
feedIngredientRouter.get("/:id", auth(...authenticatedRoles), FeedIngredientController.getIngredient);

// GET /feed-ingredients/:id/usage — reference counts (formulas, recommendations, records, inventory)
feedIngredientRouter.get("/:id/usage", auth(...adminRoles), FeedIngredientController.getIngredientUsage);

// GET /feed-ingredients/:id/audit-logs — change history (price/nutrition/status), admins only
feedIngredientRouter.get(
  "/:id/audit-logs",
  auth(...adminRoles),
  FeedIngredientController.getIngredientAuditLogs,
);

// PUT /feed-ingredients/:id — update master data (partial body allowed, null clears optional fields)
feedIngredientRouter.put(
  "/:id",
  auth(...adminRoles),
  validateRequest(feedIngredientValidations.updateFeedIngredientValidation),
  FeedIngredientController.updateIngredient,
);

// PATCH /feed-ingredients/:id/availability — temporary out-of-market/stock switch
// (admin/superAdmin, or a farm Owner/Manager — enforced in the service)
feedIngredientRouter.patch(
  "/:id/availability",
  auth(...authenticatedRoles),
  validateRequest(feedIngredientValidations.availabilityValidation),
  FeedIngredientController.updateAvailability,
);

// PATCH /feed-ingredients/:id/toggle-active — retire / reactivate in the master catalog
feedIngredientRouter.patch(
  "/:id/toggle-active",
  auth(...adminRoles),
  validateRequest(feedIngredientValidations.toggleActiveValidation),
  FeedIngredientController.toggleActive,
);

// DELETE /feed-ingredients/:id — soft-retire; ?hard=true deletes only when unreferenced
feedIngredientRouter.delete("/:id", auth(...adminRoles), FeedIngredientController.deleteIngredient);

export { feedIngredientRouter };
