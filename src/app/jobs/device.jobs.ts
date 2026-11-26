import { Types } from "mongoose";
import { DeviceServices } from "../modules/device/device.services.js";
import { forEachActiveFarm } from "./runJob.js";
import type { TJob } from "./scheduler.js";

const TTL_MS = 10 * 60 * 1000;

const idOf = (farm: { _id: unknown }) => new Types.ObjectId(String(farm._id));

export const deviceJobs: TJob[] = [
  {
    name: "device.connectivity",
    schedule: "10 * * * *",
    ttlMs: TTL_MS,
    work: () => forEachActiveFarm((farm) => DeviceServices.checkFarmConnectivity(idOf(farm))),
  },
  {
    name: "device.warranty",
    schedule: "20 0 * * *",
    ttlMs: TTL_MS,
    work: () => forEachActiveFarm((farm) => DeviceServices.checkFarmWarranties(idOf(farm))),
  },
];
