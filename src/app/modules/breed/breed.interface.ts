import type {
  BreedCategories,
  BreedPurposes,
  ResistanceLevels,
  Temperaments,
} from "./breed.constants.js";

export type TBreedCategory = (typeof BreedCategories)[keyof typeof BreedCategories];
export type TBreedPurpose = (typeof BreedPurposes)[keyof typeof BreedPurposes];
export type TResistanceLevel = (typeof ResistanceLevels)[keyof typeof ResistanceLevels];
export type TTemperament = (typeof Temperaments)[keyof typeof Temperaments];

export type TBreed = {
  breedCode: string;
  breedName: string;
  origin: string;
  category: TBreedCategory;
  purpose: TBreedPurpose;
  averageMilkPerDay?: number;
  averageAdultWeight?: number;
  averageDailyFeed?: number;
  heatTolerance?: TResistanceLevel;
  temperament?: TTemperament;
  colorPattern?: string;
  image?: string;
  diseaseResistance?: TResistanceLevel;
  isNative: boolean;
  description?: string;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
};
