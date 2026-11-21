import type { Types } from "mongoose";
import type {
  FeedIngredientCategories,
  FeedIngredientUnits,
} from "./feedIngredient.constants.js";

export type TFeedIngredientUnit = (typeof FeedIngredientUnits)[keyof typeof FeedIngredientUnits];
export type TFeedIngredientCategory =
  (typeof FeedIngredientCategories)[keyof typeof FeedIngredientCategories];

export type TFeedIngredient = {
  ingredientName: string;
  //generated ING-00001, immutable
  ingredientCode: string;
  unit: TFeedIngredientUnit;
  category: TFeedIngredientCategory;
  //reference nutrition values (%, energy in Mcal/kg) — not animal-specific
  dryMatterPercentage: number;
  crudeProtein: number;
  crudeFiber: number;
  energy: number;
  calcium?: number;
  phosphorus?: number;
  //current/reference price per `unit` (BDT); history lives in FeedRecord snapshots
  pricePerUnit: number;
  //reference quantity available (not a stock ledger — Inventory owns farm stock)
  availability?: number;
  //Supplier collection is not finalized yet; stored as a plain reference
  supplierId?: Types.ObjectId;
  description?: string;
  //temporary operational availability (out of market / stock)
  isAvailable: boolean;
  //master-catalog lifecycle; false = retired (soft delete)
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
};

export type TIngredientUsage = {
  feedFormulas: number;
  feedRecommendations: number;
  feedRecords: number;
  inventories: number;
  total: number;
};
