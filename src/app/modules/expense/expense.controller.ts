import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import { bodyOf, createLedgerController, farmIdOf, idOf, queryOf, requesterOf } from "../finance/finance.controller.js";
import { ExpenseLedger, ExpenseServices } from "./expense.services.js";

const create = catchAsync(async (req: Request, res: Response) => {
  const data = await ExpenseServices.createExpense(farmIdOf(req), requesterOf(req), bodyOf(req), auditContextFromRequest(req));
  sendResponse(res, { statusCode: status.CREATED, success: true, message: "Expense recorded successfully!", data });
});

const purchase = catchAsync(async (req: Request, res: Response) => {
  const data = await ExpenseServices.createPurchase(farmIdOf(req), requesterOf(req), bodyOf(req), auditContextFromRequest(req));
  sendResponse(res, {
    statusCode: status.CREATED,
    success: true,
    message: `Purchase recorded — ${data.item.itemName} is now at ${data.item.currentStock} ${data.item.unit}.`,
    data,
  });
});

const update = catchAsync(async (req: Request, res: Response) => {
  const data = await ExpenseServices.updateExpense(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: data.mode === "unchanged" ? "Nothing to update — the expense is unchanged." : "Expense updated successfully!",
    data,
  });
});

const summary = catchAsync(async (req: Request, res: Response) => {
  const data = await ExpenseLedger.summary(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Expense summary calculated!", data });
});

const meta = catchAsync(async (req: Request, res: Response) => {
  const data = await ExpenseServices.getMeta(farmIdOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Expense metadata retrieved successfully!", data });
});

const referenceOptions = catchAsync(async (req: Request, res: Response) => {
  const data = await ExpenseServices.getReferenceOptions(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Reference options retrieved successfully!", data });
});

const reconciliation = catchAsync(async (req: Request, res: Response) => {
  const data = await ExpenseServices.getReconciliation(farmIdOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Expense reconciliation calculated!", data });
});

export const ExpenseController = {
  ...createLedgerController(ExpenseLedger, "Expense"),
  create,
  purchase,
  update,
  summary,
  meta,
  referenceOptions,
  reconciliation,
};
