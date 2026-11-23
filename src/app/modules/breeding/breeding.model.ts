import { model, Schema } from "mongoose";
import {
  BREEDING_NO_PREFIX,
  BreedingMethods,
  MAX_SHORT_TEXT,
  MAX_TEXT_LENGTH,
  PregnancyResults,
} from "./breeding.constants.js";
import type { TBreeding } from "./breeding.interface.js";

// Writes go only through breeding.services.ts, which validates the biological and
// method rules and keeps Pregnancy + Animal.reproductiveStatus in sync atomically.
const breedingSchema = new Schema<TBreeding>(
  {
    breedingNo: { type: String, required: true, unique: true, immutable: true, trim: true, uppercase: true },
    farmId: { type: Schema.Types.ObjectId, ref: "Farm", required: true, immutable: true },
    animalId: { type: Schema.Types.ObjectId, ref: "Animal", required: true, immutable: true },
    heatDetectedDate: { type: Date, required: true },
    inseminationDate: { type: Date, default: null },
    breedingMethod: { type: String, enum: Object.values(BreedingMethods), required: true },
    bullId: { type: Schema.Types.ObjectId, ref: "Animal", default: null },
    semenBatchNo: { type: String, trim: true, uppercase: true, maxlength: MAX_SHORT_TEXT, default: null },
    technicianName: { type: String, required: true, trim: true, maxlength: MAX_SHORT_TEXT },
    expectedPregnancyCheckDate: { type: Date, required: true },
    pregnancyResult: {
      type: String,
      enum: Object.values(PregnancyResults),
      required: true,
      default: PregnancyResults.PENDING,
    },
    remarks: { type: String, trim: true, maxlength: MAX_TEXT_LENGTH },
    createdBy: { type: Schema.Types.ObjectId, ref: "FarmMember", required: true, immutable: true },
  },
  { timestamps: true },
);

//animalId is NOT unique: repeated attempts across cycles are legitimate (spec §59)
//animal breeding history (latest first) + "latest reproductive event" checks
breedingSchema.index({ farmId: 1, animalId: 1, inseminationDate: -1 });
breedingSchema.index({ farmId: 1, animalId: 1, heatDetectedDate: -1 });
//pending / overdue pregnancy checks dashboard
breedingSchema.index({ farmId: 1, pregnancyResult: 1, expectedPregnancyCheckDate: 1 });
breedingSchema.index({ farmId: 1, heatDetectedDate: -1 });
//bull / semen-batch analytics and recall-style lookups
breedingSchema.index({ farmId: 1, bullId: 1 });
breedingSchema.index({ farmId: 1, semenBatchNo: 1 });
breedingSchema.index({ farmId: 1, breedingMethod: 1 });

export const BreedingModel = model<TBreeding>("Breeding", breedingSchema);

// Atomic per-year sequence for breedingNo.
type TBreedingCounter = { _id: string; seq: number };

const breedingCounterSchema = new Schema<TBreedingCounter>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);

export const BreedingCounterModel = model<TBreedingCounter>("BreedingCounter", breedingCounterSchema);

/**
 * Next breedingNo, e.g. BRD-2026-000001. Atomic per-year counter (concurrent creates
 * never share a number); runs outside any transaction on purpose, gaps are harmless.
 */
export const generateBreedingNo = async (now: Date = new Date()): Promise<string> => {
  const year = now.getFullYear();
  const counter = await BreedingCounterModel.findOneAndUpdate(
    { _id: `breeding-${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  return `${BREEDING_NO_PREFIX}-${year}-${String(counter?.seq ?? 1).padStart(6, "0")}`;
};
