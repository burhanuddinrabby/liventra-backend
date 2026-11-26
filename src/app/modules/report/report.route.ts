import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { ReportController } from "./report.controller.js";
import { reportValidations } from "./report.validation.js";

/**
 * Report endpoints (Model 28) — nested under /api/v1/farms/:farmId/reports
 *
 * GET    /reports/meta              Farm Member   report types, formats and filters this role may use
 * POST   /reports/preview-count     Farm Member   rows a given request would include (no file)
 * POST   /reports                   per role      202 + { reportId, reportNo, status } (async generation)
 * GET    /reports                   per role      history (type, format, status, generatedBy, date filters)
 * GET    /reports/:id               per role      one report's metadata (never fileUrl)
 * GET    /reports/:id/download      per role      authenticated stream, safe file name, no-store; audited as Export
 * POST   /reports/:id/retry         per role      retry a Failed report as a NEW report
 * DELETE /reports/:id               —             always 403 (reports are history)
 *
 * `auth` only proves a logged-in platform user. Membership, farm role, per-type
 * permission, farm isolation and farm status are enforced in report.services.ts.
 * Route order matters: /meta, /preview-count stay above /:id.
 */
const reportRouter = express.Router({ mergeParams: true });

const authenticatedRoles = [SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER];

reportRouter.get("/meta", auth(...authenticatedRoles), ReportController.getMeta);
reportRouter.post(
  "/preview-count",
  auth(...authenticatedRoles),
  validateRequest(reportValidations.previewValidation),
  ReportController.previewCount,
);

reportRouter.post(
  "/",
  auth(...authenticatedRoles),
  validateRequest(reportValidations.createValidation),
  ReportController.createReport,
);
reportRouter.get("/", auth(...authenticatedRoles), ReportController.listReports);

reportRouter.get("/:id", auth(...authenticatedRoles), ReportController.getReport);
reportRouter.get("/:id/download", auth(...authenticatedRoles), ReportController.downloadReport);
reportRouter.post("/:id/retry", auth(...authenticatedRoles), ReportController.retryReport);
reportRouter.delete("/:id", auth(...authenticatedRoles), ReportController.deleteReport);

export { reportRouter };
