import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { TreatmentController } from "./treatment.controller.js";
import { treatmentValidations } from "./treatment.validation.js";

/**
 * Treatment endpoints (Model 16) — nested under /api/v1/farms/:farmId
 *
 * POST   /treatments                         Owner / Manager / Vet / Worker   open an Ongoing episode, TRT number, Animal → Under Treatment
 * GET    /treatments                         Farm Member                      list + filters (animalId, diseaseId, medicineId, status, open,
 *                                                                              treatedBy, followUp=overdue|today|upcoming, from/to, searchTerm)
 * GET    /treatments/meta                    Farm Member                      statuses, transitions, units, route matrix, permissions, limits
 * GET    /treatments/stats                   Farm Member                      dashboard counts, follow-ups, top diseases / medicines, cost
 * GET    /treatments/follow-ups              Farm Member                      open episodes: overdue / today / upcoming follow-ups
 * GET    /treatments/withdrawals             Farm Member                      Active animals inside a medicine withdrawal window
 * GET    /treatments/staff                   Farm Member                      members selectable as treatedBy (name + role only)
 * GET    /treatments/:id                     Farm Member                      one episode (by _id or TRT-YYYY-NNNNNN), populated
 * GET    /treatments/:id/stock-options       Farm Member                      farm stock rows per prescribed medicine
 * GET    /treatments/:id/audit-logs          Owner / Manager / Vet            change history
 * PATCH  /treatments/:id/status              Owner / Manager / Vet            Ongoing → Recovered | Referred | Cancelled (+ reopen: Owner / Manager)
 * POST   /treatments/:id/consume-inventory   Owner / Manager / Vet / Worker   atomic medicine stock deduction + Treatment Usage ledger
 * PUT    /treatments/:id                     Owner / Manager / Vet            controlled update with AuditLog diff
 * DELETE /treatments/:id                     Owner                            only unexecuted erroneous entries (no stock, not Recovered / Referred)
 * GET    /animals/:animalId/treatments       Farm Member                      animal history, care plans, active withdrawal
 *
 * `auth` only proves a logged-in platform user. Membership, farm role, farm status and
 * farm isolation are enforced in treatment.services.ts.
 * Route order matters: /meta, /stats, /follow-ups, /withdrawals, /staff stay above /:id.
 */
const treatmentRouter = express.Router({ mergeParams: true });
const animalTreatmentRouter = express.Router({ mergeParams: true });

const authenticatedRoles = [SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER];

treatmentRouter.post(
  "/",
  auth(...authenticatedRoles),
  validateRequest(treatmentValidations.createValidation),
  TreatmentController.createTreatment,
);

treatmentRouter.get("/", auth(...authenticatedRoles), TreatmentController.getFarmTreatments);
treatmentRouter.get("/meta", auth(...authenticatedRoles), TreatmentController.getMeta);
treatmentRouter.get("/stats", auth(...authenticatedRoles), TreatmentController.getStats);
treatmentRouter.get("/follow-ups", auth(...authenticatedRoles), TreatmentController.getFollowUps);
treatmentRouter.get("/withdrawals", auth(...authenticatedRoles), TreatmentController.getWithdrawals);
treatmentRouter.get("/staff", auth(...authenticatedRoles), TreatmentController.getStaff);
treatmentRouter.get("/:id", auth(...authenticatedRoles), TreatmentController.getTreatment);
treatmentRouter.get("/:id/stock-options", auth(...authenticatedRoles), TreatmentController.getStockOptions);
treatmentRouter.get("/:id/audit-logs", auth(...authenticatedRoles), TreatmentController.getAuditLogs);

treatmentRouter.patch(
  "/:id/status",
  auth(...authenticatedRoles),
  validateRequest(treatmentValidations.statusValidation),
  TreatmentController.changeStatus,
);

treatmentRouter.post(
  "/:id/consume-inventory",
  auth(...authenticatedRoles),
  validateRequest(treatmentValidations.consumeValidation),
  TreatmentController.consumeInventory,
);

treatmentRouter.put(
  "/:id",
  auth(...authenticatedRoles),
  validateRequest(treatmentValidations.updateValidation),
  TreatmentController.updateTreatment,
);

//optional JSON body { reason } — parsed in the service (DELETE bodies may be absent)
treatmentRouter.delete("/:id", auth(...authenticatedRoles), TreatmentController.deleteTreatment);

// mounted at /farms/:farmId/animals/:animalId/treatments
animalTreatmentRouter.get("/", auth(...authenticatedRoles), TreatmentController.getAnimalTreatments);

export { treatmentRouter, animalTreatmentRouter };
