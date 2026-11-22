import type { Types } from "mongoose";
import type { DiseaseCategories, DiseaseSeverities } from "./disease.constants.js";

export type TDiseaseCategory = (typeof DiseaseCategories)[keyof typeof DiseaseCategories];
export type TDiseaseSeverity = (typeof DiseaseSeverities)[keyof typeof DiseaseSeverities];

export type TDisease = {
  //generated DIS-00001, immutable
  diseaseCode: string;
  //canonical display name, unique case-insensitively (plus normalized duplicate check)
  diseaseName: string;
  category: TDiseaseCategory;
  //reference signs only — never used as an automatic diagnosis
  symptoms: string[];
  causes: string[];
  prevention?: string;
  severity: TDiseaseSeverity;
  //true = treatments of this disease should raise a health warning (Treatment module)
  contagious: boolean;
  //Vaccine._id references; current guidance only, historical Vaccinations are untouched
  recommendedVaccineIds: Types.ObjectId[];
  description?: string;
  //false = deactivated (soft delete); hidden from new Treatment selection
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
};

export type TDiseaseUsage = {
  treatments: number;
  vaccines: number;
  total: number;
};
