import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { VaccinationController } from "./vaccination.controller.js";
import { vaccinationValidations } from "./vaccination.validation.js";

/**
 * Vaccination endpoints (Model 13) — nested under /api/v1/farms/:farmId
 *
 * POST   /vaccinations/preview          Owner / Manager / Vet / Worker   eligibility + duplicate + due date + stock check, nothing saved
 * POST   /vaccinations                  Owner / Manager / Vet / Worker   schedule a dose, or record a given one (deducts stock)
 * GET    /vaccinations                  Farm Member                      list + filters (animalId, vaccineId, status, overdue, upcomingDays, batchNumber, administeredBy, from/to, searchTerm)
 * GET    /vaccinations/meta             Farm Member                      statuses, permissions, limits
 * GET    /vaccinations/compliance       Farm Member                      mandatory coverage, overdue counts, upcoming / booster reminders
 * GET    /vaccinations/administrators   Farm Member                      active members selectable as administeredBy (name + role only)
 * GET    /vaccinations/:id              Farm Member                      one record (by _id or VACLOG-YYYY-NNNNNN) + stock ledger
 * GET    /vaccinations/:id/audit-logs   Owner / Manager / Vet            change history
 * PATCH  /vaccinations/:id/complete     Owner / Manager / Vet / Worker   Scheduled → Completed, atomic stock deduction
 * PATCH  /vaccinations/:id/status       Owner / Manager / Vet            Scheduled → Missed | Cancelled (+ optional reschedule);
 *                                                                         Completed → Cancelled = reversal, Owner / Manager only
 * PUT    /vaccinations/:id              Owner / Manager / Vet            controlled correction + inventory reconciliation
 * DELETE /vaccinations/:id              Owner                            only unexecuted Scheduled / Cancelled drafts
 * GET    /animals/:animalId/vaccinations Farm Member                     animal immunization history, boosters, upcoming
 *
 * `auth` only proves a logged-in platform user. Membership, farm role, farm status and
 * farm isolation are enforced in vaccination.services.ts.
 * Route order matters: /preview, /meta, /compliance, /administrators stay above /:id.
 */
const vaccinationRouter = express.Router({ mergeParams: true });
const animalVaccinationRouter = express.Router({ mergeParams: true });

const authenticatedRoles = [SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER];

vaccinationRouter.post(
  "/preview",
  auth(...authenticatedRoles),
  validateRequest(vaccinationValidations.previewValidation),
  VaccinationController.previewVaccination,
);

vaccinationRouter.post(
  "/",
  auth(...authenticatedRoles),
  validateRequest(vaccinationValidations.createValidation),
  VaccinationController.createVaccination,
);

vaccinationRouter.get("/", auth(...authenticatedRoles), VaccinationController.getFarmVaccinations);
vaccinationRouter.get("/meta", auth(...authenticatedRoles), VaccinationController.getMeta);
vaccinationRouter.get("/compliance", auth(...authenticatedRoles), VaccinationController.getCompliance);
vaccinationRouter.get("/administrators", auth(...authenticatedRoles), VaccinationController.getAdministrators);
vaccinationRouter.get("/:id", auth(...authenticatedRoles), VaccinationController.getVaccination);
vaccinationRouter.get("/:id/audit-logs", auth(...authenticatedRoles), VaccinationController.getAuditLogs);

vaccinationRouter.patch(
  "/:id/complete",
  auth(...authenticatedRoles),
  validateRequest(vaccinationValidations.completeValidation),
  VaccinationController.completeVaccination,
);

vaccinationRouter.patch(
  "/:id/status",
  auth(...authenticatedRoles),
  validateRequest(vaccinationValidations.statusValidation),
  VaccinationController.changeStatus,
);

vaccinationRouter.put(
  "/:id",
  auth(...authenticatedRoles),
  validateRequest(vaccinationValidations.updateValidation),
  VaccinationController.updateVaccination,
);

vaccinationRouter.delete("/:id", auth(...authenticatedRoles), VaccinationController.deleteVaccination);

// mounted at /farms/:farmId/animals/:animalId/vaccinations
animalVaccinationRouter.get("/", auth(...authenticatedRoles), VaccinationController.getAnimalVaccinations);

export { vaccinationRouter, animalVaccinationRouter };
