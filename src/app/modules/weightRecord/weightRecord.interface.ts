import type { Types } from "mongoose";
import type { MeasurementMethods, WeightUnits } from "./weightRecord.constants.js";

export type TWeightUnit = (typeof WeightUnits)[keyof typeof WeightUnits];
export type TMeasurementMethod = (typeof MeasurementMethods)[keyof typeof MeasurementMethods];

export type TWeightRecord = {
  farmId: Types.ObjectId;
  animalId: Types.ObjectId;
  //calendar day the animal was actually weighed (UTC midnight);
  //createdAt is when the row was entered (delayed data entry is allowed)
  recordedDate: Date;
  //exactly what the user entered
  weight: number;
  weightUnit: TWeightUnit;
  //server-normalized kilograms used by every ADG / growth / recommendation calculation
  weightInKg: number;
  measurementMethod: TMeasurementMethod;
  //kg/day against the immediately preceding measurement; null for the first record
  //(never computed against an imaginary previous value, spec §25)
  averageDailyGain: number | null;
  //FarmMember who physically weighed the animal (may differ from whoever entered it)
  measuredBy: Types.ObjectId;
  remarks?: string;
  //voiding (DELETE default) keeps the row as history but removes it from growth math
  isVoided: boolean;
  voidedAt?: Date | null;
  voidedBy?: Types.ObjectId | null;
  voidReason?: string;
  createdAt?: Date;
  updatedAt?: Date;
};
