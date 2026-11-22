import { model, Schema } from "mongoose";
import { MAX_TEXT_LENGTH, MeasurementMethods, WeightUnits } from "./weightRecord.constants.js";
import type { TWeightRecord } from "./weightRecord.interface.js";

// Writes go only through weightRecord.services.ts, which validates the animal,
// normalizes the unit to kg, derives ADG and re-syncs Animal.currentWeight.
// farmId / animalId never change: a measurement attached to the wrong animal is
// voided and logged again.
const weightRecordSchema = new Schema<TWeightRecord>(
  {
    farmId: { type: Schema.Types.ObjectId, ref: "Farm", required: true, immutable: true },
    animalId: { type: Schema.Types.ObjectId, ref: "Animal", required: true, immutable: true },
    recordedDate: { type: Date, required: true },
    weight: { type: Number, required: true, min: 0 },
    weightUnit: {
      type: String,
      enum: Object.values(WeightUnits),
      required: true,
      default: WeightUnits.KG,
    },
    //derived by the service; never accepted from the client
    weightInKg: { type: Number, required: true, min: 0 },
    measurementMethod: {
      type: String,
      enum: Object.values(MeasurementMethods),
      required: true,
    },
    //derived by the service from the neighbouring measurements; null for the first
    averageDailyGain: { type: Number, default: null },
    measuredBy: { type: Schema.Types.ObjectId, ref: "FarmMember", required: true },
    remarks: { type: String, trim: true, maxlength: MAX_TEXT_LENGTH },
    isVoided: { type: Boolean, required: true, default: false },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: Schema.Types.ObjectId, ref: "FarmMember", default: null },
    voidReason: { type: String, trim: true, maxlength: MAX_TEXT_LENGTH },
  },
  { timestamps: true },
);

//animal growth trajectory (indexed by farm + animal + date, spec §2)
weightRecordSchema.index({ farmId: 1, animalId: 1, recordedDate: 1, createdAt: 1 });
//farm-wide log / latest-record lookup
weightRecordSchema.index({ farmId: 1, isVoided: 1, recordedDate: -1 });
//filters
weightRecordSchema.index({ farmId: 1, measurementMethod: 1, recordedDate: -1 });
weightRecordSchema.index({ farmId: 1, measuredBy: 1, recordedDate: -1 });

export const WeightRecordModel = model<TWeightRecord>("WeightRecord", weightRecordSchema);
