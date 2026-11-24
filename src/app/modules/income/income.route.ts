import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { uploadAttachment } from "../finance/finance.utils.js";
import { IncomeController } from "./income.controller.js";
import { incomeValidations } from "./income.validation.js";

/**
 * Income (Model 22), nested under /api/v1/farms/:farmId/incomes.
 * Every route is Owner / Manager / Accountant; Worker and Veterinarian get 403.
 *
 * POST   /                    Manure Sale, Insurance Claim, Government Subsidy, Other
 * POST   /milk-sale           Milk sale, optional MilkRecord link, never oversold
 * POST   /animal-sale         Animal / Calf sale + Animal → Sold, atomic
 * POST   /breeding-service    Service fee linked to a Breeding record
 * GET    /                    List with filters, paging and settled / pending totals
 * GET    /meta                Enums and this caller's permissions
 * GET    /summary             Period totals, breakdowns, 12-month trend, milk produced vs sold
 * GET    /reconciliation      Sold animals without income, unsold-animal incomes, milk issues
 * GET    /reference-options   Sellable milk records / animals / breedings for the forms
 * GET    /:id                 Detail by _id or incomeNo
 * GET    /:id/audit-logs      Change history
 * PUT    /:id                 Controlled update (financial corrections need a reason)
 * PATCH  /:id/receive         Pending → Received
 * PATCH  /:id/cancel          → Cancelled (a Received one: Owner / Manager only)
 * GET    /:id/attachment      Stream the private receipt
 * PUT    /:id/attachment      Add / replace the receipt (multipart field `attachment`)
 * DELETE /:id/attachment      Remove it (Pending only)
 * DELETE /:id                 Always 403 (Owner reaches the explanation)
 *
 * GET /api/v1/farms/:farmId/finance/profit-loss — Received income − Paid expense.
 *
 * Farm role, farm status and isolation are enforced in the services.
 * Static paths must stay above /:id.
 */
const incomeRouter = express.Router({ mergeParams: true });
const financeRouter = express.Router({ mergeParams: true });
const signedIn = auth(SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER);

incomeRouter.post("/", signedIn, validateRequest(incomeValidations.createIncomeValidation), IncomeController.create);
incomeRouter.post("/milk-sale", signedIn, validateRequest(incomeValidations.milkSaleValidation), IncomeController.milkSale);
incomeRouter.post("/animal-sale", signedIn, validateRequest(incomeValidations.animalSaleValidation), IncomeController.animalSale);
incomeRouter.post(
  "/breeding-service",
  signedIn,
  validateRequest(incomeValidations.breedingServiceValidation),
  IncomeController.breedingService,
);
incomeRouter.get("/", signedIn, IncomeController.list);
incomeRouter.get("/meta", signedIn, IncomeController.meta);
incomeRouter.get("/summary", signedIn, IncomeController.summary);
incomeRouter.get("/reconciliation", signedIn, IncomeController.reconciliation);
incomeRouter.get("/reference-options", signedIn, IncomeController.referenceOptions);

incomeRouter.get("/:id", signedIn, IncomeController.detail);
incomeRouter.get("/:id/audit-logs", signedIn, IncomeController.auditLogs);
incomeRouter.put("/:id", signedIn, validateRequest(incomeValidations.updateIncomeValidation), IncomeController.update);
incomeRouter.patch("/:id/receive", signedIn, validateRequest(incomeValidations.receiveValidation), IncomeController.settle);
incomeRouter.patch("/:id/cancel", signedIn, validateRequest(incomeValidations.cancelValidation), IncomeController.cancel);
incomeRouter.get("/:id/attachment", signedIn, IncomeController.getAttachment);
incomeRouter.put("/:id/attachment", signedIn, uploadAttachment, IncomeController.setAttachment);
incomeRouter.delete("/:id/attachment", signedIn, IncomeController.removeAttachment);
incomeRouter.delete("/:id", signedIn, IncomeController.remove);

financeRouter.get("/profit-loss", signedIn, IncomeController.profitLoss);

export { financeRouter, incomeRouter };
