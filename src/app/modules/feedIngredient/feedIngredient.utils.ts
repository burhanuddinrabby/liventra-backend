import { FeedIngredientModel } from "./feedIngredient.model.js";
import { FEED_INGREDIENT_CODE_PREFIX } from "./feedIngredient.constants.js";

//example: ING-00001. Last-row+1 and non-atomic: the unique index is the real guard,
//so createIngredient retries on a duplicate ingredientCode.
export const generateIngredientCode = async (): Promise<string> => {
  const lastIngredient = await FeedIngredientModel.findOne({}, { ingredientCode: 1, _id: 0 })
    .sort({ createdAt: -1, _id: -1 })
    .lean();
  const currentNumber = Number(lastIngredient?.ingredientCode?.split("-")[1] ?? 0);
  const nextNumber = Number.isFinite(currentNumber) ? currentNumber + 1 : 1;

  return `${FEED_INGREDIENT_CODE_PREFIX}-${String(nextNumber).padStart(5, "0")}`;
};

export const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

//collapse inner whitespace so "Rice   Bran" is stored as "Rice Bran"
export const normalizeIngredientName = (value: string): string =>
  value.trim().replace(/\s+/g, " ");

//whitespace and common punctuation ignored when comparing names
const NAME_SEPARATORS = /[\s\-_.,/()'"&+]/g;
const SEPARATOR_CLASS = "[\\s\\-_.,/()'\"&+]*";

/**
 * Matches names that differ only by case, spacing or punctuation, so
 * "RiceBran", "rice bran" and "Rice-Bran" are treated as the same ingredient.
 * Plain `i` flag only (no `\p{..}` / `u`), so MongoDB evaluates it the same way.
 * Returns null when the name is nothing but separators.
 */
export const variantNameRegex = (name: string): RegExp | null => {
  const compact = name.toLowerCase().replace(NAME_SEPARATORS, "");
  if (!compact) return null;
  const pattern = Array.from(compact).map(escapeRegex).join(SEPARATOR_CLASS);
  return new RegExp(`^${SEPARATOR_CLASS}${pattern}${SEPARATOR_CLASS}$`, "i");
};
