import { model, Schema } from "mongoose";
import {
  MAX_TEXT_LENGTH,
  MilkingMethods,
  MilkingSessions,
  MilkQualities,
  MilkUnits,
} from "./milkRecord.constants.js";
import type { TMilkRecord, TMilkWithdrawalDetail } from "./milkRecord.interface.js";

const withdrawalDetailSchema = new Schema<TMilkWithdrawalDetail>(
  {
    treatmentId: { type: Schema.Types.ObjectId, default: null },
    treatmentNo: { type: String, default: null },
    medicineName: { type: String, required: true, trim: true },
    withdrawalPeriodDays: { type: Number, required: true, min: 0 },
    withdrawalUntil: { type: Date, default: null },
  },
  { _id: false },
);

// Writes go only through milkRecord.services.ts, which validates the animal, normalizes
// the unit and runs the withdrawal check. farmId / animalId never change: milk logged
// for the wrong animal is voided and logged again.
const milkRecordSchema = new Schema<TMilkRecord>(
  {
    farmId: { type: Schema.Types.ObjectId, ref: "Farm", required: true, immutable: true },
    animalId: { type: Schema.Types.ObjectId, ref: "Animal", required: true, immutable: true },
    recordDate: { type: Date, required: true },
    milkingSession: { type: String, enum: Object.values(MilkingSessions), required: true },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, enum: Object.values(MilkUnits), required: true, default: MilkUnits.LITER },
    quantityInLiters: { type: Number, required: true, min: 0 },
    fatPercentage: { type: Number, min: 0, default: null },
    proteinPercentage: { type: Number, min: 0, default: null },
    snfPercentage: { type: Number, min: 0, default: null },
    quality: { type: String, enum: [...Object.values(MilkQualities), null], default: null },
    milkingMethod: { type: String, enum: [...Object.values(MilkingMethods), null], default: null },
    recordedBy: { type: Schema.Types.ObjectId, ref: "FarmMember", required: true },
    remarks: { type: String, trim: true, maxlength: MAX_TEXT_LENGTH },
    withdrawalFlag: { type: Boolean, required: true, default: false },
    withdrawalDetails: { type: [withdrawalDetailSchema], default: [] },
    isVoided: { type: Boolean, required: true, default: false },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: Schema.Types.ObjectId, ref: "FarmMember", default: null },
    voidReason: { type: String, trim: true, maxlength: MAX_TEXT_LENGTH },
  },
  { timestamps: true },
);

//one official record per animal / day / session (spec §9, §49). Voided rows are
//history, so the session can be logged again after a void.
milkRecordSchema.index(
  { farmId: 1, animalId: 1, recordDate: 1, milkingSession: 1 },
  { unique: true, partialFilterExpression: { isVoided: false }, name: "uniq_active_animal_day_session" },
);
//animal timeline
milkRecordSchema.index({ farmId: 1, animalId: 1, recordDate: -1 });
//farm list / summary
milkRecordSchema.index({ farmId: 1, isVoided: 1, recordDate: -1 });
milkRecordSchema.index({ farmId: 1, quality: 1, recordDate: -1 });
milkRecordSchema.index({ farmId: 1, recordedBy: 1, recordDate: -1 });

export const MilkRecordModel = model<TMilkRecord>("MilkRecord", milkRecordSchema);
