import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import type { createLedger } from "./finance.ledger.js";

//farm-level authorization happens in the services; controllers only map HTTP <-> service
export const farmIdOf = (req: Request) => req.params.farmId as string;
export const idOf = (req: Request) => req.params.id as string;
export const requesterOf = (req: Request) => req.user.userId as string;
export const bodyOf = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
export const queryOf = (req: Request) => req.query as Record<string, unknown>;

/** The handlers Expense and Income have in common. */
export const createLedgerController = (ledger: ReturnType<typeof createLedger>, label: string) => ({
  list: catchAsync(async (req: Request, res: Response) => {
    const { meta, data } = await ledger.list(farmIdOf(req), requesterOf(req), queryOf(req));
    sendResponse(res, { statusCode: status.OK, success: true, message: `${label} records retrieved successfully!`, meta, data });
  }),

  detail: catchAsync(async (req: Request, res: Response) => {
    const data = await ledger.detail(farmIdOf(req), idOf(req), requesterOf(req));
    sendResponse(res, { statusCode: status.OK, success: true, message: `${label} retrieved successfully!`, data });
  }),

  auditLogs: catchAsync(async (req: Request, res: Response) => {
    const { meta, data } = await ledger.auditLogs(farmIdOf(req), idOf(req), requesterOf(req), queryOf(req));
    sendResponse(res, { statusCode: status.OK, success: true, message: `${label} history retrieved successfully!`, meta, data });
  }),

  settle: catchAsync(async (req: Request, res: Response) => {
    const data = await ledger.settle(farmIdOf(req), idOf(req), requesterOf(req), bodyOf(req), auditContextFromRequest(req));
    sendResponse(res, { statusCode: status.OK, success: true, message: `${label} settled successfully!`, data });
  }),

  cancel: catchAsync(async (req: Request, res: Response) => {
    const data = await ledger.cancel(farmIdOf(req), idOf(req), requesterOf(req), bodyOf(req), auditContextFromRequest(req));
    sendResponse(res, { statusCode: status.OK, success: true, message: `${label} cancelled successfully!`, data });
  }),

  //always throws 403 (handled in the service)
  remove: catchAsync(async (req: Request, res: Response) => {
    const data = await ledger.remove(farmIdOf(req), idOf(req), requesterOf(req));
    sendResponse(res, { statusCode: status.OK, success: true, message: "Financial records cannot be deleted.", data });
  }),

  setAttachment: catchAsync(async (req: Request, res: Response) => {
    const data = await ledger.setAttachment(
      farmIdOf(req),
      idOf(req),
      requesterOf(req),
      req.file?.buffer,
      auditContextFromRequest(req),
    );
    sendResponse(res, { statusCode: status.OK, success: true, message: "Receipt saved successfully!", data });
  }),

  getAttachment: catchAsync(async (req: Request, res: Response) => {
    const file = await ledger.getAttachment(farmIdOf(req), idOf(req), requesterOf(req));
    res
      .set({
        "Content-Type": file.mime,
        "Content-Disposition": `attachment; filename="${file.fileName}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      })
      .send(file.buffer);
  }),

  removeAttachment: catchAsync(async (req: Request, res: Response) => {
    const data = await ledger.removeAttachment(farmIdOf(req), idOf(req), requesterOf(req), auditContextFromRequest(req));
    sendResponse(res, { statusCode: status.OK, success: true, message: "Receipt removed successfully!", data });
  }),
});
