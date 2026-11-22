import { model, Schema } from "mongoose";
import { MAX_BATCH_LENGTH, MAX_TEXT_LENGTH, VaccinationStatuses } from "./vaccination.constants.js";
import type { TVaccination } from "./vaccination.interface.js";

// Writes go only through vaccination.services.ts, which validates eligibility,
// derives nextDueDate and moves vaccine stock in the same transaction.
const vaccinationSchema = new Schema<TVaccination>(
  {
    vaccinationNo: { type: String, required: true, unique: true, immutable: true, trim: true, uppercase: true },
    farmId: { type: Schema.Types.ObjectId, ref: "Farm", required: true, immutable: true },
    animalId: { type: Schema.Types.ObjectId, ref: "Animal", required: true, immutable: true },
    vaccineId: { type: Schema.Types.ObjectId, ref: "Vaccine", required: true },
    vaccinationDate: { type: Date, required: true },
    nextDueDate: { type: Date, default: null },
    administeredBy: { type: Schema.Types.ObjectId, ref: "FarmMember", default: null },
    batchNumber: { type: String, trim: true, uppercase: true, maxlength: MAX_BATCH_LENGTH, default: null },
    status: {
      type: String,
      enum: Object.values(VaccinationStatuses),
      required: true,
      default: VaccinationStatuses.SCHEDULED,
    },
    remarks: { type: String, trim: true, maxlength: MAX_TEXT_LENGTH },
    createdBy: { type: Schema.Types.ObjectId, ref: "FarmMember", required: true, immutable: true },
  },
  { timestamps: true },
);

//animal immunization history
vaccinationSchema.index({ farmId: 1, animalId: 1, vaccinationDate: -1 });
//duplicate detection / dose stage (same animal + vaccine)
vaccinationSchema.index({ farmId: 1, animalId: 1, vaccineId: 1, vaccinationDate: -1 });
//upcoming / overdue reminders
vaccinationSchema.index({ farmId: 1, status: 1, vaccinationDate: 1 });
vaccinationSchema.index({ farmId: 1, status: 1, nextDueDate: 1 });
//batch recall
vaccinationSchema.index({ farmId: 1, batchNumber: 1 });
//Vaccine /usage counts read this path
vaccinationSchema.index({ vaccineId: 1 });

export const VaccinationModel = model<TVaccination>("Vaccination", vaccinationSchema);

// Atomic per-year sequence for vaccinationNo.
type TVaccinationCounter = { _id: string; seq: number };

const vaccinationCounterSchema = new Schema<TVaccinationCounter>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);

export const VaccinationCounterModel = model<TVaccinationCounter>("VaccinationCounter", vaccinationCounterSchema);
