import { Types } from "mongoose";

//removed completely: secrets have no place in history
const SECRET_KEY = /password|passwd|otp$|token|secret|hash|rawpayload|authorization|cookie|apikey/i;
//the change is recorded, the value is not
const HIDDEN_KEYS = new Set(["salary", "nid"]);
export const HIDDEN_VALUE = "[hidden]";

const MAX_TEXT = 500;
const MAX_ITEMS = 50;
const MAX_DEPTH = 6;

const clean = (value: unknown, depth: number): unknown => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date || value instanceof Types.ObjectId) return value;
  if (typeof value !== "object" || Buffer.isBuffer(value)) return null;
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => clean(item, depth + 1));
    return value.length > MAX_ITEMS ? [...items, `… ${value.length - MAX_ITEMS} more`] : items;
  }
  if (value instanceof Map) return clean(Object.fromEntries(value), depth);
  const plain =
    typeof (value as { toObject?: unknown }).toObject === "function"
      ? (value as { toObject: () => Record<string, unknown> }).toObject()
      : (value as Record<string, unknown>);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(plain)) {
    if (key === "__v" || entry === undefined || SECRET_KEY.test(key)) continue;
    //also matches the dotted paths of diffForAudit
    const field = key.split(".").pop() ?? key;
    result[key] = HIDDEN_KEYS.has(field) && entry !== null ? HIDDEN_VALUE : clean(entry, depth + 1);
  }
  return result;
};

/** Safe copy of a snapshot: no secrets, no salary / NID values, bounded size. */
export const sanitizeForAudit = (
  data: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null => (data ? (clean(data, 0) as Record<string, unknown>) : null);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date) &&
  !(value instanceof Types.ObjectId);

const comparable = (value: unknown) => JSON.stringify(value ?? null);

/**
 * Changed paths of two snapshots (`location.shed`), with only those values. Compares the
 * raw values, so a salary change is listed although sanitizeForAudit hides the amount.
 */
export const diffForAudit = (before: Record<string, unknown>, after: Record<string, unknown>) => {
  const oldData: Record<string, unknown> = {};
  const newData: Record<string, unknown> = {};
  const changedFields: string[] = [];

  const walk = (a: Record<string, unknown>, b: Record<string, unknown>, prefix: string) => {
    for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const path = prefix ? `${prefix}.${field}` : field;
      const left = a[field];
      const right = b[field];
      if (isPlainObject(left) && isPlainObject(right)) {
        walk(left, right, path);
      } else if (comparable(left) !== comparable(right)) {
        changedFields.push(path);
        oldData[path] = left ?? null;
        newData[path] = right ?? null;
      }
    }
  };
  walk(before, after, "");
  return { oldData, newData, changedFields };
};
