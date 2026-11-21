import z from "zod";
import { FeedIngredientUnits } from "../feedIngredient/feedIngredient.constants.js";
import {
  FeedFormulaPurposes,
  FeedFormulaSeasons,
  FeedFormulaStages,
} from "./feedFormula.constants.js";

// validateRequest discards the parsed result, so these schemas only reject bad
// requests early; feedFormula.services.ts re-whitelists, coerces and runs the
// scientific validation (ingredient lookup, percentages, units, calculations).

const nonNegative = (field: string) =>
  z.number({ message: `${field} must be a number` }).min(0, { message: `${field} cannot be negative` });

const objectIdString = (field: string) =>
  z.string().regex(/^[a-f\d]{24}$/i, { message: `${field} must be a valid ObjectId` });

const range = (field: string) =>
  z
    .object({
      min: nonNegative(`${field}.min`).optional(),
      max: nonNegative(`${field}.max`).optional(),
    })
    .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, {
      message: `${field}.min must be less than or equal to ${field}.max`,
    });

//ingredientId accepts the Mongo _id or the public ingredientCode (ING-00001)
const ingredientLine = z.object({
  ingredientId: z.string({ message: "ingredientId is required" }).trim().min(1),
  percentage: nonNegative("percentage").max(100, { message: "percentage cannot exceed 100" }).optional(),
  quantity: z.number({ message: "quantity must be a number" }).positive({ message: "quantity must be greater than 0" }),
  unit: z.enum(Object.values(FeedIngredientUnits)).optional(),
});

const ingredients = z.array(ingredientLine).min(1, { message: "At least one ingredient is required" }).max(50);

const ruleVersion = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/, {
    message: "ruleVersion must be 1-30 characters: letters, digits, '.', '_' or '-' (e.g. v1.0)",
  });

const scientificShape = {
  breedId: objectIdString("breedId"),
  stage: z.enum(Object.values(FeedFormulaStages)),
  purpose: z.enum(Object.values(FeedFormulaPurposes)),
  season: z.enum(Object.values(FeedFormulaSeasons)),
  targetWeightRange: range("targetWeightRange"),
  targetMilkYield: range("targetMilkYield"),
  targetADG: nonNegative("targetADG"),
  ingredients,
  ruleVersion,
};

//formulaCode, expectedNutrition, estimatedDailyCost, createdBy are system-owned
const createFeedFormulaValidation = z.object({
  body: z.object({
    formulaName: z.string({ message: "Formula name is required" }).trim().min(3).max(150),
    ...scientificShape,
    targetWeightRange: scientificShape.targetWeightRange.optional(),
    targetMilkYield: scientificShape.targetMilkYield.optional(),
    targetADG: scientificShape.targetADG.optional(),
    description: z.string().trim().max(2000).optional(),
    isDefault: z.boolean().optional(),
  }),
});

//any subset; null clears an optional field. Scientific changes may create a new version.
const updateFeedFormulaValidation = z.object({
  body: z.object({
    formulaName: z.string().trim().min(3).max(150).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    breedId: scientificShape.breedId.optional(),
    stage: scientificShape.stage.optional(),
    purpose: scientificShape.purpose.optional(),
    season: scientificShape.season.optional(),
    targetWeightRange: scientificShape.targetWeightRange.nullable().optional(),
    targetMilkYield: scientificShape.targetMilkYield.nullable().optional(),
    targetADG: scientificShape.targetADG.nullable().optional(),
    ingredients: ingredients.optional(),
    ruleVersion: ruleVersion.optional(),
    createNewVersion: z.boolean().optional(),
    retirePrevious: z.boolean().optional(),
  }),
});

const cloneVersionValidation = z.object({
  body: updateFeedFormulaValidation.shape.body
    .omit({ createNewVersion: true })
    .extend({
      bump: z.enum(["minor", "major"]).optional(),
      isDefault: z.boolean().optional(),
    })
    .optional(),
});

const previewValidation = z.object({
  body: z.object({ ingredients }),
});

//context matching; either animalId (+ farmId) or the explicit context fields
const matchValidation = z.object({
  body: z.object({
    farmId: z.string().trim().min(1).optional(),
    animalId: objectIdString("animalId").optional(),
    breedId: scientificShape.breedId.optional(),
    stage: scientificShape.stage.optional(),
    purpose: scientificShape.purpose.optional(),
    season: scientificShape.season.optional(),
    weight: nonNegative("weight").optional(),
    milkYield: nonNegative("milkYield").optional(),
    targetADG: nonNegative("targetADG").optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
});

const setDefaultValidation = z.object({
  body: z.object({ isDefault: z.boolean().optional() }).optional(),
});

//omitting isActive flips the current value
const toggleActiveValidation = z.object({
  body: z
    .object({
      isActive: z.boolean({ message: "isActive must be a boolean" }).optional(),
      reason: z.string().trim().max(500).optional(),
    })
    .optional(),
});

export const feedFormulaValidations = {
  createFeedFormulaValidation,
  updateFeedFormulaValidation,
  cloneVersionValidation,
  previewValidation,
  matchValidation,
  setDefaultValidation,
  toggleActiveValidation,
};
