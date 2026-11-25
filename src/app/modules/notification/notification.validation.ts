import z from "zod";
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";
import { ANNOUNCEMENT_PRIORITIES, MAX_MESSAGE_LENGTH, MAX_TITLE_LENGTH } from "./notification.constants.js";

const announcementValidation = z.object({
  body: z.object({
    title: z.string().trim().min(1, { message: "Title is required" }).max(MAX_TITLE_LENGTH),
    message: z.string().trim().min(1, { message: "Message is required" }).max(MAX_MESSAGE_LENGTH),
    roles: z.array(z.enum(Object.values(FarmMemberRoles))).min(1, { message: "Choose at least one role" }),
    priority: z.enum(ANNOUNCEMENT_PRIORITIES).optional(),
    expiresAt: z.string().optional(),
  }),
});

export const notificationValidations = { announcementValidation };
