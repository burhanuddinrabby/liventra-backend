import { VaccineModel } from "./vaccine.model.js";
import { VACCINE_CODE_PREFIX } from "./vaccine.constants.js";
import type { TVaccine } from "./vaccine.interface.js";

//example: VAC-00001. Last-row+1 and non-atomic: the unique index is the real guard,
//so createVaccine retries on a duplicate vaccineCode.
export const generateVaccineCode = async (): Promise<string> => {
  const lastVaccine = await VaccineModel.findOne({}, { vaccineCode: 1, _id: 0 })
    .sort({ createdAt: -1, _id: -1 })
    .lean();
  const currentNumber = Number(lastVaccine?.vaccineCode?.split("-")[1] ?? 0);
  const nextNumber = Number.isFinite(currentNumber) ? currentNumber + 1 : 1;

  return `${VACCINE_CODE_PREFIX}-${String(nextNumber).padStart(5, "0")}`;
};

export const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

//collapse inner whitespace so "FMD   Vaccine" is stored as "FMD Vaccine"
export const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");

const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

type TScheduleRule = Pick<
  TVaccine,
  "boosterRequired" | "boosterAfterDays" | "repeatIntervalDays" | "minimumAge"
>;

/**
 * Pure scheduling helper shared with the (future) Vaccination module.
 * Vaccine only holds the rules; the actual nextDueDate belongs to each Vaccination
 * record (spec §32), so nothing here is persisted.
 *
 * Dose flow: primary → (boosterAfterDays) → booster → (repeatIntervalDays) → repeat.
 * Without a booster the repeat interval runs from the primary dose.
 */
export const computeVaccineSchedule = (
  vaccine: TScheduleRule,
  administeredDate: Date,
  animalAgeMonths?: number,
) => {
  const boosterDueDate =
    vaccine.boosterRequired && vaccine.boosterAfterDays
      ? addDays(administeredDate, vaccine.boosterAfterDays)
      : null;
  const repeatBase = boosterDueDate ?? administeredDate;
  const repeatDueDate = vaccine.repeatIntervalDays
    ? addDays(repeatBase, vaccine.repeatIntervalDays)
    : null;

  //warning only — the final eligibility decision follows the veterinary protocol (spec §25)
  let ageCheck: { eligible: boolean; minimumAgeMonths: number; animalAgeMonths: number } | null =
    null;
  if (animalAgeMonths !== undefined && vaccine.minimumAge !== undefined) {
    ageCheck = {
      eligible: animalAgeMonths >= vaccine.minimumAge,
      minimumAgeMonths: vaccine.minimumAge,
      animalAgeMonths,
    };
  }

  return {
    administeredDate,
    boosterDueDate,
    repeatDueDate,
    //the date a Vaccination record should store as nextDueDate after this dose
    nextDueDate: boosterDueDate ?? repeatDueDate,
    ageCheck,
  };
};
