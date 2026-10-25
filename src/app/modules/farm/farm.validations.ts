import z from "zod";
import { FarmStatuses, FarmTypes } from "./farm.constants.js";

const addressValidation = z.object({
  village: z.string().trim().optional(),
  union: z.string().trim().optional(),
  postOffice: z.string().trim().optional(),
  upazila: z.string().trim().min(1, { message: "Upazila is required" }),
  district: z.string().trim().min(1, { message: "District is required" }),
  postalCode: z.string().trim().optional(),
  country: z.string().trim().min(1, { message: "Country is required" }),
});

const coordinateValidation = z
  .object({
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
  })
  .refine(
    ({ latitude, longitude }) =>
      (latitude === undefined) === (longitude === undefined),
    {
      message: "Latitude and longitude must be provided together",
      path: ["latitude"],
    },
  );

const createFarmValidation = z.object({
  body: z.object({
    farmName: z
      .string()
      .trim()
      .min(1, { message: "Farm name is required" })
      .max(150),
    address: addressValidation,
    location: coordinateValidation.optional(),
    phone: z.string().trim().min(1).optional(),
    email: z.email().optional(),
    establishedDate: z.coerce.date().optional(),
    farmType: z.enum(Object.values(FarmTypes)),
    totalArea: z
      .object({
        size: z.number().min(0).optional(),
        unit: z.string().trim().optional(),
      })
      .optional(),
    capacity: z.number().min(0, { message: "Capacity must be a non-negative number" }),
    description: z.string().trim().max(2000).optional(),
    logo: z.string().trim().min(1).optional(),
  }),
});

const updateFarmValidation = z.object({
  body: z
    .object({
      ...createFarmValidation.shape.body.shape,
      farmType: z.enum(Object.values(FarmTypes)).optional(),
    })
    .partial()
});

const statusValidation = z.object({
  body: z.object({
    status: z.enum([
      FarmStatuses.SETUP,
      FarmStatuses.ACTIVE,
      FarmStatuses.INACTIVE,
      FarmStatuses.ARCHIVED,
    ]),
  }),
});

export const farmValidations = {
  createFarmValidation,
  updateFarmValidation,
  statusValidation,
};
