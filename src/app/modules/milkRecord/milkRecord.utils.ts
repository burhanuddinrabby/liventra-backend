import mongoose, { Types } from "mongoose";
import { DAY_MS, dayKey, round } from "../feedRecord/feedRecord.utils.js";
import { MILK_UNIT_TO_LITERS } from "./milkRecord.constants.js";
import type { TMilkWithdrawalDetail } from "./milkRecord.interface.js";

// Generic parsing helpers (isBlank, parseEnum, parseNumber, parseCalendarDate, paging…)
// are shared with the FeedRecord module so both production/feeding logs behave alike.
export {
  DAY_MS,
  dayKey,
  escapeRegex,
  isBlank,
  pageMeta,
  parseBoolean,
  parseCalendarDate,
  parseDateRange,
  parseEnum,
  parseEnumList,
  parseNumber,
  parseObjectId,
  parsePaging,
  parseText,
  round,
} from "../feedRecord/feedRecord.utils.js";
export type { TPayload } from "../feedRecord/feedRecord.utils.js";

/** Centralized unit normalization (spec §13): every total is in liters. */
export const toLiters = (quantity: number, unit: string): number =>
  round(quantity * (MILK_UNIT_TO_LITERS[unit] ?? 1), 4);

//"5 days", "5", 5 → 5 ; anything unparseable → null
const parseDays = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const match = /(\d+(?:\.\d+)?)/.exec(String(value ?? ""));
  return match ? Number(match[1]) : null;
};

/**
 * Medicine milk-withdrawal check (Medicine rule: "Milk Sale Warning will be shown if
 * Withdrawal Period comes").
 *
 * The Treatment (Model 16) and Medicine (Model 15) modules are not built yet, so this
 * reads their collections directly using the final-schema field names:
 *   treatments: { farmId, animalId, treatmentNo, status, diagnosisDate, completedDate,
 *                 medicines: [{ medicineId, duration }] }
 *   medicines:  { medicineName, withdrawalPeriodDays }
 * When the collections do not exist (today) it simply returns no restriction. Once the
 * Health modules land, swap the raw reads for their models — the contract stays the same.
 *
 * Window per medicine: last dose day = completedDate, else diagnosisDate + duration days,
 * and an Ongoing treatment is treated as still dosing on `onDate`. Milk is restricted
 * through lastDose + withdrawalPeriodDays.
 */
export const findActiveWithdrawals = async (
  farmObjectId: Types.ObjectId,
  animalObjectId: Types.ObjectId,
  onDate: Date,
): Promise<TMilkWithdrawalDetail[]> => {
  try {
    const db = mongoose.connection.db;
    if (!db) return [];
    const names = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
    if (!names.has("treatments") || !names.has("medicines")) return [];

    //only treatments that started on/before the milking day and within a sane look-back
    const lookBack = new Date(onDate.getTime() - 180 * DAY_MS);
    const treatments = await db
      .collection("treatments")
      .find({
        farmId: farmObjectId,
        animalId: animalObjectId,
        status: { $ne: "Cancelled" },
        diagnosisDate: { $lte: new Date(onDate.getTime() + DAY_MS - 1), $gte: lookBack },
      })
      .project({ treatmentNo: 1, status: 1, diagnosisDate: 1, completedDate: 1, medicines: 1 })
      .limit(50)
      .toArray();
    if (!treatments.length) return [];

    const medicineIds = treatments.flatMap((t) =>
      (Array.isArray(t.medicines) ? t.medicines : [])
        .map((m: { medicineId?: unknown }) => m?.medicineId)
        .filter((id: unknown): id is Types.ObjectId => id instanceof Types.ObjectId),
    );
    if (!medicineIds.length) return [];
    const medicines = await db
      .collection("medicines")
      .find({ _id: { $in: medicineIds } })
      .project({ medicineName: 1, withdrawalPeriodDays: 1 })
      .toArray();
    const medicineOf = new Map(medicines.map((m) => [String(m._id), m]));

    const day = new Date(dayKey(onDate)).getTime();
    const hits: TMilkWithdrawalDetail[] = [];
    for (const treatment of treatments) {
      const started = treatment.diagnosisDate ? new Date(dayKey(treatment.diagnosisDate)).getTime() : null;
      if (started === null) continue;
      for (const line of Array.isArray(treatment.medicines) ? treatment.medicines : []) {
        const medicine = medicineOf.get(String(line?.medicineId));
        const withdrawalDays = parseDays(medicine?.withdrawalPeriodDays);
        if (!medicine || !withdrawalDays || withdrawalDays <= 0) continue;

        let lastDose: number;
        if (treatment.completedDate) lastDose = new Date(dayKey(treatment.completedDate)).getTime();
        else if (treatment.status === "Ongoing") lastDose = Math.max(day, started);
        else lastDose = started + Math.max((parseDays(line?.duration) ?? 1) - 1, 0) * DAY_MS;

        const until = lastDose + withdrawalDays * DAY_MS;
        if (day >= started && day <= until) {
          hits.push({
            treatmentId: treatment._id as Types.ObjectId,
            treatmentNo: (treatment.treatmentNo as string | undefined) ?? null,
            medicineName: String(medicine.medicineName ?? "Medicine"),
            withdrawalPeriodDays: withdrawalDays,
            //an ongoing treatment has no fixed end yet
            withdrawalUntil: treatment.status === "Ongoing" && !treatment.completedDate ? null : new Date(until),
          });
        }
      }
    }
    return hits;
  } catch (error) {
    //a failed safety lookup must not block milk logging; it is reported in the console
    console.error("Milk withdrawal check failed:", error);
    return [];
  }
};

export const withdrawalWarning = (details: TMilkWithdrawalDetail[]): string | null => {
  if (!details.length) return null;
  const list = details
    .map((d) => `${d.medicineName}${d.withdrawalUntil ? ` (until ${dayKey(d.withdrawalUntil)})` : " (treatment ongoing)"}`)
    .join(", ");
  return `MILK WITHDRAWAL: this animal is inside a medicine withdrawal period — ${list}. Do not mix this milk into salable stock; it is flagged as not sale-eligible.`;
};
