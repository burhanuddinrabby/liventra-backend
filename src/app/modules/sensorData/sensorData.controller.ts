import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import type { TMeta } from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import { SensorDataServices as S } from "./sensorData.services.js";

type TData = Record<string, unknown>;

const farmOf = (req: Request) => req.params.farmId as string;
const requesterOf = (req: Request) => req.user.userId as string;
const queryOf = (req: Request) => req.query as TData;
//express 5 leaves req.body undefined when nothing was sent
const bodyOf = (req: Request) => (req.body ?? {}) as TData;

const send = (res: Response, message: string, data: unknown, statusCode: number = status.OK) =>
  sendResponse(res, { statusCode, success: true, message, data });

const sendPage = (res: Response, message: string, meta: TMeta, data: unknown) =>
  sendResponse(res, { statusCode: status.OK, success: true, message, meta, data });

const createReading = catchAsync(async (req, res) => {
  const data = await S.createReading(farmOf(req), requesterOf(req), bodyOf(req), auditContextFromRequest(req));
  send(res, "Reading saved successfully!", data, status.CREATED);
});

const previewImport = catchAsync(async (req, res) => {
  send(res, "Import checked: nothing was saved.", await S.previewImport(farmOf(req), requesterOf(req), req.file));
});

const importReadings = catchAsync(async (req, res) => {
  const data = await S.importReadings(farmOf(req), requesterOf(req), req.file, auditContextFromRequest(req));
  send(res, `Import finished: ${data.summary.inserted} saved, ${data.summary.duplicate} duplicate, ${data.summary.rejected} rejected.`, data);
});

const getTemplate = catchAsync(async (req, res) => {
  const csv = await S.getTemplate(farmOf(req), requesterOf(req));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="sensor-data-template.csv"');
  res.status(status.OK).send(csv);
});

const getReadings = catchAsync(async (req, res) => {
  const { meta, readings } = await S.getReadings(farmOf(req), requesterOf(req), queryOf(req));
  sendPage(res, "Readings retrieved successfully!", meta as unknown as TMeta, readings);
});

const getAlerts = catchAsync(async (req, res) => {
  const { meta, readings } = await S.getAlerts(farmOf(req), requesterOf(req), queryOf(req));
  sendPage(res, "Sensor alerts retrieved successfully!", meta as unknown as TMeta, readings);
});

const getTrends = catchAsync(async (req, res) => {
  send(res, "Trends retrieved successfully!", await S.getTrends(farmOf(req), requesterOf(req), queryOf(req)));
});

const getLatest = catchAsync(async (req, res) => {
  send(res, "Latest readings retrieved successfully!", await S.getLatest(farmOf(req), requesterOf(req), queryOf(req)));
});

const getDashboard = catchAsync(async (req, res) => {
  send(res, "Sensor dashboard retrieved successfully!", await S.getDashboard(farmOf(req), requesterOf(req)));
});

const getMeta = catchAsync(async (req, res) => {
  send(res, "Sensor options retrieved successfully!", await S.getMeta(farmOf(req), requesterOf(req)));
});

const getReading = catchAsync(async (req, res) => {
  send(res, "Reading retrieved successfully!", await S.getReading(farmOf(req), requesterOf(req), req.params.id as string));
});

export const SensorDataController = {
  createReading,
  previewImport,
  importReadings,
  getTemplate,
  getReadings,
  getAlerts,
  getTrends,
  getLatest,
  getDashboard,
  getMeta,
  getReading,
};
