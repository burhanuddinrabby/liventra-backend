import { model, Schema } from "mongoose";
import { FeedRecommendationStatuses } from "./feedRecommendation.constants.js";
import type {
  TFeedRecommendation,
  TInputSnapshot,
  TRecommendedItem,
} from "./feedRecommendation.interface.js";

// A saved recommendation is a historical snapshot (spec §4–5): every generated
// field is `immutable`, so only the controlled status/review metadata can change.

const inputSnapshotSchema = new Schema<TInputSnapshot>(
  {
    age: { type: Number, min: 0, default: null },
    currentWeight: { type: Number, min: 0, default: null },
    stage: { type: String, required: true, trim: true },
    purpose: { type: String, required: true, trim: true },
    healthStatus: { type: String, required: true, trim: true },
    reproductiveStatus: { type: String, required: true, trim: true },
    milkYield: { type: Number, min: 0, default: null },
    targetADG: { type: Number, min: 0, default: null },
    season: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const recommendedItemSchema = new Schema<TRecommendedItem>(
  {
    ingredientId: { type: Schema.Types.ObjectId, ref: "FeedIngredient", required: true },
    ingredientName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, required: true, trim: true },
    estimatedCost: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const feedRecommendationSchema = new Schema<TFeedRecommendation>(
  {
    recommendationNo: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      trim: true,
      uppercase: true,
    },
    farmId: { type: Schema.Types.ObjectId, ref: "Farm", required: true, immutable: true },
    animalId: { type: Schema.Types.ObjectId, ref: "Animal", required: true, immutable: true },
    formulaId: { type: Schema.Types.ObjectId, ref: "FeedFormula", default: null, immutable: true },
    generatedAt: { type: Date, required: true, immutable: true },
    inputSnapshot: { type: inputSnapshotSchema, required: true, immutable: true },
    recommendedItems: {
      type: [recommendedItemSchema],
      immutable: true,
      validate: {
        validator: (value: unknown[]) => Array.isArray(value) && value.length > 0,
        message: "A recommendation needs at least one item",
      },
    },
    totalRecommendedDMI: { type: Number, required: true, min: 0, immutable: true },
    estimatedDailyCost: { type: Number, required: true, min: 0, immutable: true },
    explanation: { type: [String], default: [], immutable: true },
    warnings: { type: [String], default: [], immutable: true },
    ruleVersion: { type: String, required: true, trim: true, immutable: true },
    status: {
      type: String,
      enum: Object.values(FeedRecommendationStatuses),
      required: true,
      default: FeedRecommendationStatuses.DRAFT,
    },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "FarmMember", default: null },
    reviewedAt: { type: Date, default: null },
    statusReason: { type: String, trim: true, maxlength: 1000 },
    reviewNote: { type: String, trim: true, maxlength: 1000 },
    supersededBy: { type: Schema.Types.ObjectId, ref: "FeedRecommendation", default: null },
    supersededAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "FarmMember", required: true, immutable: true },
  },
  { timestamps: true },
);

//animal timeline + "current plan" lookup
feedRecommendationSchema.index({ farmId: 1, animalId: 1, generatedAt: -1 });
//farm list filters
feedRecommendationSchema.index({ farmId: 1, status: 1, generatedAt: -1 });
feedRecommendationSchema.index({ farmId: 1, ruleVersion: 1 });
//reverse lookups used by FeedFormula / FeedIngredient usage counts
feedRecommendationSchema.index({ formulaId: 1 });
feedRecommendationSchema.index({ "recommendedItems.ingredientId": 1 });

export const FeedRecommendationModel = model<TFeedRecommendation>(
  "FeedRecommendation",
  feedRecommendationSchema,
);

// Atomic per-year sequence for recommendationNo (concurrent generations must not collide).
type TRecommendationCounter = { _id: string; seq: number };

const recommendationCounterSchema = new Schema<TRecommendationCounter>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);

export const RecommendationCounterModel = model<TRecommendationCounter>(
  "FeedRecommendationCounter",
  recommendationCounterSchema,
);
