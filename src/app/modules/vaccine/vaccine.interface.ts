import type { Types } from "mongoose";
import type {
  VaccineAdministrationRoutes,
  VaccineCategories,
  VaccineDosageUnits,
} from "./vaccine.constants.js";

export type TVaccineCategory = (typeof VaccineCategories)[keyof typeof VaccineCategories];
export type TVaccineDosageUnit = (typeof VaccineDosageUnits)[keyof typeof VaccineDosageUnits];
export type TVaccineAdministrationRoute =
  (typeof VaccineAdministrationRoutes)[keyof typeof VaccineAdministrationRoutes];

export type TVaccine = {
  //generated VAC-00001, immutable
  vaccineCode: string;
  vaccineName: string;
  //short label for UI/reports (FMD), unique, stored uppercase
  shortCode: string;
  //Disease._id references (Disease module pending — validated against the raw collection)
  targetDiseaseIds: Types.ObjectId[];
  manufacturer?: string;
  category: TVaccineCategory;
  //master/reference dosage per animal (> 0), not the per-event administered amount
  dosage: number;
  dosageUnit: TVaccineDosageUnit;
  administrationRoute: TVaccineAdministrationRoute;
  //minimum animal age in months for eligibility warnings
  minimumAge?: number;
  boosterRequired: boolean;
  //only set when boosterRequired = true
  boosterAfterDays?: number;
  //long-term repeat interval (days) after the primary/booster dose
  repeatIntervalDays?: number;
  //required cold-chain condition, e.g. "2–8°C"
  storageTemperature: string;
  description?: string;
  isMandatory: boolean;
  //false = retired (soft delete); hidden from new Vaccination forms
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
};

export type TVaccineUsage = {
  vaccinations: number;
  diseases: number;
  inventories: number;
  total: number;
};
