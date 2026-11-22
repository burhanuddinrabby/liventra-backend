import { MedicineModel } from "./medicine.model.js";
import { MEDICINE_CODE_PREFIX, MEDICINE_ROUTE_COMPATIBILITY } from "./medicine.constants.js";

//example: MED-00001. Last-row+1 and non-atomic: the unique index is the real guard,
//so createMedicine retries on a duplicate medicineCode.
export const generateMedicineCode = async (): Promise<string> => {
  const lastMedicine = await MedicineModel.findOne({}, { medicineCode: 1, _id: 0 })
    .sort({ createdAt: -1, _id: -1 })
    .lean();
  const currentNumber = Number(lastMedicine?.medicineCode?.split("-")[1] ?? 0);
  const nextNumber = Number.isFinite(currentNumber) ? currentNumber + 1 : 1;

  return `${MEDICINE_CODE_PREFIX}-${String(nextNumber).padStart(5, "0")}`;
};

export const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

//collapse inner whitespace so "Oxy   LA" is stored as "Oxy LA"
export const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");

/**
 * Comparison key for duplicate detection: case-, space- and punctuation-insensitive,
 * so "ACI Animal Health Ltd." ~ "aci animal-health ltd" and "200 mg/ml" ~ "200MG/ML".
 * "/", "%" and "." are kept because they change the meaning of a strength.
 */
export const identityKey = (value: unknown): string =>
  typeof value === "string"
    ? value
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/[^a-z0-9/%.]+/g, "")
        .replace(/\.$/, "")
    : "";

//strength must start with a number and carry a unit or percentage ("200 mg/ml", "10%",
//"5 IU/ml", "250 mg + 50 mg"). Rejects meaningless values such as "abc" (spec §76).
export const STRENGTH_PATTERN = /^\d+(?:[.,]\d+)?\s*(?:%|[A-Za-zµμ]+)/;

export const isRouteCompatible = (dosageForm: string, route: string): boolean =>
  (MEDICINE_ROUTE_COMPATIBILITY[dosageForm] ?? []).includes(route);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure withdrawal helper (spec §32/§90), reusable by MilkRecord / future Treatment:
 * withdrawal end = last applicable administration + withdrawalPeriodDays.
 * Nothing is stored on Medicine — the animal-specific status belongs to Treatment.
 */
export const computeWithdrawalWindow = (
  withdrawalPeriodDays: number,
  lastAdministeredDate: Date,
  now = new Date(),
) => {
  const withdrawalEndDate = new Date(
    lastAdministeredDate.getTime() + withdrawalPeriodDays * DAY_MS,
  );
  const remainingMs = withdrawalEndDate.getTime() - now.getTime();
  return {
    lastAdministeredDate,
    withdrawalPeriodDays,
    withdrawalEndDate,
    withdrawalActive: withdrawalPeriodDays > 0 && remainingMs > 0,
    remainingDays: remainingMs > 0 ? Math.ceil(remainingMs / DAY_MS) : 0,
  };
};
