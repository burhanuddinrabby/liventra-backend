import z from "zod";
import {
  FeedIngredientCategories,
  FeedIngredientUnits,
} from "./feedIngredient.constants.js";

// validateRequest discards the parsed result, so these schemas only reject bad
// requests early; feedIngredient.services.ts re-whitelists and coerces the raw body.

const nonNegative = (field: string) =>
  z.number({ message: `${field} must be a number` }).min(0, { message: `${field} cannot be negative` });

const percent = (field: string) =>
  nonNegative(field).max(100, { message: `${field} cannot exceed 100%` });

const objectIdString = z
  .string()
  .regex(/^[a-f\d]{24}$/i, { message: "supplierId must be a valid ObjectId" });

//ingredientCode is system-generated, so it is intentionally absent from the body
const createFeedIngredientValidation = z.object({
  body: z.object({
    ingredientName: z
      .string({ message: "Ingredient name is required" })
      .trim()
      .min(2, { message: "Ingredient name must be at least 2 characters" })
      .max(100),
    unit: z.enum(Object.values(FeedIngredientUnits)),
    category: z.enum(Object.values(FeedIngredientCategories)),
    dryMatterPercentage: percent("dryMatterPercentage"),
    crudeProtein: percent("crudeProtein"),
    crudeFiber: percent("crudeFiber"),
    energy: nonNegative("energy"),
    calcium: percent("calcium").optional(),
    phosphorus: percent("phosphorus").optional(),
    pricePerUnit: nonNegative("pricePerUnit"),
    availability: nonNegative("availability").optional(),
    supplierId: objectIdString.optional(),
    description: z.string().trim().max(2000).optional(),
    isAvailable: z.boolean().optional(),
  }),
});

//PUT accepts any subset; null clears an optional field
const updateFeedIngredientValidation = z.object({
  body: z.object({
    ingredientName: createFeedIngredientValidation.shape.body.shape.ingredientName.optional(),
    unit: z.enum(Object.values(FeedIngredientUnits)).optional(),
    category: z.enum(Object.values(FeedIngredientCategories)).optional(),
    dryMatterPercentage: percent("dryMatterPercentage").optional(),
    crudeProtein: percent("crudeProtein").optional(),
    crudeFiber: percent("crudeFiber").optional(),
    energy: nonNegative("energy").optional(),
    calcium: percent("calcium").nullable().optional(),
    phosphorus: percent("phosphorus").nullable().optional(),
    pricePerUnit: nonNegative("pricePerUnit").optional(),
    availability: nonNegative("availability").nullable().optional(),
    supplierId: objectIdString.nullable().optional(),
    description: z.string().trim().max(2000).nullable().optional(),
  }),
});

//omitting isAvailable flips the current value
const availabilityValidation = z.object({
  body: z
    .object({
      isAvailable: z.boolean({ message: "isAvailable must be a boolean" }).optional(),
      reason: z.string().trim().max(500).optional(),
    })
    .optional(),
});

//omitting isActive flips the current value
const toggleActiveValidation = z.object({
  body: z
    .object({
      isActive: z.boolean({ message: "isActive must be a boolean" }).optional(),
      reason: z.string().trim().max(500).optional(),
    })
    .optional(),
});

export const feedIngredientValidations = {
  createFeedIngredientValidation,
  updateFeedIngredientValidation,
  availabilityValidation,
  toggleActiveValidation,
};
