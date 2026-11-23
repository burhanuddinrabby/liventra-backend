import { model, Schema } from "mongoose";
import { CalfGenders, MAX_PREGNANCY_TEXT, PREGNANCY_NO_PREFIX, PregnancyStatuses } from "./pregnancy.constants.js";
import type { TPregnancy } from "./pregnancy.interface.js";

// Pregnancy episodes are created by the Breeding confirmation workflow
// (PATCH /farms/:farmId/breedings/:id/pregnancy-result) inside one atomic unit.
const pregnancySchema = new Schema<TPregnancy>(
  {
    pregnancyNo: { type: String, required: true, unique: true, immutable: true, trim: true, uppercase: true },
    farmId: { type: Schema.Types.ObjectId, ref: "Farm", required: true, immutable: true },
    animalId: { type: Schema.Types.ObjectId, ref: "Animal", required: true, immutable: true },
    breedingId: { type: Schema.Types.ObjectId, ref: "Breeding", required: true, immutable: true },
    conceptionDate: { type: Date, required: true },
    expectedCalvingDate: { type: Date, required: true },
    actualCalvingDate: { type: Date, default: null },
    calfCount: { type: Number, min: 0, max: 10, default: null },
    calfGender: { type: String, enum: Object.values(CalfGenders), default: null },
    pregnancyStatus: {
      type: String,
      enum: Object.values(PregnancyStatuses),
      required: true,
      default: PregnancyStatuses.PREGNANT,
    },
    remarks: { type: String, trim: true, maxlength: MAX_PREGNANCY_TEXT },
    createdBy: { type: Schema.Types.ObjectId, ref: "FarmMember", required: true, immutable: true },
  },
  { timestamps: true },
);

//1 Breeding → at most 1 Pregnancy (spec §90) — the database is the final guard
pregnancySchema.index({ breedingId: 1 }, { unique: true });
//"one active pregnancy per animal" checks + animal reproductive timeline
pregnancySchema.index({ farmId: 1, animalId: 1, pregnancyStatus: 1 });
//calving calendar
pregnancySchema.index({ farmId: 1, pregnancyStatus: 1, expectedCalvingDate: 1 });

export const PregnancyModel = model<TPregnancy>("Pregnancy", pregnancySchema);

// Atomic per-year sequence for pregnancyNo.
type TPregnancyCounter = { _id: string; seq: number };

const pregnancyCounterSchema = new Schema<TPregnancyCounter>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);

export const PregnancyCounterModel = model<TPregnancyCounter>("PregnancyCounter", pregnancyCounterSchema);

/** Next pregnancyNo, e.g. PRG-2026-000001 (atomic, outside any transaction; gaps are harmless). */
export const generatePregnancyNo = async (now: Date = new Date()): Promise<string> => {
  const year = now.getFullYear();
  const counter = await PregnancyCounterModel.findOneAndUpdate(
    { _id: `pregnancy-${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  return `${PREGNANCY_NO_PREFIX}-${year}-${String(counter?.seq ?? 1).padStart(6, "0")}`;
};
