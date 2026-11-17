import status from "http-status";
import { isValidObjectId } from "mongoose";
import type { HydratedDocument } from "mongoose";
import AppError from "../../errors/AppError.js";
import QueryBuilder from "../../builder/QueryBuilder.js";
import { uploadImageToCloudinary } from "../../utils/uploadImage.js";
import { BreedModel } from "./breed.model.js";
import {
  BreedCategories,
  BreedPurposes,
  ResistanceLevels,
  Temperaments,
} from "./breed.constants.js";
import type { TBreed } from "./breed.interface.js";
import { escapeRegex, generateBreedCode } from "./breed.utils.js";

type TBreedPayload = Record<string, unknown>;

//fields a client may write; identity/system fields (breedCode, _id, timestamps) are never accepted
const UPDATABLE_BREED_FIELDS = [
  "breedName",
  "origin",
  "category",
  "purpose",
  "averageMilkPerDay",
  "averageAdultWeight",
  "averageDailyFeed",
  "heatTolerance",
  "temperament",
  "colorPattern",
  "image",
  "diseaseResistance",
  "isNative",
  "description",
] as const;

//isActive may only be set at creation; afterwards PATCH /:id/status owns it
const CREATABLE_BREED_FIELDS = [...UPDATABLE_BREED_FIELDS, "isActive"] as const;

const TEXT_FIELDS = ["breedName", "origin", "colorPattern", "image", "description"] as const;

const NUMERIC_FIELDS = [
  "averageMilkPerDay",
  "averageAdultWeight",
  "averageDailyFeed",
] as const;

const BREED_LIST_FILTER_FIELDS = [
  "category",
  "purpose",
  "origin",
  "heatTolerance",
  "temperament",
  "diseaseResistance",
] as const;

const BREED_SORT_FIELDS = new Set([
  "breedName",
  "breedCode",
  "origin",
  "category",
  "purpose",
  "averageMilkPerDay",
  "averageAdultWeight",
  "averageDailyFeed",
  "isNative",
  "isActive",
  "createdAt",
  "updatedAt",
]);

const parseBooleanField = (value: unknown): boolean | undefined => {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
};

const parseNumberField = (
  field: string,
  value: unknown,
): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AppError(status.BAD_REQUEST, `${field} must be a valid number!`);
  }
  if (parsed < 0) {
    throw new AppError(status.BAD_REQUEST, `${field} cannot be negative!`);
  }
  if (field === "averageAdultWeight" && parsed <= 0) {
    throw new AppError(status.BAD_REQUEST, "averageAdultWeight must be greater than 0!");
  }

  return parsed;
};

/**
 * validateRequest only parses and discards the result, so the raw body still
 * contains unknown keys and uncoerced values. Whitelist and normalise here.
 */
const pickBreedFields = (
  payload: TBreedPayload,
  allowedFields: readonly string[],
): Record<string, unknown> => {
  const fields: Record<string, unknown> = {};

  for (const field of allowedFields) {
    if (payload[field] !== undefined) {
      fields[field] = payload[field];
    }
  }

  for (const field of TEXT_FIELDS) {
    if (typeof fields[field] === "string") {
      fields[field] = (fields[field] as string).trim();
    }
  }

  for (const field of NUMERIC_FIELDS) {
    if (fields[field] === undefined) continue;
    const numericValue = parseNumberField(field, fields[field]);
    if (numericValue === undefined) {
      delete fields[field];
    } else {
      fields[field] = numericValue;
    }
  }

  if (fields.isNative !== undefined) {
    const isNative = parseBooleanField(fields.isNative);
    if (isNative === undefined) {
      throw new AppError(status.BAD_REQUEST, "isNative must be a boolean!");
    }
    fields.isNative = isNative;
  }

  if (fields.isActive !== undefined) {
    const isActive = parseBooleanField(fields.isActive);
    if (isActive === undefined) {
      throw new AppError(status.BAD_REQUEST, "isActive must be a boolean!");
    }
    fields.isActive = isActive;
  }

  return fields;
};

const assertEnumValue = (
  field: string,
  value: unknown,
  allowedValues: string[],
) => {
  if (typeof value !== "string" || !allowedValues.includes(value)) {
    throw new AppError(
      status.BAD_REQUEST,
      `${field} must be one of: ${allowedValues.join(", ")}!`,
    );
  }
};

//breed names are unique case-insensitively ("Holstein Friesian" vs "Holstein friesen")
const assertBreedNameAvailable = async (
  breedName: string,
  excludeId?: string,
) => {
  const existing = await BreedModel.findOne({
    breedName,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  })
    .collation({ locale: "en", strength: 2 })
    .select("_id")
    .lean();

  if (existing) {
    throw new AppError(status.CONFLICT, "Breed name already exists!");
  }
};

//the partial unique indexes remain the final guard even after the pre-check
const toDuplicateKeyError = (error: unknown): AppError | null => {
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: number }).code === 11000
  ) {
    const keyValue = (error as { keyValue?: Record<string, unknown> }).keyValue;
    const duplicatedField = keyValue ? Object.keys(keyValue)[0] : undefined;

    return new AppError(
      status.CONFLICT,
      duplicatedField === "breedCode"
        ? "Breed code already exists, please retry!"
        : "Breed name already exists!",
    );
  }
  return null;
};

const createBreed = async (
  payload: TBreedPayload,
  file?: Express.Multer.File,
): Promise<TBreed> => {
  const fields = pickBreedFields(payload, CREATABLE_BREED_FIELDS);

  const breedName = fields.breedName as string | undefined;
  const origin = fields.origin as string | undefined;
  if (!breedName) {
    throw new AppError(status.BAD_REQUEST, "Breed name is required!");
  }
  if (!origin) {
    throw new AppError(status.BAD_REQUEST, "Origin is required!");
  }
  assertEnumValue("category", fields.category, Object.values(BreedCategories));
  assertEnumValue("purpose", fields.purpose, Object.values(BreedPurposes));

  if (fields.heatTolerance !== undefined) {
    assertEnumValue(
      "heatTolerance",
      fields.heatTolerance,
      Object.values(ResistanceLevels),
    );
  }
  if (fields.diseaseResistance !== undefined) {
    assertEnumValue(
      "diseaseResistance",
      fields.diseaseResistance,
      Object.values(ResistanceLevels),
    );
  }
  if (fields.temperament !== undefined) {
    assertEnumValue(
      "temperament",
      fields.temperament,
      Object.values(Temperaments),
    );
  }

  await assertBreedNameAvailable(breedName);

  const breedCode = await generateBreedCode();

  //priority: uploaded image (Cloudinary URL) > image URL from the body > empty
  let image =
    typeof fields.image === "string" ? (fields.image as string).trim() : "";
  if (file) {
    //cloudinary public_id must not contain path separators
    const safeCode = breedCode.replace(/[^a-zA-Z0-9_-]/g, "_");
    const uploaded = await uploadImageToCloudinary(`${safeCode}-image`, file.path);
    const uploadedUrl = uploaded?.secure_url as string | undefined;
    if (uploadedUrl) image = uploadedUrl;
  }

  const breedData = {
    ...fields,
    breedName,
    origin,
    breedCode,
    image,
    isNative: (fields.isNative as boolean | undefined) ?? false,
    isActive: (fields.isActive as boolean | undefined) ?? true,
  } as TBreed;

  try {
    return await BreedModel.create(breedData);
  } catch (error) {
    const duplicateError = toDuplicateKeyError(error);
    if (duplicateError) throw duplicateError;
    throw error;
  }
};

const getAllBreeds = async (
  query: TBreedPayload,
  isPlatformAdmin: boolean,
) => {
  const listQuery: TBreedPayload = {};

  if (typeof query.searchTerm === "string" && query.searchTerm.trim()) {
    //QueryBuilder interpolates this straight into $regex, so escape regex syntax
    listQuery.searchTerm = escapeRegex(query.searchTerm.trim());
  }

  for (const field of BREED_LIST_FILTER_FIELDS) {
    const value = query[field];
    if (typeof value === "string" && value.trim()) {
      listQuery[field] = value.trim();
    }
  }

  if (query.isNative !== undefined) {
    const isNative = parseBooleanField(query.isNative);
    if (isNative !== undefined) listQuery.isNative = isNative;
  }

  //deactivated breeds stay readable by id/code but never show up as selectable options
  const requestedIsActive = parseBooleanField(query.isActive);
  if (isPlatformAdmin && String(query.isActive).toLowerCase() === "all") {
    //platform admins may explicitly ask for every breed, active or not
  } else if (isPlatformAdmin && requestedIsActive !== undefined) {
    listQuery.isActive = requestedIsActive;
  } else {
    listQuery.isActive = true;
  }

  const sortTokens = String(query.sort ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => BREED_SORT_FIELDS.has(token.replace(/^-/, "")));
  listQuery.sort = sortTokens.length ? sortTokens.join(",") : "breedName";

  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 100);
  listQuery.page = page;
  listQuery.limit = limit;

  if (typeof query.fields === "string" && query.fields.trim()) {
    listQuery.fields = query.fields.trim();
  }

  const breedQuery = new QueryBuilder<TBreed>(BreedModel.find(), listQuery)
    .search(["breedName", "breedCode", "origin", "colorPattern"])
    .filter()
    .sort()
    .paginate()
    .fields();

  const [meta, breeds] = await Promise.all([
    breedQuery.countTotal(),
    breedQuery.modelQuery,
  ]);

  return { meta, breeds };
};

//slim payload for animal registration / feed formula selectors
const getBreedLookup = async (query: TBreedPayload) => {
  const filter: Record<string, unknown> = { isActive: true };

  for (const field of ["category", "purpose"] as const) {
    const value = query[field];
    if (typeof value === "string" && value.trim()) {
      filter[field] = value.trim();
    }
  }

  const searchTerm =
    typeof query.searchTerm === "string" ? query.searchTerm.trim() : "";
  if (searchTerm) {
    const regex = new RegExp(escapeRegex(searchTerm), "i");
    filter.$or = [{ breedName: regex }, { breedCode: regex }];
  }

  return BreedModel.find(filter)
    .select("breedCode breedName category purpose isNative")
    .sort({ breedName: 1 })
    .limit(200)
    .lean();
};

//single source of truth for the enum values the frontend renders
const getBreedMeta = () => ({
  categories: Object.values(BreedCategories),
  purposes: Object.values(BreedPurposes),
  resistanceLevels: Object.values(ResistanceLevels),
  temperaments: Object.values(Temperaments),
});

//distribution across the breed master list (animal-derived analytics arrive with Model 05)
const getBreedStats = async () => {
  const [summaryRows, categoryRows, purposeRows] = await Promise.all([
    BreedModel.aggregate<{
      total: number;
      active: number;
      inactive: number;
      nativeCount: number;
      nonNativeCount: number;
    }>([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: ["$isActive", 1, 0] } },
          inactive: { $sum: { $cond: ["$isActive", 0, 1] } },
          nativeCount: { $sum: { $cond: ["$isNative", 1, 0] } },
          nonNativeCount: { $sum: { $cond: ["$isNative", 0, 1] } },
        },
      },
    ]),
    BreedModel.aggregate<{ _id: string; count: number }>([
      { $group: { _id: "$category", count: { $sum: 1 } } },
    ]),
    BreedModel.aggregate<{ _id: string; count: number }>([
      { $group: { _id: "$purpose", count: { $sum: 1 } } },
    ]),
  ]);

  const summary = summaryRows[0] ?? {
    total: 0,
    active: 0,
    inactive: 0,
    nativeCount: 0,
    nonNativeCount: 0,
  };

  //enum constants drive the order and guarantee every value is present, even at count 0
  const categoryCounts = new Map(
    categoryRows.map((row) => [row._id, row.count]),
  );
  const purposeCounts = new Map(purposeRows.map((row) => [row._id, row.count]));

  return {
    total: summary.total,
    active: summary.active,
    inactive: summary.inactive,
    nativeCount: summary.nativeCount,
    nonNativeCount: summary.nonNativeCount,
    byCategory: Object.values(BreedCategories).map((category) => ({
      category,
      count: categoryCounts.get(category) ?? 0,
    })),
    byPurpose: Object.values(BreedPurposes).map((purpose) => ({
      purpose,
      count: purposeCounts.get(purpose) ?? 0,
    })),
  };
};


const getBreedById = async (
  id: string,
): Promise<HydratedDocument<TBreed>> => {
  if (!isValidObjectId(id)) {
    throw new AppError(status.BAD_REQUEST, "Invalid breed id!");
  }

  const breed = await BreedModel.findById(id);
  if (!breed) {
    throw new AppError(status.NOT_FOUND, "Breed not found!");
  }

  return breed;
};

const getBreedByCode = async (
  breedCode: string,
): Promise<HydratedDocument<TBreed>> => {
  const normalizedCode = String(breedCode ?? "")
    .trim()
    .toUpperCase();
  if (!normalizedCode) {
    throw new AppError(status.BAD_REQUEST, "Breed code is required!");
  }

  const breed = await BreedModel.findOne({ breedCode: normalizedCode });
  if (!breed) {
    throw new AppError(status.NOT_FOUND, "Breed not found!");
  }

  return breed;
};

const updateBreed = async (
  id: string,
  payload: TBreedPayload,
): Promise<TBreed> => {
  const breed = await getBreedById(id);
  const updates = pickBreedFields(payload, UPDATABLE_BREED_FIELDS);

  if (Object.keys(updates).length === 0) {
    throw new AppError(
      status.BAD_REQUEST,
      "No updatable breed fields were provided!",
    );
  }

  //revalidate enums because the raw body may bypass the (discarded) Zod result
  if (updates.category !== undefined) {
    assertEnumValue("category", updates.category, Object.values(BreedCategories));
  }
  if (updates.purpose !== undefined) {
    assertEnumValue("purpose", updates.purpose, Object.values(BreedPurposes));
  }
  if (updates.heatTolerance !== undefined) {
    assertEnumValue(
      "heatTolerance",
      updates.heatTolerance,
      Object.values(ResistanceLevels),
    );
  }
  if (updates.diseaseResistance !== undefined) {
    assertEnumValue(
      "diseaseResistance",
      updates.diseaseResistance,
      Object.values(ResistanceLevels),
    );
  }
  if (updates.temperament !== undefined) {
    assertEnumValue(
      "temperament",
      updates.temperament,
      Object.values(Temperaments),
    );
  }

  if (
    typeof updates.breedName === "string" &&
    updates.breedName !== breed.breedName
  ) {
    await assertBreedNameAvailable(updates.breedName, String(breed._id));
  }

  try {
    const updated = await BreedModel.findOneAndUpdate(
      breed._id,
      { $set: updates },
      { returnDocument: 'after', runValidators: true },
    );
    if (!updated) {
      throw new AppError(status.NOT_FOUND, "Breed not found!");
    }
    return updated;
  } catch (error) {
    const duplicateError = toDuplicateKeyError(error);
    if (duplicateError) throw duplicateError;
    throw error;
  }
};

const updateBreedImage = async (
  id: string,
  file?: Express.Multer.File,
  imageUrl?: string,
): Promise<TBreed> => {
  const breed = await getBreedById(id);

  let image =
    typeof imageUrl === "string" && imageUrl.trim()
      ? imageUrl.trim()
      : undefined;

  if (file) {
    //cloudinary public_id must not contain path separators
    const safeCode = breed.breedCode.replace(/[^a-zA-Z0-9_-]/g, "_");
    const uploaded = await uploadImageToCloudinary(`${safeCode}-image`, file.path);
    image = uploaded?.secure_url as string;
  }

  if (!image) {
    throw new AppError(
      status.BAD_REQUEST,
      "An image file or an image URL is required!",
    );
  }

  const updated = await BreedModel.findOneAndUpdate(
    breed._id,
    { $set: { image } },
    { returnDocument: 'after', runValidators: true },
  );
  if (!updated) {
    throw new AppError(status.NOT_FOUND, "Breed not found!");
  }

  return updated;
};

const updateBreedStatus = async (
  id: string,
  isActive: boolean,
): Promise<TBreed> => {
  if (typeof isActive !== "boolean") {
    throw new AppError(status.BAD_REQUEST, "isActive must be a boolean!");
  }

  const breed = await getBreedById(id);

  const updated = await BreedModel.findByIdAndUpdate(
    breed._id,
    { $set: { isActive } },
    { returnDocument: 'after', runValidators: true },
  );
  if (!updated) {
    throw new AppError(status.NOT_FOUND, "Breed not found!");
  }

  return updated;
};

export const BreedServices = {
  createBreed,
  getAllBreeds,
  getBreedLookup,
  getBreedMeta,
  getBreedStats,
  getBreedById,
  getBreedByCode,
  updateBreed,
  updateBreedImage,
  updateBreedStatus,
};
