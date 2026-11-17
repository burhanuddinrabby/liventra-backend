import { BreedModel } from "./breed.model.js";
import { BREED_CODE_PREFIX } from "./breed.constants.js";

//example: BREED-00001
const lastBreedNumber = async (): Promise<string> => {
  const lastBreed = await BreedModel.findOne({}, { breedCode: 1, _id: 0 })
    .sort({ createdAt: -1 })
    .lean();
  return lastBreed?.breedCode?.split("-")[1] || "00000";
};

export const generateBreedCode = async (): Promise<string> => {
  const currentCode = await lastBreedNumber();
  const currentNumber = Number(currentCode);
  const nextNumber = Number.isFinite(currentNumber) ? currentNumber + 1 : 1;

  return `${BREED_CODE_PREFIX}-${String(nextNumber).padStart(5, "0")}`;
};

//used for case-insensitive partial search on lookup/list queries
export const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
