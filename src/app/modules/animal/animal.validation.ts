import z from "zod";
import {
  AnimalGenders,
  AnimalHealthStatuses,
  AnimalLifeStatuses,
  AnimalPurposes,
  AnimalReproductiveStatuses,
} from "./animal.constants.js";

/**
 * NOTE: validateRequest only checks the body and discards the parsed result, so these
 * schemas are a first-line shape check. The service re-whitelists and coerces every field.
 * Dates/numbers accept strings too because multipart bodies arrive as JSON strings in `data`.
 */
const objectId = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{24}$/, { message: "Must be a valid id" });
const dateLike = z.union([z.string().trim().min(1), z.date()]);
const nonNegativeNumber = z.union([
  z.number().min(0),
  z.string().trim().regex(/^\d+(\.\d+)?$/, { message: "Must be a non-negative number" }),
]);
const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional();

const locationShape = z.object({
  shed: optionalText(50),
  pen: optionalText(50),
  stall: optionalText(50),
});

//animalCode, createdBy, updatedBy and isActive are system-controlled and not part of the body
const createAnimalValidation = z.object({
  body: z.object({
    breedId: objectId,
    rfid: optionalText(64),
    qrCode: optionalText(128),
    tagNumber: optionalText(64),
    name: optionalText(100),
    gender: z.enum(Object.values(AnimalGenders)),
    purpose: z.enum(Object.values(AnimalPurposes)),
    color: optionalText(100),
    birthDate: dateLike.nullable().optional(),
    purchaseDate: dateLike.nullable().optional(),
    purchasePrice: nonNegativeNumber.nullable().optional(),
    supplierId: objectId.nullable().optional(),
    currentWeight: nonNegativeNumber.nullable().optional(),
    profilePhoto: optionalText(1000),
    location: locationShape.optional(),
    remarks: optionalText(2000),
    healthStatus: z.enum(Object.values(AnimalHealthStatuses)).optional(),
    reproductiveStatus: z.enum(Object.values(AnimalReproductiveStatuses)),
  }),
});

//PUT — descriptive/acquisition metadata only (spec route table)
const updateAnimalValidation = z.object({
  body: z.object({
    name: optionalText(100),
    breedId: objectId.optional(),
    purpose: z.enum(Object.values(AnimalPurposes)).optional(),
    color: optionalText(100),
    birthDate: dateLike.nullable().optional(),
    purchaseDate: dateLike.nullable().optional(),
    purchasePrice: nonNegativeNumber.nullable().optional(),
    supplierId: objectId.nullable().optional(),
    remarks: optionalText(2000),
  }),
});

const updateIdentificationValidation = z.object({
  body: z.object({
    rfid: optionalText(64),
    tagNumber: optionalText(64),
    qrCode: optionalText(128),
    regenerateQrCode: z.boolean().optional(),
  }),
});

const updateLocationValidation = z.object({
  body: locationShape,
});

const updateLifecycleValidation = z.object({
  body: z.object({
    lifeStatus: z.enum(Object.values(AnimalLifeStatuses)),
    remarks: optionalText(2000),
  }),
});

const updateStatusValidation = z.object({
  body: z.object({
    healthStatus: z.enum(Object.values(AnimalHealthStatuses)).optional(),
    reproductiveStatus: z
      .enum(Object.values(AnimalReproductiveStatuses))
      .optional(),
  }),
});

export const animalValidations = {
  createAnimalValidation,
  updateAnimalValidation,
  updateIdentificationValidation,
  updateLocationValidation,
  updateLifecycleValidation,
  updateStatusValidation,
};
