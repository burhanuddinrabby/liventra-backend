import config from "../../config/index.js";
import { DAY_MS } from "../feedRecord/feedRecord.utils.js";
import {
  BATTERY_CRITICAL,
  BATTERY_LOW,
  BatteryStates,
  WARRANTY_SOON_DAYS,
  WarrantyStates,
} from "./device.constants.js";
import type { TDevice } from "./device.interface.js";

/** Today's calendar day in APP_TIMEZONE, as UTC midnight (how date-only fields are stored). */
export const appToday = (): Date =>
  new Date(
    `${new Intl.DateTimeFormat("en-CA", {
      timeZone: config.app_timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date())}T00:00:00.000Z`,
  );

/** The last day of "Expiring". */
export const warrantyLimit = (today: Date): Date => new Date(today.getTime() + WARRANTY_SOON_DAYS * DAY_MS);

export const warrantyStateOf = (expiry: Date | null | undefined, today: Date) => {
  if (!expiry) return WarrantyStates.UNKNOWN;
  if (expiry < today) return WarrantyStates.EXPIRED;
  return expiry <= warrantyLimit(today) ? WarrantyStates.EXPIRING : WarrantyStates.ACTIVE;
};

export const batteryStateOf = (level: number | null | undefined) => {
  if (level === null || level === undefined) return BatteryStates.UNKNOWN;
  if (level <= BATTERY_CRITICAL) return BatteryStates.CRITICAL;
  return level <= BATTERY_LOW ? BatteryStates.LOW : BatteryStates.NORMAL;
};

export const withDerived = <T extends Pick<TDevice, "warrantyExpiry" | "batteryLevel">>(device: T, today = appToday()) => ({
  ...device,
  warrantyState: warrantyStateOf(device.warrantyExpiry, today),
  warrantyDaysLeft: device.warrantyExpiry
    ? Math.round((device.warrantyExpiry.getTime() - today.getTime()) / DAY_MS)
    : null,
  batteryState: batteryStateOf(device.batteryLevel),
});
