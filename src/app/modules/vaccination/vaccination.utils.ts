import { VaccinationCounterModel } from "./vaccination.model.js";
import { VACCINATION_NO_PREFIX } from "./vaccination.constants.js";

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Next vaccinationNo, e.g. VACLOG-2026-000001. Atomic per-year counter, so concurrent
 * creates never share a number. Runs outside any transaction on purpose (a counter
 * write conflict must not abort the business transaction); gaps are harmless.
 */
export const generateVaccinationNo = async (now: Date = new Date()): Promise<string> => {
  const year = now.getFullYear();
  const counter = await VaccinationCounterModel.findOneAndUpdate(
    { _id: `vaccination-${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  return `${VACCINATION_NO_PREFIX}-${year}-${String(counter?.seq ?? 1).padStart(6, "0")}`;
};

//UTC midnight of today (all vaccination dates are stored as calendar days)
export const startOfTodayUtc = (now: Date = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

//whole months between birth and `at` (used for the Vaccine.minimumAge check)
export const ageInMonths = (birthDate: Date | null | undefined, at: Date): number | null => {
  if (!birthDate) return null;
  const birth = new Date(birthDate);
  if (Number.isNaN(birth.getTime()) || birth > at) return null;
  let months = (at.getUTCFullYear() - birth.getUTCFullYear()) * 12 + (at.getUTCMonth() - birth.getUTCMonth());
  if (at.getUTCDate() < birth.getUTCDate()) months -= 1;
  return Math.max(0, months);
};

export type TDoseStage = "Primary" | "Booster" | "Repeat";

type TScheduleRule = {
  boosterRequired?: boolean;
  boosterAfterDays?: number | null;
  repeatIntervalDays?: number | null;
};

/**
 * Stage-aware next due date (spec §15–16: never blindly add booster + repeat).
 *   dose 1 + boosterRequired  → booster due after boosterAfterDays
 *   otherwise                 → repeat due after repeatIntervalDays
 *   no repeat interval (or 0) → null (one-time / no further dose — final schema rule)
 * `priorCompletedDoses` = Completed doses of the same vaccine for the same animal
 * administered before this one.
 */
export const computeNextDue = (vaccine: TScheduleRule, administeredDate: Date, priorCompletedDoses: number) => {
  const boosterPending = !!vaccine.boosterRequired && !!vaccine.boosterAfterDays && priorCompletedDoses === 0;
  let stage: TDoseStage = "Primary";
  if (priorCompletedDoses > 0) stage = vaccine.boosterRequired && priorCompletedDoses === 1 ? "Booster" : "Repeat";

  if (boosterPending) {
    return {
      stage,
      nextDueDate: addDays(administeredDate, vaccine.boosterAfterDays as number),
      nextDoseType: "Booster" as const,
    };
  }
  if (vaccine.repeatIntervalDays && vaccine.repeatIntervalDays > 0) {
    return {
      stage,
      nextDueDate: addDays(administeredDate, vaccine.repeatIntervalDays),
      nextDoseType: "Repeat" as const,
    };
  }
  return { stage, nextDueDate: null, nextDoseType: null };
};

/**
 * Default stock used by one dose, in the inventory row's unit: the Vaccine master
 * dosage when the units match (e.g. 2 ml from an ml stock), otherwise one unit
 * (one dose / vial / piece). A client may send quantityUsed to override it.
 */
export const defaultDoseQuantity = (
  vaccine: { dosage?: number; dosageUnit?: string },
  inventoryUnit: string | null | undefined,
): number => {
  if (inventoryUnit && vaccine.dosageUnit && inventoryUnit === vaccine.dosageUnit && vaccine.dosage) {
    return vaccine.dosage;
  }
  return 1;
};
