import z from "zod";
import {
  FeedFormulaPurposes,
  FeedFormulaSeasons,
  FeedFormulaStages,
} from "../feedFormula/feedFormula.constants.js";
import { FeedRecommendationStatuses } from "./feedRecommendation.constants.js";

// validateRequest discards the parsed result, so these schemas only reject bad
// requests early; feedRecommendation.services.ts re-parses every field it uses.
// Snapshot fields (inputSnapshot, recommendedItems, costs ...) are never accepted:
// the server always recalculates them from the live animal context.

const objectIdString = (field: string) =>
  z.string().regex(/^[a-f\d]{24}$/i, { message: `${field} must be a valid ObjectId` });

const nonNegative = (field: string) =>
  z.number({ message: `${field} must be a number` }).min(0, { message: `${field} cannot be negative` });

const generationBody = z
  .object({
    animalId: objectIdString("animalId"),
    //Mongo _id or formulaCode (FF-000001); omitted => best automatic match
    formulaId: z.string().trim().min(1).max(40).optional(),
    stage: z.enum(Object.values(FeedFormulaStages)).optional(),
    purpose: z.enum(Object.values(FeedFormulaPurposes)).optional(),
    season: z.enum(Object.values(FeedFormulaSeasons)).optional(),
    milkYield: nonNegative("milkYield").max(100).optional(),
    targetADG: nonNegative("targetADG").max(5).optional(),
    allowUnavailableIngredients: z.boolean().optional(),
  })
  .strict();

const previewValidation = z.object({ body: generationBody });

const createValidation = z.object({
  body: generationBody.extend({
    status: z.enum([FeedRecommendationStatuses.DRAFT, FeedRecommendationStatuses.CONFIRMED]).optional(),
  }),
});

const statusValidation = z.object({
  body: z
    .object({
      status: z.enum([FeedRecommendationStatuses.CONFIRMED, FeedRecommendationStatuses.REJECTED]),
      reason: z.string().trim().max(1000).optional(),
    })
    .strict()
    .refine((b) => b.status !== FeedRecommendationStatuses.REJECTED || !!b.reason, {
      message: "reason is required when rejecting a recommendation",
      path: ["reason"],
    }),
});

const reviewValidation = z.object({
  body: z
    .object({
      decision: z.enum([FeedRecommendationStatuses.EXPERT_APPROVED, FeedRecommendationStatuses.REJECTED]),
      reviewNote: z.string().trim().max(1000).optional(),
    })
    .strict()
    .refine((b) => b.decision !== FeedRecommendationStatuses.REJECTED || !!b.reviewNote, {
      message: "reviewNote is required when rejecting a recommendation",
      path: ["reviewNote"],
    }),
});

export const feedRecommendationValidations = {
  previewValidation,
  createValidation,
  statusValidation,
  reviewValidation,
};
