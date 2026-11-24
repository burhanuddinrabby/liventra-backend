import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { InventoryController } from "./inventory.controller.js";
import { inventoryValidations } from "./inventory.validation.js";

/**
 * Inventory (Model 19) + Inventory_Transaction (Model 20) endpoints,
 * nested under /api/v1/farms/:farmId
 *
 * Inventory — /inventory
 * POST   /                          Owner / Manager          Register a stock item (INV-YYYY-NNNNNN); writes the opening transaction when currentStock > 0
 * GET    /                          Farm Member              List with pagination + filters (itemType, category, status, lowStock, expiringDays, expired, supplier, storage, searchTerm)
 * GET    /meta                      Farm Member              Enums, category suggestions, limits and this caller's permissions (form metadata)
 * GET    /lookup                    Farm Member              Light picker list (code, name, unit, stock, status) for the movement form
 * GET    /master-options            Farm Member              FeedIngredient / Medicine / Vaccine catalog rows, flagged if already stocked
 * GET    /dashboard-summary         Farm Member              Cards, reorder recommendations, expiring / expired lists, valuation, 30-day flow
 * GET    /alerts                    Farm Member              The rows behind the alert cards (low stock, out of stock, expiring, expired)
 * POST   /sync-statuses             Owner / Manager          Refresh stored statuses from stock / thresholds / expiry (no scheduler in the project)
 * GET    /:id                       Farm Member              Detail by _id or inventoryCode + master record + ledger preview + reconciliation
 * GET    /:id/ledger                Farm Member              Chronological ledger of one item with signed delta and running balance
 * GET    /:id/audit-logs            Owner / Manager / Acct   Change history of the item and its ledger rows
 * PUT    /:id                       Owner / Manager          Correct administrative metadata (never currentStock / unit / itemType / referenceId)
 * PATCH  /:id/toggle-active         Owner / Manager          Archive / reactivate without breaking historical transactions
 * DELETE /:id                       Owner                    Archives as Inactive; ?hard=true only with no stock and no ledger history
 *
 * Inventory_Transaction — /inventory-transactions
 * POST   /                          Owner / Manager / Worker Record a movement (Purchase, Consumption, Damage, Expired, Adjustment, Return) atomically
 * GET    /                          Farm Member              List with filters (inventoryId, transactionType, referenceType, performedBy, supplier, direction, date range)
 * GET    /summary                   Farm Member              Inflow vs outflow, purchase spend, wastage and usage breakdowns over a range
 * GET    /:id                       Farm Member              Detail by _id or transactionNo + balance after the movement + reversal state
 * POST   /:id/reverse               Owner / Manager          Compensating reversal: writes an offsetting Adjustment / Return, never mutates history
 * DELETE /:id                       Owner                    Always 403 — the stock ledger is append-only
 *
 * `auth` only proves a logged-in platform user. Membership, farm role (including the
 * per-transaction-type matrix), farm status and farm isolation are enforced in
 * inventory.services.ts.
 * Route order matters: /meta, /lookup, /master-options, /dashboard-summary, /alerts
 * and /sync-statuses must stay above /:id, and /summary above /:id.
 */
const inventoryRouter = express.Router({ mergeParams: true });
const inventoryTransactionRouter = express.Router({ mergeParams: true });

const authenticatedRoles = [SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER];

/* ------------------------------- Inventory -------------------------------- */

inventoryRouter.post(
  "/",
  auth(...authenticatedRoles),
  validateRequest(inventoryValidations.createInventoryValidation),
  InventoryController.createInventoryItem,
);

inventoryRouter.get("/", auth(...authenticatedRoles), InventoryController.getFarmInventory);
//static paths first: they must not be captured by /:id
inventoryRouter.get("/meta", auth(...authenticatedRoles), InventoryController.getInventoryMeta);
inventoryRouter.get("/lookup", auth(...authenticatedRoles), InventoryController.getInventoryLookup);
inventoryRouter.get("/master-options", auth(...authenticatedRoles), InventoryController.getMasterOptions);
inventoryRouter.get("/dashboard-summary", auth(...authenticatedRoles), InventoryController.getDashboardSummary);
inventoryRouter.get("/alerts", auth(...authenticatedRoles), InventoryController.getInventoryAlerts);
inventoryRouter.post("/sync-statuses", auth(...authenticatedRoles), InventoryController.syncInventoryStatuses);

inventoryRouter.get("/:id", auth(...authenticatedRoles), InventoryController.getInventoryItem);
//DO.md documents this as /inventory/:inventoryId/ledger — same handler, same position
inventoryRouter.get("/:id/ledger", auth(...authenticatedRoles), InventoryController.getInventoryLedger);
inventoryRouter.get("/:id/audit-logs", auth(...authenticatedRoles), InventoryController.getInventoryAuditLogs);

inventoryRouter.put(
  "/:id",
  auth(...authenticatedRoles),
  validateRequest(inventoryValidations.updateInventoryValidation),
  InventoryController.updateInventoryItem,
);

inventoryRouter.patch(
  "/:id/toggle-active",
  auth(...authenticatedRoles),
  validateRequest(inventoryValidations.toggleActiveValidation),
  InventoryController.toggleInventoryActive,
);

//DELETE body { reason } may be absent — parsed in the service
inventoryRouter.delete("/:id", auth(...authenticatedRoles), InventoryController.deleteInventoryItem);

/* -------------------------- Inventory_Transaction -------------------------- */

inventoryTransactionRouter.post(
  "/",
  auth(...authenticatedRoles),
  validateRequest(inventoryValidations.createTransactionValidation),
  InventoryController.createTransaction,
);

inventoryTransactionRouter.get("/", auth(...authenticatedRoles), InventoryController.getFarmTransactions);
//must stay above /:id
inventoryTransactionRouter.get("/summary", auth(...authenticatedRoles), InventoryController.getTransactionSummary);
inventoryTransactionRouter.get("/:id", auth(...authenticatedRoles), InventoryController.getTransaction);

inventoryTransactionRouter.post(
  "/:id/reverse",
  auth(...authenticatedRoles),
  validateRequest(inventoryValidations.reverseTransactionValidation),
  InventoryController.reverseTransaction,
);

//always 403: a committed stock movement explains the current balance
inventoryTransactionRouter.delete("/:id", auth(...authenticatedRoles), InventoryController.deleteTransaction);

export { inventoryRouter, inventoryTransactionRouter };
