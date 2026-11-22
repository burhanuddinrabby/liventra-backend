import type { Types } from "mongoose";
import type { MilkingMethods, MilkingSessions, MilkQualities, MilkUnits } from "./milkRecord.constants.js";

export type TMilkingSession = (typeof MilkingSessions)[keyof typeof MilkingSessions];
export type TMilkUnit = (typeof MilkUnits)[keyof typeof MilkUnits];
export type TMilkQuality = (typeof MilkQualities)[keyof typeof MilkQualities];
export type TMilkingMethod = (typeof MilkingMethods)[keyof typeof MilkingMethods];

// Snapshot of the medicine-withdrawal check made when the milk was logged / corrected.
export type TMilkWithdrawalDetail = {
  treatmentId: Types.ObjectId | null;
  treatmentNo: string | null;
  medicineName: string;
  withdrawalPeriodDays: number;
  //last day milk is still restricted (inclusive)
  withdrawalUntil: Date | null;
};

export type TMilkRecord = {
  farmId: Types.ObjectId;
  animalId: Types.ObjectId;
  //calendar day (UTC midnight) the milk was produced; createdAt is when it was entered
  recordDate: Date;
  milkingSession: TMilkingSession;
  //exactly what the user entered
  quantity: number;
  unit: TMilkUnit;
  //server-normalized liters used by every total / average (spec §13)
  quantityInLiters: number;
  //null = not measured (never 0 by default, spec §71)
  fatPercentage: number | null;
  proteinPercentage: number | null;
  snfPercentage: number | null;
  //null = not graded
  quality: TMilkQuality | null;
  milkingMethod: TMilkingMethod | null;
  //FarmMember who did the milking / measurement (may differ from whoever entered it)
  recordedBy: Types.ObjectId;
  remarks?: string;
  //true when the animal was inside a medicine milk-withdrawal window on recordDate:
  //the milk is not sale-eligible even if `quality` is not Rejected
  withdrawalFlag: boolean;
  withdrawalDetails: TMilkWithdrawalDetail[];
  //voiding (DELETE default) keeps the row as history but removes it from totals
  isVoided: boolean;
  voidedAt?: Date | null;
  voidedBy?: Types.ObjectId | null;
  voidReason?: string;
  createdAt?: Date;
  updatedAt?: Date;
};
