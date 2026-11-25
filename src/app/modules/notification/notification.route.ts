import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { NotificationController } from "./notification.controller.js";
import { notificationValidations } from "./notification.validation.js";

const member = auth(SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER);

/**
 * /api/v1/notifications — own rows of every farm the user can open.
 * There is no delete route: history is kept.
 */
const notificationRouter = express.Router();
notificationRouter.get("/", member, NotificationController.getMyNotifications);
notificationRouter.get("/unread-count", member, NotificationController.getUnreadCount);

/** /api/v1/farms/:farmId/notifications — farm access and roles are enforced in the service. */
const farmNotificationRouter = express.Router({ mergeParams: true });
farmNotificationRouter.get("/", member, NotificationController.getFarmNotifications);
//literal routes stay above /:id
farmNotificationRouter.patch("/read-all", member, NotificationController.markAllRead);
farmNotificationRouter.post(
  "/announcements",
  member,
  validateRequest(notificationValidations.announcementValidation),
  NotificationController.announce,
);
farmNotificationRouter.get("/:id", member, NotificationController.getNotification);
farmNotificationRouter.patch("/:id/read", member, NotificationController.markRead);
farmNotificationRouter.patch("/:id/unread", member, NotificationController.markUnread);
farmNotificationRouter.patch("/:id/archive", member, NotificationController.archive);

export { farmNotificationRouter, notificationRouter };
