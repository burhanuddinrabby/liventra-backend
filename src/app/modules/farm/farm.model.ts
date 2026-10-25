import { model, Schema } from "mongoose";
import { FarmStatuses, FarmTypes } from "./farm.constants.js";
import type { TFarm, TFarmAddress } from "./farm.interface.js";

const farmAddressSchema = new Schema<TFarmAddress>(
  {
    village: { type: String, trim: true },
    union: { type: String, trim: true },
    postOffice: { type: String, trim: true },
    upazila: { type: String, required: true, trim: true },
    district: { type: String, required: true, trim: true },
    postalCode: { type: String, trim: true },
    country: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const farmSchema = new Schema<TFarm>(
  {
    farmId: { type: String, required: true, unique: true, immutable: true },
    farmName: { type: String, required: true, trim: true },
    //ownerId is required and immutable and refers to the user who created the farm
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    address: { type: farmAddressSchema, required: true },
    //location optional
    location: {
      latitude: { type: Number, min: -90, max: 90 },
      longitude: { type: Number, min: -180, max: 180 },
    },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    establishedDate: { type: Date },
    farmType: { type: String, enum: Object.values(FarmTypes), required: true },
    totalArea: {
      size: { type: Number, min: 0 }, 
      unit: { type: String, trim: true },
    },
    capacity: { type: Number, min: 0, required: true },
    description: { type: String, trim: true },
    logo: { type: String, trim: true },
    status: {
      type: String,
      enum: Object.values(FarmStatuses),
      default: FarmStatuses.SETUP,
      required: true,
    },
  },
  { timestamps: true },
);


export const FarmModel = model<TFarm>("Farm", farmSchema);
