import type { Types } from "mongoose";
import type {
  FeedFormulaPurposes,
  FeedFormulaSeasons,
  FeedFormulaStages,
} from "./feedFormula.constants.js";
import type { TFeedIngredientUnit } from "../feedIngredient/feedIngredient.interface.js";

export type TFeedFormulaStage = (typeof FeedFormulaStages)[keyof typeof FeedFormulaStages];
export type TFeedFormulaPurpose = (typeof FeedFormulaPurposes)[keyof typeof FeedFormulaPurposes];
export type TFeedFormulaSeason = (typeof FeedFormulaSeasons)[keyof typeof FeedFormulaSeasons];

export type TRange = {
  min?: number;
  max?: number;
};

export type TFormulaIngredient = {
  ingredientId: Types.ObjectId;
  //share of the total as-fed mix (%); all lines sum to 100
  percentage: number;
  //prescribed amount per animal per day under the formula's feeding basis
  quantity: number;
  unit: TFeedIngredientUnit;
};

export type TExpectedNutrition = {
  dryMatter: number; //kg DM/day
  crudeProtein: number; //% of DM
  energy: number; //Mcal/kg DM
};

export type TFeedFormula = {
  //generated FF-000001, immutable
  formulaCode: string;
  formulaName: string;
  breedId: Types.ObjectId;
  stage: TFeedFormulaStage;
  purpose: TFeedFormulaPurpose;
  season: TFeedFormulaSeason;
  targetWeightRange?: TRange; //kg
  targetMilkYield?: TRange; //L/day
  targetADG?: number; //kg/day
  ingredients: TFormulaIngredient[];
  //calculated by the server from FeedIngredient master data at save time
  expectedNutrition: TExpectedNutrition;
  estimatedDailyCost: number; //BDT/day at save time (snapshot)
  ruleVersion: string;
  description?: string;
  //at most one active default per exact (breedId, stage, purpose, season)
  isDefault: boolean;
  //false = retired (soft delete); never used for new recommendations
  isActive: boolean;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
};

export type TFormulaUsage = {
  feedRecommendations: number;
  total: number;
};
