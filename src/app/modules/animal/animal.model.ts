import { model, Schema } from "mongoose";
import {
  AnimalGenders,
  AnimalHealthStatuses,
  AnimalLifeStatuses,
  AnimalPurposes,
  AnimalReproductiveStatuses,
} from "./animal.constants.js";
import type {
  TAnimal,
  TAnimalGalleryItem,
  TAnimalLocation,
} from "./animal.interface.js";

//gallery items keep their _id so a single image can be removed via PATCH /media
const galleryItemSchema = new Schema<TAnimalGalleryItem>({
  url: { type: String, required: true, trim: true },
  caption: { type: String, trim: true, maxlength: 200 },
  uploadedAt: { type: Date, required: true, default: Date.now },
});

const locationSchema = new Schema<TAnimalLocation>(
  {
    shed: { type: String, trim: true, maxlength: 50 },
    pen: { type: String, trim: true, maxlength: 50 },
    stall: { type: String, trim: true, maxlength: 50 },
  },
  { _id: false },
);

const animalSchema = new Schema<TAnimal>(
  {
    //every animal belongs to exactly one current farm (multi-farm data isolation)
    farmId: {
      type: Schema.Types.ObjectId,
      ref: "Farm",
      required: true,
      immutable: true,
    },
    breedId: { type: Schema.Types.ObjectId, ref: "Breed", required: true },
    //generated per farm (AN-000001) and never accepted from the client
    animalCode: {
      type: String,
      required: true,
      immutable: true,
      trim: true,
      uppercase: true,
    },
    //optional electronic id, unique system-wide when present (partial index below)
    rfid: { type: String, trim: true, maxlength: 64 },
    //auto-generated when not supplied; unique system-wide
    qrCode: { type: String, required: true, trim: true, maxlength: 128 },
    //physical ear tag, unique within the farm when present
    tagNumber: { type: String, trim: true, maxlength: 64 },
    name: { type: String, trim: true, maxlength: 100 },
    gender: { type: String, enum: Object.values(AnimalGenders), required: true },
    purpose: {
      type: String,
      enum: Object.values(AnimalPurposes),
      required: true,
    },
    color: { type: String, trim: true, maxlength: 100 },
    birthDate: { type: Date },
    purchaseDate: { type: Date },
    //BDT
    purchasePrice: { type: Number, min: 0 },
    //no Supplier collection exists yet; kept as a plain reference for the future module
    supplierId: { type: Schema.Types.ObjectId, ref: "Supplier" },
    //kg snapshot; history lives in WeightRecord
    currentWeight: { type: Number, min: 0 },
    profilePhoto: { type: String, trim: true },
    gallery: { type: [galleryItemSchema], default: [] },
    location: { type: locationSchema },
    remarks: { type: String, trim: true, maxlength: 2000 },
    lifeStatus: {
      type: String,
      enum: Object.values(AnimalLifeStatuses),
      required: true,
      default: AnimalLifeStatuses.ACTIVE,
    },
    healthStatus: {
      type: String,
      enum: Object.values(AnimalHealthStatuses),
      required: true,
      default: AnimalHealthStatuses.HEALTHY,
    },
    reproductiveStatus: {
      type: String,
      enum: Object.values(AnimalReproductiveStatuses),
      required: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
    //operational flag, kept in sync with lifeStatus (Active => true, otherwise false)
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

//identification uniqueness (spec §9). Optional ids use partial indexes so many animals can omit them.
animalSchema.index({ farmId: 1, animalCode: 1 }, { unique: true });
animalSchema.index({ qrCode: 1 }, { unique: true });
animalSchema.index(
  { rfid: 1 },
  { unique: true, partialFilterExpression: { rfid: { $type: "string" } } },
);
animalSchema.index(
  { farmId: 1, tagNumber: 1 },
  { unique: true, partialFilterExpression: { tagNumber: { $type: "string" } } },
);

//dashboard / herd-list filters
animalSchema.index({ farmId: 1, isActive: 1, lifeStatus: 1 });
animalSchema.index({ farmId: 1, healthStatus: 1 });
animalSchema.index({ farmId: 1, reproductiveStatus: 1 });
animalSchema.index({ farmId: 1, breedId: 1 });

export const AnimalModel = model<TAnimal>("Animal", animalSchema);
