import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { PregnancyController } from "./pregnancy.controller.js";
import { pregnancyValidations } from "./pregnancy.validation.js";

/**
 * Pregnancy endpoints (Model 18) — nested under /api/v1/farms/:farmId
 *
 * POST   /pregnancies                          Owner / Manager / Vet   Create a pregnancy from a confirmed Breeding (PRG-YYYY-NNNNNN)
 * GET    /pregnancies                          Farm Member             List with pagination + filters (status, animalId, date range, upcomingCalvingDays, overdueCalving, searchTerm)
 * GET    /pregnancies/analytics                Farm Member             Reproductive performance metrics (delivery rate, abortion rate, twin rate, expected vs actual variance)
 * GET    /pregnancies/eligible-breedings       Owner / Manager / Vet   Confirmed breedings that can still start a pregnancy (create-form picker)
 * GET    /pregnancies/:id                      Farm Member             Full detail by _id or PRG-YYYY-NNNNNN (populated animal, breeding, createdBy)
 * GET    /pregnancies/:id/audit-logs           Owner / Manager / Vet   Change history (pregnancy + its upstream breeding rows)
 * PATCH  /pregnancies/:id/deliver              Owner / Manager / Vet   Atomic calving workflow: Pregnant → Delivered, calfCount/calfGender, mother → Lactating
 * PATCH  /pregnancies/:id/outcome              Owner / Manager / Vet   Pregnant → Aborted or Failed (with reason/remarks), mother → Open if no newer cycle
 * PUT    /pregnancies/:id                      Owner / Manager / Vet   Controlled correction of conceptionDate / expectedCalvingDate / remarks + AuditLog
 * DELETE /pregnancies/:id                      Owner                   Blocked — historical pregnancy records cannot be hard-deleted
 *
 * GET    /animals/:animalId/pregnancies        Farm Member             Lifetime pregnancy history for a specific female animal (active gestation + all episodes)
 *
 * `auth` only proves a logged-in platform user. Membership, farm role, farm status and
 * farm isolation are enforced in pregnancy.services.ts.
 * Route order matters: /analytics and /eligible-breedings stay above /:id.
 */
const pregnancyRouter = express.Router({ mergeParams: true });
const animalPregnancyRouter = express.Router({ mergeParams: true });

const authenticatedRoles = [SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER];

pregnancyRouter.post(
  "/",
  auth(...authenticatedRoles),
  validateRequest(pregnancyValidations.createValidation),
  PregnancyController.createPregnancy,
);

pregnancyRouter.get("/", auth(...authenticatedRoles), PregnancyController.getFarmPregnancies);
pregnancyRouter.get("/analytics", auth(...authenticatedRoles), PregnancyController.getPregnancyAnalytics);
//create-form picker: Confirmed breedings with no pregnancy yet. Must stay above /:id.
pregnancyRouter.get("/eligible-breedings", auth(...authenticatedRoles), PregnancyController.getEligibleBreedings);
pregnancyRouter.get("/:id", auth(...authenticatedRoles), PregnancyController.getPregnancy);
pregnancyRouter.get("/:id/audit-logs", auth(...authenticatedRoles), PregnancyController.getAuditLogs);

pregnancyRouter.patch(
  "/:id/deliver",
  auth(...authenticatedRoles),
  validateRequest(pregnancyValidations.deliverValidation),
  PregnancyController.deliverPregnancy,
);

pregnancyRouter.patch(
  "/:id/outcome",
  auth(...authenticatedRoles),
  validateRequest(pregnancyValidations.outcomeValidation),
  PregnancyController.recordPregnancyOutcome,
);

pregnancyRouter.put(
  "/:id",
  auth(...authenticatedRoles),
  validateRequest(pregnancyValidations.updateValidation),
  PregnancyController.updatePregnancy,
);

//DELETE body { reason } may be absent — parsed in the service
pregnancyRouter.delete("/:id", auth(...authenticatedRoles), PregnancyController.deletePregnancy);

// mounted at /farms/:farmId/animals/:animalId/pregnancies
animalPregnancyRouter.get("/", auth(...authenticatedRoles), PregnancyController.getAnimalPregnancies);

export { pregnancyRouter, animalPregnancyRouter };
