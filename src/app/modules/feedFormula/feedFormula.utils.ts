import { FeedFormulaModel } from "./feedFormula.model.js";
import { FEED_FORMULA_CODE_PREFIX, UnitConversions } from "./feedFormula.constants.js";

//example: FF-000001. Last-row+1 and non-atomic: the unique index is the real guard,
//so the service retries on a duplicate formulaCode.
export const generateFormulaCode = async (): Promise<string> => {
  const lastFormula = await FeedFormulaModel.findOne({}, { formulaCode: 1, _id: 0 })
    .sort({ createdAt: -1, _id: -1 })
    .lean();
  const currentNumber = Number(lastFormula?.formulaCode?.split("-")[1] ?? 0);
  const nextNumber = Number.isFinite(currentNumber) ? currentNumber + 1 : 1;

  return `${FEED_FORMULA_CODE_PREFIX}-${String(nextNumber).padStart(6, "0")}`;
};

export const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const round = (value: number, digits = 3): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

type TUnit = keyof typeof UnitConversions;

const isUnit = (unit: string): unit is TUnit => unit in UnitConversions;

//true when `from` can be converted into `to` (same physical dimension)
export const unitsCompatible = (from: string, to: string): boolean =>
  isUnit(from) && isUnit(to) && UnitConversions[from].dimension === UnitConversions[to].dimension;

//converts `quantity` expressed in `from` into `to`; caller checks compatibility first
export const convertQuantity = (quantity: number, from: string, to: string): number => {
  if (!isUnit(from) || !isUnit(to)) return quantity;
  return (quantity * UnitConversions[from].toBase) / UnitConversions[to].toBase;
};

//as-fed mass in kg (volumes at 1 kg/L); null for countable units
export const toKilograms = (quantity: number, unit: string): number | null => {
  if (!isUnit(unit)) return null;
  const conversion = UnitConversions[unit];
  if (conversion.dimension === "count") return null;
  return quantity * conversion.toBase;
};

/**
 * Natural compare of rule versions so v1.10 > v1.9 and v2.0 > v1.9.
 * Non-numeric parts compare as strings.
 */
export const compareRuleVersions = (a: string, b: string): number =>
  a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

/**
 * Next rule version for clone/versioning:
 *  - "v1.0" → "v1.1" (minor) / "v2.0" (major); "v1" behaves like "v1.0"
 *  - counter style "FEED-RULE-2026-01" → "FEED-RULE-2026-02" (padding kept)
 *  - anything else gets ".1" appended
 */
export const bumpRuleVersion = (version: string, kind: "minor" | "major" = "minor"): string => {
  const dotted = /^(.*?)(\d+)\.(\d+)$/.exec(version);
  if (dotted) {
    const [, prefix = "", major = "0", minor = "0"] = dotted;
    return kind === "major"
      ? `${prefix}${Number(major) + 1}.0`
      : `${prefix}${major}.${Number(minor) + 1}`;
  }
  const counter = /^(.*?)(\d+)$/.exec(version);
  if (counter) {
    const [, prefix = "", digits = "0"] = counter;
    //separator before the number → sequence counter; otherwise "v1" = major 1
    if (/[-_]$/.test(prefix)) return `${prefix}${String(Number(digits) + 1).padStart(digits.length, "0")}`;
    return kind === "major" ? `${prefix}${Number(digits) + 1}.0` : `${prefix}${digits}.1`;
  }
  return `${version}.1`;
};
