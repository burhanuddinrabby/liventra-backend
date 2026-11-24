import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import { bodyOf, createLedgerController, farmIdOf, idOf, queryOf, requesterOf } from "../finance/finance.controller.js";
import { IncomeLedger, IncomeServices } from "./income.services.js";

//the four creation workflows only differ in the service they call
const creator = (service: typeof IncomeServices.createIncome, message: string) =>
  catchAsync(async (req: Request, res: Response) => {
    const data = await service(farmIdOf(req), requesterOf(req), bodyOf(req), auditContextFromRequest(req));
    sendResponse(res, { statusCode: status.CREATED, success: true, message, data });
  });

//read-only reports that take the farm, the caller and the query
const report = (service: typeof IncomeServices.getSummary, message: string) =>
  catchAsync(async (req: Request, res: Response) => {
    const data = await service(farmIdOf(req), requesterOf(req), queryOf(req));
    sendResponse(res, { statusCode: status.OK, success: true, message, data });
  });

const update = catchAsync(async (req: Request, res: Response) => {
  const data = await IncomeServices.updateIncome(
    farmIdOf(req),
    idOf(req),
    requesterOf(req),
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: data.mode === "unchanged" ? "Nothing to update — the income is unchanged." : "Income updated successfully!",
    data,
  });
});

const meta = catchAsync(async (req: Request, res: Response) => {
  const data = await IncomeServices.getMeta(farmIdOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Income metadata retrieved successfully!", data });
});

const referenceOptions = catchAsync(async (req: Request, res: Response) => {
  const data = await IncomeServices.getReferenceOptions(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Reference options retrieved successfully!", data });
});

const reconciliation = catchAsync(async (req: Request, res: Response) => {
  const data = await IncomeServices.getReconciliation(farmIdOf(req), requesterOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Income reconciliation calculated!", data });
});

const profitLoss = catchAsync(async (req: Request, res: Response) => {
  const data = await IncomeServices.getProfitLoss(farmIdOf(req), requesterOf(req), queryOf(req));
  sendResponse(res, { statusCode: status.OK, success: true, message: "Profit / loss calculated!", data });
});

export const IncomeController = {
  ...createLedgerController(IncomeLedger, "Income"),
  create: creator(IncomeServices.createIncome, "Income recorded successfully!"),
  milkSale: creator(IncomeServices.createMilkSale, "Milk sale recorded successfully!"),
  animalSale: creator(IncomeServices.createAnimalSale, "Animal sale recorded successfully!"),
  breedingService: creator(IncomeServices.createBreedingService, "Breeding service recorded successfully!"),
  update,
  summary: report(IncomeServices.getSummary, "Income summary calculated!"),
  meta,
  referenceOptions,
  reconciliation,
  profitLoss,
};
