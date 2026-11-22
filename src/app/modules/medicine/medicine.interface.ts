import type {
  MedicineAdministrationRoutes,
  MedicineCategories,
  MedicineDosageForms,
} from "./medicine.constants.js";

export type TMedicineCategory = (typeof MedicineCategories)[keyof typeof MedicineCategories];
export type TMedicineDosageForm = (typeof MedicineDosageForms)[keyof typeof MedicineDosageForms];
export type TMedicineAdministrationRoute =
  (typeof MedicineAdministrationRoutes)[keyof typeof MedicineAdministrationRoutes];

export type TMedicine = {
  //generated MED-00001, immutable
  medicineCode: string;
  //product / catalog name shown in the UI (Oxytetracycline Injection)
  medicineName: string;
  //active ingredient — several brands may share it, so it is NOT unique
  genericName: string;
  brandName?: string;
  manufacturer: string;
  category: TMedicineCategory;
  dosageForm: TMedicineDosageForm;
  //free-text concentration ("200 mg/ml", "10%"), must start with a number
  strength: string;
  //standard/default route; must be compatible with dosageForm
  administrationRoute: TMedicineAdministrationRoute;
  description?: string;
  storageCondition: string;
  //master rule (>= 0); the animal-specific withdrawal end is derived from Treatment
  withdrawalPeriodDays: number;
  prescriptionRequired: boolean;
  //false = retired (soft delete); hidden from new Treatment forms
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
};

export type TMedicineUsage = {
  treatments: number;
  inventories: number;
  total: number;
};
