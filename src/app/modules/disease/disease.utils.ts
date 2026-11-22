import { DiseaseModel } from "./disease.model.js";
import { DISEASE_CODE_PREFIX, DISEASE_NAME_STOP_WORDS } from "./disease.constants.js";

//example: DIS-00001. Last-row+1 and non-atomic: the unique index is the real guard,
//so createDisease retries on a duplicate diseaseCode.
export const generateDiseaseCode = async (): Promise<string> => {
  const last = await DiseaseModel.findOne({}, { diseaseCode: 1, _id: 0 })
    .sort({ createdAt: -1, _id: -1 })
    .lean();
  const currentNumber = Number(last?.diseaseCode?.split("-")[1] ?? 0);
  const nextNumber = Number.isFinite(currentNumber) ? currentNumber + 1 : 1;
  return `${DISEASE_CODE_PREFIX}-${String(nextNumber).padStart(5, "0")}`;
};

export const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

//collapse inner whitespace so "Foot  and Mouth" is stored as "Foot and Mouth"
export const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");

/**
 * Comparison key for duplicate detection (spec §10/§47): case-, punctuation- and
 * whitespace-insensitive, "&" ≡ "and". "Foot & Mouth-Disease" → "foot and mouth disease".
 */
export const nameKey = (value: string): string =>
  value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

//initials of the significant words: "Foot and Mouth Disease" → "fmd"
export const nameInitials = (value: string): string =>
  nameKey(value)
    .split(" ")
    .filter((word) => word && !DISEASE_NAME_STOP_WORDS.has(word))
    .map((word) => word[0])
    .join("");

/**
 * True when the two names are likely the same disease:
 *  - identical normalized key ("Foot & Mouth Disease" vs "foot and mouth disease")
 *  - one key is the other without a trailing "disease" ("Foot and Mouth")
 *  - a single-word name equals the other's initials ("FMD")
 */
export const isSimilarName = (a: string, b: string): "exact" | "similar" | null => {
  const ka = nameKey(a);
  const kb = nameKey(b);
  if (!ka || !kb) return null;
  if (ka === kb) return "exact";

  const strip = (k: string) => k.replace(/\s+disease$/, "");
  if (strip(ka) === strip(kb)) return "similar";

  const single = (k: string) => !k.includes(" ") && k.length >= 2;
  if (single(ka) && ka === nameInitials(b) && nameInitials(b).length >= 2) return "similar";
  if (single(kb) && kb === nameInitials(a) && nameInitials(a).length >= 2) return "similar";
  return null;
};

/**
 * Trims, collapses whitespace and de-duplicates (case-insensitively) a list of strings
 * while keeping the first spelling and the original order.
 */
export const cleanStringList = (values: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const text = normalizeText(raw);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
};
