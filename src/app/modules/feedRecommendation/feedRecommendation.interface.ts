import type { Types } from "mongoose";
import type { FeedRecommendationStatuses } from "./feedRecommendation.constants.js";

export type TFeedRecommendationStatus =
  (typeof FeedRecommendationStatuses)[keyof typeof FeedRecommendationStatuses];

/** Animal + rule context frozen at generation time (never recalculated). */
export type TInputSnapshot = {
  //age in completed months from birthDate (null when birthDate is unknown)
  age: number | null;
  currentWeight: number | null; //kg
  stage: string; //FeedFormula stage
  purpose: string; //FeedFormula purpose
  healthStatus: string;
  reproductiveStatus: string;
  milkYield: number | null; //L/day
  targetADG: number | null; //kg/day
  season: string;
};

export type TRecommendedItem = {
  ingredientId: Types.ObjectId;
  //snapshot of FeedIngredient.ingredientName at generation time
  ingredientName: string;
  quantity: number;
  unit: string;
  //snapshot cost (BDT/day) with the ingredient price at generation time
  estimatedCost: number;
};

export type TFeedRecommendation = {
  //REC-2026-000001, generated and immutable
  recommendationNo: string;
  farmId: Types.ObjectId;
  animalId: Types.ObjectId;
  formulaId?: Types.ObjectId | null;
  generatedAt: Date;
  inputSnapshot: TInputSnapshot;
  recommendedItems: TRecommendedItem[];
  totalRecommendedDMI: number; //kg DM/day
  estimatedDailyCost: number; //BDT/day
  explanation: string[];
  warnings: string[];
  ruleVersion: string;
  status: TFeedRecommendationStatus;
  //FarmMember who reviewed (expert review or rejection)
  reviewedBy?: Types.ObjectId | null;
  reviewedAt?: Date | null;
  //reason given on rejection / note left by the reviewer (extension, audited)
  statusReason?: string;
  reviewNote?: string;
  //set when a newer recommendation replaced this one
  supersededBy?: Types.ObjectId | null;
  supersededAt?: Date | null;
  //FarmMember who generated the record
  createdBy: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
};
