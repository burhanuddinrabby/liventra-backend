import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { BreedingController } from "./breeding.controller.js";
import { breedingValidations } from "./breeding.validation.js";

/**
 * Breeding endpoints (Model 17) — nested under /api/v1/farms/:farmId
 *
 * POST   /breedings                          Owner / Manager / Vet / Worker   log a breeding event (BRD number, Pending)
 * GET    /breedings                          Farm Member                      list + filters (animalId, bullId, breedingMethod,
 *                                                                              pregnancyResult, overdueCheck=true, check=overdue|today|upcoming,
 *                                                                              semenBatchNo, technicianName, heatOnly, from/to + dateField, searchTerm)
 * GET    /breedings/meta                     Farm Member                      methods, results, transitions, policy, permissions, limits
 * GET    /breedings/analytics                Farm Member                      confirmation rate, attempts per conception, method / bull /
 *                                                                              semen batch / technician outcomes, trend, repeat breeders
 * GET    /breedings/pregnancy-checks         Farm Member                      Pending checks: overdue / today / upcoming (reminders)
 * GET    /breedings/eligibility?animalId=    Farm Member                      form pre-check: blockers, warnings, pending attempts
 * GET    /breedings/bulls                    Farm Member                      male animals selectable as bullId (+ outcome counts)
 * GET    /breedings/:id                      Farm Member                      one record (by _id or BRD-YYYY-NNNNNN) + linked Pregnancy
 * GET    /breedings/:id/audit-logs           Owner / Manager / Vet            change history (breeding + its pregnancy)
 * PATCH  /breedings/:id/pregnancy-result     Owner / Manager / Vet            Confirmed (atomic Pregnancy + Animal) / Failed / corrections
 * PUT    /breedings/:id                      Owner / Manager / Vet            controlled correction with AuditLog diff
 * DELETE /breedings/:id                      Owner                            only unconfirmed entries without a linked Pregnancy (reason)
 * GET    /animals/:animalId/breedings        Farm Member                      female's chronological history, conception rate, pending checks
 *
 * `auth` only proves a logged-in platform user. Membership, farm role, farm status and
 * farm isolation are enforced in breeding.services.ts.
 * Route order matters: /meta, /analytics, /pregnancy-checks, /eligibility, /bulls stay above /:id.
 */
const breedingRouter = express.Router({ mergeParams: true });
const animalBreedingRouter = express.Router({ mergeParams: true });

const authenticatedRoles = [SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER];

breedingRouter.post(
  "/",
  auth(...authenticatedRoles),
  validateRequest(breedingValidations.createValidation),
  BreedingController.createBreeding,
);

breedingRouter.get("/", auth(...authenticatedRoles), BreedingController.getFarmBreedings);
breedingRouter.get("/meta", auth(...authenticatedRoles), BreedingController.getMeta);
breedingRouter.get("/analytics", auth(...authenticatedRoles), BreedingController.getAnalytics);
breedingRouter.get("/pregnancy-checks", auth(...authenticatedRoles), BreedingController.getPregnancyChecks);
breedingRouter.get("/eligibility", auth(...authenticatedRoles), BreedingController.getEligibility);
breedingRouter.get("/bulls", auth(...authenticatedRoles), BreedingController.getBulls);
breedingRouter.get("/:id", auth(...authenticatedRoles), BreedingController.getBreeding);
breedingRouter.get("/:id/audit-logs", auth(...authenticatedRoles), BreedingController.getAuditLogs);

breedingRouter.patch(
  "/:id/pregnancy-result",
  auth(...authenticatedRoles),
  validateRequest(breedingValidations.resultValidation),
  BreedingController.recordPregnancyResult,
);

breedingRouter.put(
  "/:id",
  auth(...authenticatedRoles),
  validateRequest(breedingValidations.updateValidation),
  BreedingController.updateBreeding,
);

//JSON body { reason } (required) — parsed in the service (DELETE bodies may be absent)
breedingRouter.delete("/:id", auth(...authenticatedRoles), BreedingController.deleteBreeding);

// mounted at /farms/:farmId/animals/:animalId/breedings
animalBreedingRouter.get("/", auth(...authenticatedRoles), BreedingController.getAnimalBreedings);

export { breedingRouter, animalBreedingRouter };
