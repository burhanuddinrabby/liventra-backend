import type { Types } from "mongoose";
import type {
  AnimalGenders,
  AnimalHealthStatuses,
  AnimalLifeStatuses,
  AnimalPurposes,
  AnimalReproductiveStatuses,
} from "./animal.constants.js";

export type TAnimalGender = (typeof AnimalGenders)[keyof typeof AnimalGenders];
export type TAnimalPurpose = (typeof AnimalPurposes)[keyof typeof AnimalPurposes];
export type TAnimalLifeStatus =
  (typeof AnimalLifeStatuses)[keyof typeof AnimalLifeStatuses];
export type TAnimalHealthStatus =
  (typeof AnimalHealthStatuses)[keyof typeof AnimalHealthStatuses];
export type TAnimalReproductiveStatus =
  (typeof AnimalReproductiveStatuses)[keyof typeof AnimalReproductiveStatuses];

export type TAnimalGalleryItem = {
  _id?: Types.ObjectId;
  url: string;
  caption?: string;
  uploadedAt: Date;
};

//current physical location inside the farm (not a movement history)
export type TAnimalLocation = {
  shed?: string;
  pen?: string;
  stall?: string;
};

export type TAnimal = {
  farmId: Types.ObjectId;
  breedId: Types.ObjectId;
  animalCode: string;
  rfid?: string;
  qrCode: string;
  tagNumber?: string;
  name?: string;
  gender: TAnimalGender;
  purpose: TAnimalPurpose;
  color?: string;
  birthDate?: Date;
  purchaseDate?: Date;
  purchasePrice?: number;
  supplierId?: Types.ObjectId;
  currentWeight?: number;
  profilePhoto?: string;
  gallery: TAnimalGalleryItem[];
  location?: TAnimalLocation;
  remarks?: string;
  lifeStatus: TAnimalLifeStatus;
  healthStatus: TAnimalHealthStatus;
  reproductiveStatus: TAnimalReproductiveStatus;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
};

//computed at read time from birthDate — never stored (spec §6.12)
export type TAnimalAge = {
  years: number;
  months: number;
  days: number;
  totalDays: number;
  totalMonths: number;
  label: string;
};
