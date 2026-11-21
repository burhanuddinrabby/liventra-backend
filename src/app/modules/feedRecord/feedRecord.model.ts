import { model, Schema } from "mongoose";
import { FeedingSessions, MAX_TEXT_LENGTH } from "./feedRecord.constants.js";
import type { TFeedRecord, TFeedRecordItem } from "./feedRecord.interface.js";

const feedRecordItemSchema = new Schema<TFeedRecordItem>(
  {
    ingredientId: { type: Schema.Types.ObjectId, ref: "FeedIngredient", required: true },
    ingredientName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, required: true, trim: true },
    unitPrice: { type: Number, required: true, min: 0 },
    totalCost: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

// Writes go only through feedRecord.services.ts, which recalculates every total and
// reconciles farm inventory in the same transaction. farmId / animalId never change:
// a feeding logged for the wrong animal is voided and logged again.
const feedRecordSchema = new Schema<TFeedRecord>(
  {
    farmId: { type: Schema.Types.ObjectId, ref: "Farm", required: true, immutable: true },
    animalId: { type: Schema.Types.ObjectId, ref: "Animal", required: true, immutable: true },
    recommendationId: { type: Schema.Types.ObjectId, ref: "FeedRecommendation", default: null },
    feedingSession: { type: String, enum: Object.values(FeedingSessions), required: true },
    feedingDate: { type: Date, required: true },
    items: {
      type: [feedRecordItemSchema],
      validate: {
        validator: (value: unknown[]) => Array.isArray(value) && value.length > 0,
        message: "A feed record needs at least one item",
      },
    },
    totalFeedQuantity: { type: Number, required: true, min: 0 },
    totalCost: { type: Number, required: true, min: 0 },
    remarks: { type: String, trim: true, maxlength: MAX_TEXT_LENGTH },
    fedBy: { type: Schema.Types.ObjectId, ref: "FarmMember", required: true },
    isVoided: { type: Boolean, required: true, default: false },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: Schema.Types.ObjectId, ref: "FarmMember", default: null },
    voidReason: { type: String, trim: true, maxlength: MAX_TEXT_LENGTH },
  },
  { timestamps: true },
);

//animal timeline + daily summaries
feedRecordSchema.index({ farmId: 1, animalId: 1, feedingDate: -1 });
//farm list / stats
feedRecordSchema.index({ farmId: 1, isVoided: 1, feedingDate: -1 });
//adherence (recommended vs actual)
feedRecordSchema.index({ farmId: 1, recommendationId: 1, feedingDate: 1 });
feedRecordSchema.index({ farmId: 1, fedBy: 1, feedingDate: -1 });
//FeedIngredient /usage counts read this path
feedRecordSchema.index({ "items.ingredientId": 1 });

export const FeedRecordModel = model<TFeedRecord>("FeedRecord", feedRecordSchema);
