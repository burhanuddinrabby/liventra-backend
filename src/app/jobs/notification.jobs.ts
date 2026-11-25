import { Types } from "mongoose";
import { InventoryServices } from "../modules/inventory/inventory.services.js";
import { NotificationProducers } from "../modules/notification/notification.producers.js";
import { forEachActiveFarm } from "./runJob.js";
import type { TJob } from "./scheduler.js";

const TTL_MS = 10 * 60 * 1000;

const idOf = (farm: { _id: unknown }) => new Types.ObjectId(String(farm._id));

export const notificationJobs: TJob[] = [
  {
    name: "notification.reminders",
    schedule: "0 * * * *",
    ttlMs: TTL_MS,
    work: () => forEachActiveFarm((farm) => NotificationProducers.remindFarm(idOf(farm))),
  },
  {
    name: "notification.expire",
    schedule: "5 * * * *",
    ttlMs: TTL_MS,
    work: NotificationProducers.expireDue,
  },
  {
    name: "inventory.sync",
    schedule: "15 0 * * *",
    ttlMs: TTL_MS,
    work: () => forEachActiveFarm((farm) => InventoryServices.refreshStatuses(idOf(farm))),
  },
];
