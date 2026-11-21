import type { Types } from "mongoose";
import type { FeedingSessions } from "./feedRecord.constants.js";

export type TFeedingSession = (typeof FeedingSessions)[keyof typeof FeedingSessions];

// One ingredient actually fed. ingredientName + unitPrice are snapshots taken when the
// line was first recorded, so later catalog renames / price changes never alter history.
export type TFeedRecordItem = {
  ingredientId: Types.ObjectId;
  ingredientName: string;
  quantity: number;
  unit: string;
  //price per `unit` (BDT)
  unitPrice: number;
  //quantity × unitPrice, server-calculated
  totalCost: number;
};

export type TFeedRecord = {
  farmId: Types.ObjectId;
  animalId: Types.ObjectId;
  recommendationId?: Types.ObjectId | null;
  feedingSession: TFeedingSession;
  //calendar day of the feeding (UTC midnight); createdAt is when it was logged
  feedingDate: Date;
  items: TFeedRecordItem[];
  //Σ quantity in kg (liters counted 1:1, piece items excluded), server-calculated
  totalFeedQuantity: number;
  //Σ items.totalCost, server-calculated
  totalCost: number;
  remarks?: string;
  //FarmMember who performed the feeding (may differ from whoever logged it — see AuditLog)
  fedBy: Types.ObjectId;
  // Voiding (DELETE) keeps the event as history: stock is restored and the record is
  // excluded from lists, totals and adherence.
  isVoided: boolean;
  voidedAt?: Date | null;
  voidedBy?: Types.ObjectId | null;
  voidReason?: string;
  createdAt?: Date;
  updatedAt?: Date;
};
