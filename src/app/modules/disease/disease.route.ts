import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { DiseaseController } from "./disease.controller.js";
import { diseaseValidations } from "./disease.validation.js";

/**
 * /api/v1/diseases — global disease master catalog (Model 14), not farm-scoped.
 * Reads: any signed-in user (Owner / Manager / Worker / Vet use it in health workflows).
 * Writes: platform admin / superAdmin only (final schema CRUD matrix: Owner/Manager
 * read-only) — farm users must never change symptoms, prevention or vaccine links.
 * Inactive diseases stay readable by id/code; listing them (?isActive=false|all) is admin-only.
 *
 * Route order matters: /lookup, /meta, /stats, /search-by-symptoms, /check-name must stay
 * above /:id. `:id` accepts a Mongo _id or a diseaseCode (DIS-00001).
 */
const diseaseRouter = express.Router();

const authenticatedRoles = [SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER];
const adminRoles = [SystemRoles.ADMIN, SystemRoles.SUPER_ADMIN];

// POST /diseases — create a canonical disease (diseaseCode auto-generated, duplicate-name check)
diseaseRouter.post(
  "/",
  auth(...adminRoles),
  validateRequest(diseaseValidations.createDiseaseValidation),
  DiseaseController.createDisease,
);

// GET /diseases — paginated list; filters category, severity, contagious, symptom,
// recommendedVaccineId (alias vaccineId), isActive (default true; false|all admins only),
// searchTerm (name/code/symptoms/causes), sort, page, limit, fields
diseaseRouter.get("/", auth(...authenticatedRoles), DiseaseController.getAllDiseases);

// GET /diseases/lookup — slim active list for Treatment forms / health guides
diseaseRouter.get("/lookup", auth(...authenticatedRoles), DiseaseController.getDiseaseLookup);

// GET /diseases/meta — enum values (category, severity), limits, symptom-search disclaimer
diseaseRouter.get("/meta", auth(...authenticatedRoles), DiseaseController.getDiseaseMeta);

// GET /diseases/stats — catalog counts by category / severity, contagious, vaccine coverage
diseaseRouter.get("/stats", auth(...authenticatedRoles), DiseaseController.getDiseaseStats);

// GET /diseases/search-by-symptoms?symptoms=Fever,Salivation — reference ranking, NOT a diagnosis
diseaseRouter.get(
  "/search-by-symptoms",
  auth(...authenticatedRoles),
  DiseaseController.searchBySymptoms,
);

// GET /diseases/check-name?diseaseName=&excludeId= — normalized duplicate pre-check, admins only
diseaseRouter.get("/check-name", auth(...adminRoles), DiseaseController.checkDiseaseName);

// GET /diseases/:id — full detail + active recommended vaccines (admins also see retired ones)
diseaseRouter.get("/:id", auth(...authenticatedRoles), DiseaseController.getDisease);

// GET /diseases/:id/recommended-vaccines — prevention view ("schedule one of these vaccines")
diseaseRouter.get(
  "/:id/recommended-vaccines",
  auth(...authenticatedRoles),
  DiseaseController.getRecommendedVaccines,
);

// GET /diseases/:id/usage — reference counts (treatments, vaccines), admins only
diseaseRouter.get("/:id/usage", auth(...adminRoles), DiseaseController.getDiseaseUsage);

// GET /diseases/:id/audit-logs — change history, admins only
diseaseRouter.get("/:id/audit-logs", auth(...adminRoles), DiseaseController.getDiseaseAuditLogs);

// PUT /diseases/:id — refine master guidance (partial body allowed, null clears prevention/description)
diseaseRouter.put(
  "/:id",
  auth(...adminRoles),
  validateRequest(diseaseValidations.updateDiseaseValidation),
  DiseaseController.updateDisease,
);

// PATCH /diseases/:id/recommended-vaccines — { add: [], remove: [] } ($addToSet / $pull)
diseaseRouter.patch(
  "/:id/recommended-vaccines",
  auth(...adminRoles),
  validateRequest(diseaseValidations.recommendedVaccinesValidation),
  DiseaseController.updateRecommendedVaccines,
);

// PATCH /diseases/:id/toggle-active — deactivate / reactivate in the master catalog
diseaseRouter.patch(
  "/:id/toggle-active",
  auth(...adminRoles),
  validateRequest(diseaseValidations.toggleActiveValidation),
  DiseaseController.toggleActive,
);

// DELETE /diseases/:id — soft delete; ?hard=true removes only an unreferenced disease
diseaseRouter.delete("/:id", auth(...adminRoles), DiseaseController.deleteDisease);

export { diseaseRouter };
