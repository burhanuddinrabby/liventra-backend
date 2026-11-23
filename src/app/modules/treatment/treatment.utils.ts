import { DAY_MS, dayKey } from "../feedRecord/feedRecord.utils.js";
import { TREATMENT_NO_PREFIX, TreatmentStatuses } from "./treatment.constants.js";
import { TreatmentCounterModel } from "./treatment.model.js";

export { DAY_MS, dayKey };

/**
 * Next treatmentNo, e.g. TRT-2026-000001. Atomic per-year counter, so concurrent
 * creates never share a number. Runs outside any transaction on purpose (a counter
 * write conflict must not abort the business transaction); gaps are harmless.
 */
export const generateTreatmentNo = async (now: Date = new Date()): Promise<string> => {
  const year = now.getFullYear();
  const counter = await TreatmentCounterModel.findOneAndUpdate(
    { _id: `treatment-${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  return `${TREATMENT_NO_PREFIX}-${year}-${String(counter?.seq ?? 1).padStart(6, "0")}`;
};

//UTC midnight of today (all treatment dates are stored as calendar days)
export const startOfTodayUtc = (now: Date = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

//whole days between two calendar days (b - a)
export const daysBetween = (a: Date, b: Date) =>
  Math.round((new Date(dayKey(b)).getTime() - new Date(dayKey(a)).getTime()) / DAY_MS);

/**
 * Free-text duration → whole days ("5 days" → 5, "2 weeks" → 14, "1 month" → 30,
 * "36 hours" → 2, "Single dose" → 1). Unparseable text ("Until follow-up",
 * "As directed") → null, and the caller falls back to the follow-up / today.
 */
export const parseDurationDays = (value: unknown): number | null => {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (/single|once only|one[- ]time|stat/.test(text)) return 1;
  const match = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|m|mo|month|months)?/.exec(text);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = match[2] ?? "d";
  if (unit.startsWith("h")) return Math.max(1, Math.ceil(n / 24));
  if (unit.startsWith("w")) return Math.ceil(n * 7);
  if (unit === "m" || unit.startsWith("mo")) return Math.ceil(n * 30);
  return Math.ceil(n);
};

export type TWithdrawalTreatment = {
  _id: unknown;
  treatmentNo: string;
  status: string;
  diagnosisDate: Date;
  completedDate?: Date | null;
  followUpDate?: Date | null;
  medicines: { medicineId: unknown; duration?: string; administrationRoute?: string }[];
};

export type TWithdrawalMedicine = {
  _id: unknown;
  medicineCode?: string;
  medicineName?: string;
  withdrawalPeriodDays?: number;
};

export type TWithdrawalLine = {
  treatmentId: unknown;
  treatmentNo: string;
  treatmentStatus: string;
  medicineId: unknown;
  medicineCode: string | null;
  medicineName: string;
  withdrawalPeriodDays: number;
  //last (expected) administration day used for the window
  lastDoseDate: Date;
  //lastDose + withdrawalPeriodDays; for an Ongoing course this is the EARLIEST possible end
  withdrawalEndDate: Date;
  //true while the course is still running — the end keeps moving forward
  provisional: boolean;
  daysRemaining: number;
};

/**
 * Derived withdrawal safety (spec §78–80): for every non-cancelled treatment line whose
 * Medicine has a withdrawal period, last dose day =
 *   completedDate (Recovered) → diagnosisDate + duration − 1 → still Ongoing ⇒ max(that, today)
 * and the restriction runs through lastDose + withdrawalPeriodDays.
 * The animal-level restriction is the conservative maximum of all active lines.
 * Nothing is stored — the Treatment model has no withdrawalEndDate field.
 */
export const computeWithdrawals = (
  treatments: TWithdrawalTreatment[],
  medicineOf: Map<string, TWithdrawalMedicine>,
  today: Date = startOfTodayUtc(),
) => {
  const lines: TWithdrawalLine[] = [];
  for (const t of treatments) {
    if (t.status === TreatmentStatuses.CANCELLED) continue;
    const start = new Date(dayKey(t.diagnosisDate));
    const stillRunning = t.status === TreatmentStatuses.ONGOING;
    for (const line of t.medicines ?? []) {
      const medicine = medicineOf.get(String(line.medicineId));
      const days = Number(medicine?.withdrawalPeriodDays ?? 0);
      if (!medicine || !Number.isFinite(days) || days <= 0) continue;

      const courseDays = parseDurationDays(line.duration);
      let lastDose: Date;
      if (t.completedDate) lastDose = new Date(dayKey(t.completedDate));
      else if (courseDays) lastDose = addDays(start, courseDays - 1);
      else if (t.followUpDate) lastDose = new Date(dayKey(t.followUpDate));
      else lastDose = start;
      //a course that is still running cannot have ended before today
      if (stillRunning && lastDose < today) lastDose = today;
      //a completed course never runs past its completion
      if (t.completedDate && lastDose > new Date(dayKey(t.completedDate))) lastDose = new Date(dayKey(t.completedDate));

      const end = addDays(lastDose, days);
      if (end < today) continue;
      lines.push({
        treatmentId: t._id,
        treatmentNo: t.treatmentNo,
        treatmentStatus: t.status,
        medicineId: medicine._id,
        medicineCode: medicine.medicineCode ?? null,
        medicineName: medicine.medicineName ?? "Medicine",
        withdrawalPeriodDays: days,
        lastDoseDate: lastDose,
        withdrawalEndDate: end,
        provisional: stillRunning,
        daysRemaining: daysBetween(today, end),
      });
    }
  }
  lines.sort((a, b) => b.withdrawalEndDate.getTime() - a.withdrawalEndDate.getTime());
  const top = lines[0];
  return {
    underWithdrawal: lines.length > 0,
    //conservative maximum across all active lines
    withdrawalEndDate: top?.withdrawalEndDate ?? null,
    daysRemaining: top?.daysRemaining ?? 0,
    provisional: lines.some((l) => l.provisional),
    //milk and meat use the same Medicine.withdrawalPeriodDays (the catalog has one field)
    restrictions: lines.length ? ["Milk", "Meat"] : [],
    lines,
  };
};
