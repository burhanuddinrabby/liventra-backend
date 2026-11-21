import type { Types } from "mongoose";
import { AnimalModel } from "./animal.model.js";
import { ANIMAL_CODE_PREFIX, ANIMAL_QR_PREFIX } from "./animal.constants.js";
import type { TAnimalAge } from "./animal.interface.js";

/**
 * Next per-farm animal code, e.g. AN-000001. Last-row+1 like the other generated ids,
 * so it is not atomic — the { farmId, animalCode } unique index is the real guard and
 * the service retries on duplicate key 11000.
 */
export const generateAnimalCode = async (
  farmObjectId: Types.ObjectId,
): Promise<string> => {
  const lastAnimal = await AnimalModel.findOne(
    { farmId: farmObjectId },
    { animalCode: 1, _id: 0 },
  )
    .sort({ createdAt: -1, _id: -1 })
    .lean();

  const lastNumber = Number(lastAnimal?.animalCode?.split("-")[1] ?? 0);
  const nextNumber = Number.isFinite(lastNumber) ? lastNumber + 1 : 1;

  return `${ANIMAL_CODE_PREFIX}-${String(nextNumber).padStart(6, "0")}`;
};

//system-wide unique and only carries public codes — no private farm data (spec §6.6)
export const generateAnimalQrCode = (
  farmCode: string,
  animalCode: string,
): string => `${ANIMAL_QR_PREFIX}-${farmCode}-${animalCode}`;

//used for case-insensitive partial search on list queries
export const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Age is derived from birthDate at read time so it can never go stale (spec §6.12). */
export const calculateAnimalAge = (
  birthDate?: Date | null,
  now: Date = new Date(),
): TAnimalAge | null => {
  if (!birthDate) return null;
  const birth = new Date(birthDate);
  if (Number.isNaN(birth.getTime()) || birth.getTime() > now.getTime()) {
    return null;
  }

  let years = now.getFullYear() - birth.getFullYear();
  let months = now.getMonth() - birth.getMonth();
  let days = now.getDate() - birth.getDate();

  if (days < 0) {
    months -= 1;
    //days in the month before `now`
    days += new Date(now.getFullYear(), now.getMonth(), 0).getDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }

  const totalDays = Math.floor(
    (now.getTime() - birth.getTime()) / (24 * 60 * 60 * 1000),
  );
  const totalMonths = years * 12 + months;

  const parts: string[] = [];
  if (years > 0) parts.push(`${years} year${years === 1 ? "" : "s"}`);
  if (months > 0) parts.push(`${months} month${months === 1 ? "" : "s"}`);
  if (years === 0 && (days > 0 || parts.length === 0)) {
    parts.push(`${days} day${days === 1 ? "" : "s"}`);
  }

  return {
    years,
    months,
    days,
    totalDays,
    totalMonths,
    label: parts.join(" "),
  };
};
