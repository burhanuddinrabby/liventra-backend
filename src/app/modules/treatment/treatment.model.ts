import { model, Schema } from "mongoose";
import { MedicineAdministrationRoutes } from "../medicine/medicine.constants.js";
import {
  MAX_ESTIMATED_COST,
  MAX_SHORT_TEXT,
  MAX_TEXT_LENGTH,
  TreatmentDosageUnits,
  TreatmentStatuses,
} from "./treatment.constants.js";
import type { TTreatment, TTreatmentMedicine } from "./treatment.interface.js";

// Writes go only through treatment.services.ts, which validates the clinical rules,
// keeps Animal.healthStatus in sync and moves medicine stock in one transaction.
const treatmentMedicineSchema = new Schema<TTreatmentMedicine>(
  {
    medicineId: { type: Schema.Types.ObjectId, ref: "Medicine", required: true },
    dosage: { type: Number, required: true, min: [0.0001, "dosage must be greater than 0"] },
    dosageUnit: { type: String, enum: Object.values(TreatmentDosageUnits), required: true },
    frequency: { type: String, required: true, trim: true, maxlength: MAX_SHORT_TEXT },
    duration: { type: String, required: true, trim: true, maxlength: MAX_SHORT_TEXT },
    administrationRoute: { type: String, enum: Object.values(MedicineAdministrationRoutes), required: true },
    instructions: { type: String, trim: true, maxlength: MAX_TEXT_LENGTH },
  },
  //each line keeps its _id so consumption / audit can point at it
  { _id: true },
);

const treatmentSchema = new Schema<TTreatment>(
  {
    treatmentNo: { type: String, required: true, unique: true, immutable: true, trim: true, uppercase: true },
    farmId: { type: Schema.Types.ObjectId, ref: "Farm", required: true, immutable: true },
    animalId: { type: Schema.Types.ObjectId, ref: "Animal", required: true, immutable: true },
    diseaseId: { type: Schema.Types.ObjectId, ref: "Disease", required: true },
    diagnosisDate: { type: Date, required: true },
    symptoms: { type: [{ type: String, trim: true }], default: [] },
    treatedBy: { type: Schema.Types.ObjectId, ref: "FarmMember", required: true },
    medicines: { type: [treatmentMedicineSchema], default: [] },
    estimatedCost: { type: Number, min: 0, max: MAX_ESTIMATED_COST, default: null },
    status: {
      type: String,
      enum: Object.values(TreatmentStatuses),
      required: true,
      default: TreatmentStatuses.ONGOING,
    },
    followUpDate: { type: Date, default: null },
    completedDate: { type: Date, default: null },
    remarks: { type: String, trim: true, maxlength: MAX_TEXT_LENGTH },
    createdBy: { type: Schema.Types.ObjectId, ref: "FarmMember", required: true, immutable: true },
  },
  { timestamps: true },
);

//animal health history (latest first) + "other active treatment?" checks
treatmentSchema.index({ farmId: 1, animalId: 1, status: 1, diagnosisDate: -1 });
//farm dashboard: status filter + follow-up reminders
treatmentSchema.index({ farmId: 1, status: 1, followUpDate: 1 });
treatmentSchema.index({ farmId: 1, diagnosisDate: -1 });
treatmentSchema.index({ farmId: 1, diseaseId: 1, diagnosisDate: -1 });
treatmentSchema.index({ farmId: 1, treatedBy: 1 });
//Disease / Medicine reference counts read these paths
treatmentSchema.index({ diseaseId: 1 });
treatmentSchema.index({ "medicines.medicineId": 1 });

export const TreatmentModel = model<TTreatment>("Treatment", treatmentSchema);

// Atomic per-year sequence for treatmentNo.
type TTreatmentCounter = { _id: string; seq: number };

const treatmentCounterSchema = new Schema<TTreatmentCounter>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);

export const TreatmentCounterModel = model<TTreatmentCounter>("TreatmentCounter", treatmentCounterSchema);
