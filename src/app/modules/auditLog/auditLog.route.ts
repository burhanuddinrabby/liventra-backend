import express from "express";
import auth from "../../middlewares/auth.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { AuditLogController } from "./auditLog.controller.js";

/**
 * Audit log — read only: rows are written by the server and can never be changed or
 * deleted through the API, so no POST / PUT / PATCH / DELETE route exists.
 *
 * Farm (Owner / Manager; enforced in the service):
 *   GET /api/v1/farms/:farmId/audit-logs
 *   GET /api/v1/farms/:farmId/audit-logs/summary
 *   GET /api/v1/farms/:farmId/audit-logs/meta
 *   GET /api/v1/farms/:farmId/audit-logs/entity/:entityType/:entityId
 *   GET /api/v1/farms/:farmId/audit-logs/user/:userId
 *   GET /api/v1/farms/:farmId/audit-logs/:id            _id or LOG-…
 * Platform (admin / superAdmin):
 *   GET /api/v1/admin/audit-logs
 *   GET /api/v1/admin/audit-logs/:id
 */
const auditLogRouter = express.Router({ mergeParams: true });
const member = auth(SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER);

auditLogRouter.get("/", member, AuditLogController.getFarmLogs);
//literal routes stay above /:id
auditLogRouter.get("/summary", member, AuditLogController.getSummary);
auditLogRouter.get("/meta", member, AuditLogController.getMeta);
auditLogRouter.get("/entity/:entityType/:entityId", member, AuditLogController.getEntityLogs);
auditLogRouter.get("/user/:userId", member, AuditLogController.getUserLogs);
auditLogRouter.get("/:id", member, AuditLogController.getFarmLog);

const adminAuditLogRouter = express.Router();
const admin = auth(SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN);

adminAuditLogRouter.get("/", admin, AuditLogController.getPlatformLogs);
adminAuditLogRouter.get("/:id", admin, AuditLogController.getPlatformLog);

export { adminAuditLogRouter, auditLogRouter };
