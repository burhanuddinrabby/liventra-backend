import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import { MedicineServices } from "./medicine.services.js";

type TBody = Record<string, unknown>;
const bodyOf = (req: Request): TBody => (req.body ?? {}) as TBody;
const actorOf = (req: Request) => req.user?.userId as string | undefined;

const createMedicine = catchAsync(async (req: Request, res: Response) => {
  const medicine = await MedicineServices.createMedicine(bodyOf(req), auditContextFromRequest(req));
  sendResponse(res, {
    statusCode: status.CREATED,
    success: true,
    message: "Medicine created successfully!",
    data: medicine,
  });
});

const getAllMedicines = catchAsync(async (req: Request, res: Response) => {
  const { meta, medicines } = await MedicineServices.getAllMedicines(
    req.query as TBody,
    actorOf(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Medicines retrieved successfully!",
    meta,
    data: medicines,
  });
});

const getMedicineLookup = catchAsync(async (req: Request, res: Response) => {
  const medicines = await MedicineServices.getMedicineLookup(req.query as TBody);
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Medicine lookup retrieved successfully!",
    data: medicines,
  });
});

const getMedicineMeta = catchAsync(async (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Medicine metadata retrieved successfully!",
    data: MedicineServices.getMedicineMeta(),
  });
});

const getMedicineStats = catchAsync(async (_req: Request, res: Response) => {
  const stats = await MedicineServices.getMedicineStats();
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Medicine statistics retrieved successfully!",
    data: stats,
  });
});

const checkDuplicate = catchAsync(async (req: Request, res: Response) => {
  const result = await MedicineServices.checkDuplicate(bodyOf(req));
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: result.isDuplicate ? "Possible duplicate medicine found!" : "No duplicate found.",
    data: result,
  });
});

const getMedicine = catchAsync(async (req: Request, res: Response) => {
  const medicine = await MedicineServices.getMedicine(req.params.id as string);
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Medicine retrieved successfully!",
    data: medicine,
  });
});

const getWithdrawalPreview = catchAsync(async (req: Request, res: Response) => {
  const preview = await MedicineServices.getWithdrawalPreview(
    req.params.id as string,
    req.query as TBody,
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Withdrawal preview generated successfully!",
    data: preview,
  });
});

const getMedicineUsage = catchAsync(async (req: Request, res: Response) => {
  const usage = await MedicineServices.getMedicineUsage(req.params.id as string);
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Medicine usage retrieved successfully!",
    data: usage,
  });
});

const getMedicineAuditLogs = catchAsync(async (req: Request, res: Response) => {
  const { meta, logs } = await MedicineServices.getMedicineAuditLogs(
    req.params.id as string,
    req.query as TBody,
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Medicine history retrieved successfully!",
    meta,
    data: logs,
  });
});

const updateMedicine = catchAsync(async (req: Request, res: Response) => {
  const { medicine, changedFields } = await MedicineServices.updateMedicine(
    req.params.id as string,
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: changedFields.length ? "Medicine updated successfully!" : "No changes detected.",
    data: medicine,
  });
});

const toggleActive = catchAsync(async (req: Request, res: Response) => {
  const medicine = await MedicineServices.toggleActive(
    req.params.id as string,
    bodyOf(req),
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: medicine.isActive
      ? "Medicine activated successfully!"
      : "Medicine retired from the catalog!",
    data: medicine,
  });
});

const deleteMedicine = catchAsync(async (req: Request, res: Response) => {
  const result = await MedicineServices.deleteMedicine(
    req.params.id as string,
    req.query as TBody,
    auditContextFromRequest(req),
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message:
      result.mode === "deleted"
        ? "Medicine permanently deleted!"
        : "Medicine retired (soft deleted) successfully!",
    data: result,
  });
});

export const MedicineController = {
  createMedicine,
  getAllMedicines,
  getMedicineLookup,
  getMedicineMeta,
  getMedicineStats,
  checkDuplicate,
  getMedicine,
  getWithdrawalPreview,
  getMedicineUsage,
  getMedicineAuditLogs,
  updateMedicine,
  toggleActive,
  deleteMedicine,
};
