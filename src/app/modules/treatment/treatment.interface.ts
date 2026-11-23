import type { Types } from "mongoose";
import type { TreatmentDosageUnits, TreatmentStatuses } from "./treatment.constants.js";
import type { TMedicineAdministrationRoute } from "../medicine/medicine.interface.js";

export type TTreatmentStatus = (typeof TreatmentStatuses)[keyof typeof TreatmentStatuses];
export type TTreatmentDosageUnit = (typeof TreatmentDosageUnits)[keyof typeof TreatmentDosageUnits];

// One prescribed medicine line (final schema `medicines[]`).
export type TTreatmentMedicine = {
  _id?: Types.ObjectId;
  medicineId: Types.ObjectId;
  //animal-specific amount per administration (> 0)
  dosage: number;
  dosageUnit: TTreatmentDosageUnit;
  //free text: "Twice daily", "Every 12 hours"
  frequency: string;
  //free text: "5 days", "Until follow-up" — parsed for withdrawal windows
  duration: string;
  //must be compatible with Medicine.dosageForm (medicine.constants matrix)
  administrationRoute: TMedicineAdministrationRoute;
  instructions?: string;
};

// Treatment (Model 16) — final DB schema fields.
export type TTreatment = {
  //generated TRT-YYYY-NNNNNN, immutable
  treatmentNo: string;
  farmId: Types.ObjectId;
  //never changes: an episode for the wrong animal is cancelled and recorded again
  animalId: Types.ObjectId;
  //singular by design (one primary disease per episode)
  diseaseId: Types.ObjectId;
  diagnosisDate: Date;
  //observed in THIS animal (Disease.symptoms[] is the general reference list)
  symptoms: string[];
  //FarmMember _id of the person handling the treatment (no Doctor model)
  treatedBy: Types.ObjectId;
  medicines: TTreatmentMedicine[];
  //estimate only — never an Expense
  estimatedCost?: number | null;
  status: TTreatmentStatus;
  followUpDate?: Date | null;
  //set only for Recovered (null while Ongoing)
  completedDate?: Date | null;
  remarks?: string;
  //FarmMember _id of the person who entered the record
  createdBy: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
};
