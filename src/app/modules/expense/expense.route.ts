import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { uploadAttachment } from "../finance/finance.utils.js";
import { ExpenseController } from "./expense.controller.js";
import { expenseValidations } from "./expense.validation.js";

/**
 * Expense (Model 21), nested under /api/v1/farms/:farmId/expenses.
 * Every route is Owner / Manager / Accountant; Worker and Veterinarian get 403.
 *
 * POST   /                    Record a manual / treatment / purchase-linked expense
 * POST   /purchase            Atomic purchase: stock + Purchase ledger row + linked expense
 * GET    /                    List with filters, paging and settled / pending totals
 * GET    /meta                Enums and this caller's permissions
 * GET    /summary             Period totals, breakdowns, 12-month trend (Paid vs Pending)
 * GET    /reconciliation      Purchases without an expense, reversed purchases, mismatches
 * GET    /reference-options   Unbooked purchases / treatments for the create form
 * GET    /:id                 Detail by _id or expenseNo
 * GET    /:id/audit-logs      Change history
 * PUT    /:id                 Controlled update (financial corrections need a reason)
 * PATCH  /:id/pay             Pending → Paid
 * PATCH  /:id/cancel          → Cancelled (a Paid one: Owner / Manager only)
 * GET    /:id/attachment      Stream the private receipt
 * PUT    /:id/attachment      Add / replace the receipt (multipart field `attachment`)
 * DELETE /:id/attachment      Remove it (Pending only)
 * DELETE /:id                 Always 403 (Owner reaches the explanation)
 *
 * Farm role, farm status and isolation are enforced in the services.
 * Static paths must stay above /:id.
 */
const expenseRouter = express.Router({ mergeParams: true });
const signedIn = auth(SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER);

expenseRouter.post("/", signedIn, validateRequest(expenseValidations.createExpenseValidation), ExpenseController.create);
expenseRouter.post("/purchase", signedIn, validateRequest(expenseValidations.purchaseValidation), ExpenseController.purchase);
expenseRouter.get("/", signedIn, ExpenseController.list);
expenseRouter.get("/meta", signedIn, ExpenseController.meta);
expenseRouter.get("/summary", signedIn, ExpenseController.summary);
expenseRouter.get("/reconciliation", signedIn, ExpenseController.reconciliation);
expenseRouter.get("/reference-options", signedIn, ExpenseController.referenceOptions);

expenseRouter.get("/:id", signedIn, ExpenseController.detail);
expenseRouter.get("/:id/audit-logs", signedIn, ExpenseController.auditLogs);
expenseRouter.put("/:id", signedIn, validateRequest(expenseValidations.updateExpenseValidation), ExpenseController.update);
expenseRouter.patch("/:id/pay", signedIn, validateRequest(expenseValidations.payValidation), ExpenseController.settle);
expenseRouter.patch("/:id/cancel", signedIn, validateRequest(expenseValidations.cancelValidation), ExpenseController.cancel);
expenseRouter.get("/:id/attachment", signedIn, ExpenseController.getAttachment);
expenseRouter.put("/:id/attachment", signedIn, uploadAttachment, ExpenseController.setAttachment);
expenseRouter.delete("/:id/attachment", signedIn, ExpenseController.removeAttachment);
expenseRouter.delete("/:id", signedIn, ExpenseController.remove);

export { expenseRouter };
