import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import { InventoryServices } from "./inventory.services.js";

//farm-level authorization happens in the service; the controller only maps HTTP <-> service
const farmIdOf = (req: Request) => req.params.farmId as string;
const idOf = (req: Request) => req.params.id as string;
const requesterOf = (req: Request) => req.user.userId as string;
const bodyOf = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
const queryOf = (req: Request) => req.query as Record<string, unknown>;

/* ------------------------------- Inventory -------------------------------- */

const createInventoryItem = catchAsync(async (req: Request, res: Response) => {
  const data = await InventoryServices.createInventoryItem(
    farmIdOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.CREATED,
    success: true,
    message: data.openingTransaction
      ? `Inventory item registered with its opening stock (${data.openingTransaction.transactionNo})!`
      : "Inventory item registered successfully!",
    data,
  });
});

const getFarmInventory = catchAsync(async (req: Request, res: Response) => {
  const { meta, data, summary } = await InventoryServices.getFarmInventory(
    farmIdOf(req),
    requesterOf(req),
    queryOf(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Inventory retrieved successfully!",
    meta,
    data: { items: data, summary },
  });
});

const getInventoryMeta = catchAsync(async (req: Request, res: Response) => {
  const data = await InventoryServices.getInventoryMeta(farmIdOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Inventory metadata retrieved successfully!", data });
});

const getInventoryLookup = catchAsync(async (req: Request, res: Response) => {
  const data = await InventoryServices.getInventoryLookup(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Inventory lookup retrieved successfully!", data });
});

const getMasterOptions = catchAsync(async (req: Request, res: Response) => {
  const data = await InventoryServices.getMasterOptions(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Master catalog options retrieved successfully!", data });
});

const getDashboardSummary = catchAsync(async (req: Request, res: Response) => {
  const data = await InventoryServices.getDashboardSummary(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Inventory dashboard summary calculated!", data });
});

const getInventoryAlerts = catchAsync(async (req: Request, res: Response) => {
  const data = await InventoryServices.getInventoryAlerts(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Inventory alerts retrieved successfully!", data });
});

const getInventoryItem = catchAsync(async (req: Request, res: Response) => {
  const data = await InventoryServices.getInventoryItem(farmIdOf(req), idOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Inventory item retrieved successfully!", data });
});

const getInventoryLedger = catchAsync(async (req: Request, res: Response) => {
  //mounted both as /inventory/:id/ledger and /inventory/:inventoryId/ledger
  const reference = (req.params.inventoryId ?? req.params.id) as string;
  const { meta, ...rest } = await InventoryServices.getInventoryLedger(
    farmIdOf(req),
    reference,
    requesterOf(req),
    queryOf(req),
  );
  sendResponse(res, { statusCode: status.OK, success: true, message: "Stock ledger retrieved successfully!", meta, data: rest });
});

const getInventoryAuditLogs = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await InventoryServices.getInventoryAuditLogs(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    queryOf(req),
  );
  sendResponse(res, { statusCode: status.OK, success: true, message: "Inventory history retrieved successfully!", meta, data });
});

const updateInventoryItem = catchAsync(async (req: Request, res: Response) => {
  const data = await InventoryServices.updateInventoryItem(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: data.mode === "unchanged" ? "Nothing to update — the inventory item is unchanged." : "Inventory item updated successfully!",
    data,
  });
});

const toggleInventoryActive = catchAsync(async (req: Request, res: Response) => {
  const data = await InventoryServices.toggleInventoryActive(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, { statusCode: status.OK, success: true, message: data.message, data });
});

const syncInventoryStatuses = catchAsync(async (req: Request, res: Response) => {
  const data = await InventoryServices.syncInventoryStatuses(
    farmIdOf(req),
    requesterOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: data.changed
      ? `${data.changed} of ${data.checked} inventory item(s) had their status refreshed.`
      : `All ${data.checked} inventory item(s) already had the correct status.`,
    data,
  });
});

const deleteInventoryItem = catchAsync(async (req: Request, res: Response) => {
  const data = await InventoryServices.deleteInventoryItem(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    queryOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, { statusCode: status.OK, success: true, message: data.message, data });
});

/* -------------------------- Inventory_Transaction -------------------------- */

const createTransaction = catchAsync(async (req: Request, res: Response) => {
  const data = await InventoryServices.createTransaction(
    farmIdOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.CREATED,
    success: true,
    message: `${data.transaction.transactionType} recorded — ${data.item.itemName} is now at ${data.item.currentStock} ${data.item.unit}.`,
    data,
  });
});

const getFarmTransactions = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await InventoryServices.getFarmTransactions(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Stock movements retrieved successfully!", meta, data });
});

const getTransactionSummary = catchAsync(async (req: Request, res: Response) => {
  const data = await InventoryServices.getTransactionSummary(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Stock movement summary calculated!", data });
});

const getTransaction = catchAsync(async (req: Request, res: Response) => {
  const data = await InventoryServices.getTransaction(farmIdOf(req), idOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Stock movement retrieved successfully!", data });
});

const reverseTransaction = catchAsync(async (req: Request, res: Response) => {
  const data = await InventoryServices.reverseTransaction(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.CREATED,
    success: true,
    message: `${data.original.transactionNo} reversed by ${data.reversal.transactionNo} — ${data.item.itemName} is now at ${data.item.currentStock} ${data.item.unit}.`,
    data,
  });
});

//always throws 403: the ledger is append-only (handled in the service)
const deleteTransaction = catchAsync(async (req: Request, res: Response) => {
  const data = await InventoryServices.deleteTransaction(farmIdOf(req), idOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Stock movements cannot be deleted.", data });
});

export const InventoryController = {
  createInventoryItem,
  getFarmInventory,
  getInventoryMeta,
  getInventoryLookup,
  getMasterOptions,
  getDashboardSummary,
  getInventoryAlerts,
  getInventoryItem,
  getInventoryLedger,
  getInventoryAuditLogs,
  updateInventoryItem,
  toggleInventoryActive,
  syncInventoryStatuses,
  deleteInventoryItem,
  createTransaction,
  getFarmTransactions,
  getTransactionSummary,
  getTransaction,
  reverseTransaction,
  deleteTransaction,
};
