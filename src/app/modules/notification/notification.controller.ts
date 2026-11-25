import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { auditContextFromRequest } from "../auditLog/auditLog.utils.js";
import { NotificationServices } from "./notification.services.js";

const param = (req: Request, name: string) => req.params[name] as string;
const queryOf = (req: Request) => req.query as Record<string, unknown>;
const requesterOf = (req: Request) => req.user.userId as string;

const send = (res: Response, message: string, data: unknown, statusCode: number = status.OK) =>
  sendResponse(res, { statusCode, success: true, message, data });

const sendList = (
  res: Response,
  { meta, notifications }: Awaited<ReturnType<typeof NotificationServices.getMyNotifications>>,
) =>
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Notifications retrieved successfully!",
    meta,
    data: notifications,
  });

const getMyNotifications = catchAsync(async (req: Request, res: Response) => {
  sendList(res, await NotificationServices.getMyNotifications(requesterOf(req), queryOf(req)));
});

const getFarmNotifications = catchAsync(async (req: Request, res: Response) => {
  sendList(res, await NotificationServices.getFarmNotifications(param(req, "farmId"), requesterOf(req), queryOf(req)));
});

const getUnreadCount = catchAsync(async (req: Request, res: Response) => {
  send(res, "Unread count retrieved successfully!", await NotificationServices.getUnreadCount(requesterOf(req)));
});

const getNotification = catchAsync(async (req: Request, res: Response) => {
  send(
    res,
    "Notification retrieved successfully!",
    await NotificationServices.getNotification(param(req, "farmId"), requesterOf(req), param(req, "id")),
  );
});

const setRead = (isRead: boolean) =>
  catchAsync(async (req: Request, res: Response) => {
    send(
      res,
      `Notification marked as ${isRead ? "read" : "unread"}!`,
      await NotificationServices.setRead(param(req, "farmId"), requesterOf(req), param(req, "id"), isRead),
    );
  });

const markAllRead = catchAsync(async (req: Request, res: Response) => {
  send(res, "Notifications marked as read!", await NotificationServices.markAllRead(param(req, "farmId"), requesterOf(req)));
});

const archive = catchAsync(async (req: Request, res: Response) => {
  send(
    res,
    "Notification archived!",
    await NotificationServices.archive(param(req, "farmId"), requesterOf(req), param(req, "id"), auditContextFromRequest(req)),
  );
});

const announce = catchAsync(async (req: Request, res: Response) => {
  send(
    res,
    "Announcement sent!",
    await NotificationServices.announce(param(req, "farmId"), requesterOf(req), req.body, auditContextFromRequest(req)),
    status.CREATED,
  );
});

export const NotificationController = {
  getMyNotifications,
  getFarmNotifications,
  getUnreadCount,
  getNotification,
  markRead: setRead(true),
  markUnread: setRead(false),
  markAllRead,
  archive,
  announce,
};
