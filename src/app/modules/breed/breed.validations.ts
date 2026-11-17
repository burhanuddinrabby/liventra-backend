import z from "zod";
import {
  BreedCategories,
  BreedPurposes,
  ResistanceLevels,
  Temperaments,
} from "./breed.constants.js";

//breedCode is system-generated, so it is intentionally absent from the create body
const createBreedValidation = z.object({
  body: z.object({
    breedName: z
      .string()
      .trim()
      .min(2, { message: "Breed name must be at least 2 characters" })
      .max(100),
    origin: z
      .string()
      .trim()
      .min(1, { message: "Origin is required" })
      .max(100),
    category: z.enum(Object.values(BreedCategories)),
    purpose: z.enum(Object.values(BreedPurposes)),
    averageMilkPerDay: z.number().min(0).optional(),
    averageAdultWeight: z.number().positive().optional(),
    averageDailyFeed: z.number().min(0).optional(),
    heatTolerance: z.enum(Object.values(ResistanceLevels)).optional(),
    temperament: z.enum(Object.values(Temperaments)).optional(),
    colorPattern: z.string().trim().max(100).optional(),
    image: z.string().trim().min(1).optional(),
    diseaseResistance: z.enum(Object.values(ResistanceLevels)).optional(),
    isNative: z.boolean().optional(),
    description: z.string().trim().max(2000).optional(),
    isActive: z.boolean().optional(),
  }),
});

const updateBreedValidation = z.object({
  body: createBreedValidation.shape.body.partial(),
});

const breedStatusValidation = z.object({
  body: z.object({
    isActive: z.boolean({ message: "isActive must be a boolean" }),
  }),
});

export const breedValidations = {
  createBreedValidation,
  updateBreedValidation,
  breedStatusValidation,
};
