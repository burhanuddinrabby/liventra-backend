import type { Types } from "mongoose";
import type { FarmStatuses, FarmTypes } from "./farm.constants.js";

export type TFarmType = (typeof FarmTypes)[keyof typeof FarmTypes];
export type TFarmStatus = (typeof FarmStatuses)[keyof typeof FarmStatuses];

export type TFarmAddress = {
  village?: string;
  union?: string;
  postOffice?: string;
  upazila: string;
  district: string;
  postalCode?: string;
  country: string;
};

export type TFarm = {
  farmId: string;
  farmName: string;
  ownerId: Types.ObjectId;
  address: TFarmAddress;
  location?: {
    latitude?: number;
    longitude?: number;
  };
  phone?: string;
  email?: string;
  establishedDate?: Date;
  farmType: TFarmType;
  totalArea?: {
    size?: number;
    unit?: string;
  };
  capacity: number;
  description?: string;
  logo?: string;
  status: TFarmStatus;
  createdAt?: Date;
  updatedAt?: Date;
};

