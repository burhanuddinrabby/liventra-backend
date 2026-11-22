import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { VaccineController } from "./vaccine.controller.js";
import { vaccineValidations } from "./vaccine.validation.js";

/**
 * /api/v1/vaccines — global vaccine master catalog (Model 12), not farm-scoped.
 * Reads: any signed-in user (farm Owner/Manager/Worker/Vet select vaccines from it).
 * Writes: platform admin / superAdmin only — a farm user must never be able to change
 * dosage, route or booster rules for the whole platform (spec §93).
 *
 * Route order matters: /lookup, /meta, /stats must stay above /:id.
 * `:id` accepts a Mongo _id or a vaccineCode (VAC-00001).
 */
const vaccineRouter = express.Router();

const authenticatedRoles = [SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER];
const adminRoles = [SystemRoles.ADMIN, SystemRoles.SUPER_ADMIN];

// POST /vaccines — register a master vaccine definition (vaccineCode auto-generated)
vaccineRouter.post(
  "/",
  auth(...adminRoles),
  validateRequest(vaccineValidations.createVaccineValidation),
  VaccineController.createVaccine,
);

// GET /vaccines — paginated list; filters category, dosageUnit, administrationRoute,
// isMandatory, boosterRequired, targetDiseaseId (alias diseaseTarget),
// isActive (default true; false|all for retired), searchTerm (code/name/shortCode/manufacturer)
vaccineRouter.get("/", auth(...authenticatedRoles), VaccineController.getAllVaccines);

// GET /vaccines/lookup — slim active list for Vaccination forms / compliance checklists
vaccineRouter.get("/lookup", auth(...authenticatedRoles), VaccineController.getVaccineLookup);

// GET /vaccines/meta — enum values (category, dosageUnit, route + labels) for forms/filters
vaccineRouter.get("/meta", auth(...authenticatedRoles), VaccineController.getVaccineMeta);

// GET /vaccines/stats — catalog counts (active/retired/mandatory/booster) by category
vaccineRouter.get("/stats", auth(...authenticatedRoles), VaccineController.getVaccineStats);

// GET /vaccines/:id — full reference configuration by _id or vaccineCode
vaccineRouter.get("/:id", auth(...authenticatedRoles), VaccineController.getVaccine);

// GET /vaccines/:id/schedule-preview — booster/repeat due dates + minimum-age check (read-only)
vaccineRouter.get(
  "/:id/schedule-preview",
  auth(...authenticatedRoles),
  VaccineController.getSchedulePreview,
);

// GET /vaccines/:id/usage — reference counts (vaccinations, diseases, inventory), admins only
vaccineRouter.get("/:id/usage", auth(...adminRoles), VaccineController.getVaccineUsage);

// GET /vaccines/:id/audit-logs — change history, admins only
vaccineRouter.get("/:id/audit-logs", auth(...adminRoles), VaccineController.getVaccineAuditLogs);

// PUT /vaccines/:id — update master specification (partial body allowed, null clears optional fields)
vaccineRouter.put(
  "/:id",
  auth(...adminRoles),
  validateRequest(vaccineValidations.updateVaccineValidation),
  VaccineController.updateVaccine,
);

// PATCH /vaccines/:id/toggle-active — retire / reactivate in the master catalog
vaccineRouter.patch(
  "/:id/toggle-active",
  auth(...adminRoles),
  validateRequest(vaccineValidations.toggleActiveValidation),
  VaccineController.toggleActive,
);

// DELETE /vaccines/:id — soft-retire; ?hard=true deletes only when unreferenced
vaccineRouter.delete("/:id", auth(...adminRoles), VaccineController.deleteVaccine);

export { vaccineRouter };
