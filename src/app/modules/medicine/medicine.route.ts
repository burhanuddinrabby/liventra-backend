import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { MedicineController } from "./medicine.controller.js";
import { medicineValidations } from "./medicine.validation.js";

/**
 * /api/v1/medicines — global medicine master catalog (Model 15), not farm-scoped.
 * Reads: any signed-in user (farm Owner/Manager/Worker/Vet select medicines for
 * Treatment and Inventory). Retired medicines are listed for admins only, but stay
 * readable by id/code for everyone so historical Treatment rows always resolve.
 * Writes: platform admin / superAdmin only (final schema CRUD table: Admin only).
 *
 * Route order matters: /lookup, /meta, /stats, /check-duplicate must stay above /:id.
 * `:id` accepts a Mongo _id or a medicineCode (MED-00001).
 */
const medicineRouter = express.Router();

const authenticatedRoles = [SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER];
const adminRoles = [SystemRoles.ADMIN, SystemRoles.SUPER_ADMIN];

// POST /medicines — register a master medicine (medicineCode auto-generated,
// route/form compatibility + normalized duplicate check)
medicineRouter.post(
  "/",
  auth(...adminRoles),
  validateRequest(medicineValidations.createMedicineValidation),
  MedicineController.createMedicine,
);

// GET /medicines — paginated list; filters category, dosageForm, administrationRoute,
// prescriptionRequired, hasWithdrawal, manufacturer, isActive (admins: false|all),
// searchTerm (name / generic / brand / code / manufacturer)
medicineRouter.get("/", auth(...authenticatedRoles), MedicineController.getAllMedicines);

// GET /medicines/lookup — slim active list for Treatment forms / Inventory mapping
medicineRouter.get("/lookup", auth(...authenticatedRoles), MedicineController.getMedicineLookup);

// GET /medicines/meta — enums, route labels and the route/form compatibility matrix
medicineRouter.get("/meta", auth(...authenticatedRoles), MedicineController.getMedicineMeta);

// GET /medicines/stats — catalog counts (active/retired/prescription/withdrawal) by category/form
medicineRouter.get("/stats", auth(...authenticatedRoles), MedicineController.getMedicineStats);

// POST /medicines/check-duplicate — create-form pre-check, never writes (admins)
medicineRouter.post(
  "/check-duplicate",
  auth(...adminRoles),
  validateRequest(medicineValidations.checkDuplicateValidation),
  MedicineController.checkDuplicate,
);

// GET /medicines/:id — full product profile by _id or medicineCode
medicineRouter.get("/:id", auth(...authenticatedRoles), MedicineController.getMedicine);

// GET /medicines/:id/withdrawal-preview — withdrawal end date for a given last dose (read-only)
medicineRouter.get(
  "/:id/withdrawal-preview",
  auth(...authenticatedRoles),
  MedicineController.getWithdrawalPreview,
);

// GET /medicines/:id/usage — reference counts (treatments, inventories), admins only
medicineRouter.get("/:id/usage", auth(...adminRoles), MedicineController.getMedicineUsage);

// GET /medicines/:id/audit-logs — change history, admins only
medicineRouter.get("/:id/audit-logs", auth(...adminRoles), MedicineController.getMedicineAuditLogs);

// PUT /medicines/:id — update master details (identity fields locked once referenced)
medicineRouter.put(
  "/:id",
  auth(...adminRoles),
  validateRequest(medicineValidations.updateMedicineValidation),
  MedicineController.updateMedicine,
);

// PATCH /medicines/:id/toggle-active — retire / reactivate in the master catalog
medicineRouter.patch(
  "/:id/toggle-active",
  auth(...adminRoles),
  validateRequest(medicineValidations.toggleActiveValidation),
  MedicineController.toggleActive,
);

// DELETE /medicines/:id — soft-retire; ?hard=true deletes only when unreferenced (else 409)
medicineRouter.delete("/:id", auth(...adminRoles), MedicineController.deleteMedicine);

export { medicineRouter };
