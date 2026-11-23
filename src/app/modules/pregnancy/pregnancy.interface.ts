import type { Types } from "mongoose";
import type { CalfGenders, PregnancyStatuses } from "./pregnancy.constants.js";

export type TPregnancyStatus = (typeof PregnancyStatuses)[keyof typeof PregnancyStatuses];
export type TCalfGender = (typeof CalfGenders)[keyof typeof CalfGenders];

// Pregnancy (Model 18) — final DB schema fields.
export type TPregnancy = {
  //generated PRG-YYYY-NNNNNN, immutable
  pregnancyNo: string;
  farmId: Types.ObjectId;
  animalId: Types.ObjectId;
  //the confirmed Breeding this pregnancy came from (unique: 1 Breeding → 0..1 Pregnancy)
  breedingId: Types.ObjectId;
  conceptionDate: Date;
  expectedCalvingDate: Date;
  //set by the (future) calving workflow
  actualCalvingDate?: Date | null;
  calfCount?: number | null;
  calfGender?: TCalfGender | null;
  pregnancyStatus: TPregnancyStatus;
  remarks?: string;
  //FarmMember _id of the person who confirmed the pregnancy
  createdBy: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
};
