import type { Types } from "mongoose";
import type { BreedingMethods, PregnancyResults } from "./breeding.constants.js";

export type TBreedingMethod = (typeof BreedingMethods)[keyof typeof BreedingMethods];
export type TPregnancyResult = (typeof PregnancyResults)[keyof typeof PregnancyResults];

// Breeding (Model 17) — final DB schema fields. No status / cost / embryo fields:
// the outcome is pregnancyResult, money lives in Expense / Income, embryo notes in remarks.
export type TBreeding = {
  //generated BRD-YYYY-NNNNNN, immutable
  breedingNo: string;
  farmId: Types.ObjectId;
  //the female being bred — never changes (a wrong-animal entry is deleted and re-logged)
  animalId: Types.ObjectId;
  heatDetectedDate: Date;
  //service date (insemination / mating / transfer); null = heat logged, service not yet done
  inseminationDate?: Date | null;
  breedingMethod: TBreedingMethod;
  //sire: a Male Animal of the same farm (required for Natural Mating)
  bullId?: Types.ObjectId | null;
  //AI semen traceability (required for AI, never for Natural Mating)
  semenBatchNo?: string | null;
  //free-text name of the technician / handler (no Technician model)
  technicianName: string;
  expectedPregnancyCheckDate: Date;
  pregnancyResult: TPregnancyResult;
  remarks?: string;
  //FarmMember _id of the person who logged the event
  createdBy: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
};
