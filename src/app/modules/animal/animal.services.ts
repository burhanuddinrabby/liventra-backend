import fs from "fs/promises";
import status from "http-status";
import { isValidObjectId, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import AppError from "../../errors/AppError.js";
import { uploadImageToCloudinary } from "../../utils/uploadImage.js";
import { AuditActions, AuditEntityTypes, AuditModules } from "../auditLog/auditLog.constants.js";
import type { TAuditAction } from "../auditLog/auditLog.interface.js";
import { diffForAudit } from "../auditLog/auditLog.sanitize.js";
import { recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext } from "../auditLog/auditLog.utils.js";
import { BreedModel } from "../breed/breed.model.js";
import { FarmModel } from "../farm/farm.model.js";
import { FarmStatuses } from "../farm/farm.constants.js";
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";
import type { TFarmMemberRole } from "../farmMember/farmMember.interface.js";
import { FarmMemberServices } from "../farmMember/farmMember.service.js";
import { AnimalModel } from "./animal.model.js";
import {
  ANIMAL_FINANCIAL_FIELDS,
  AllowedLifeStatusTransitions,
  AnimalGenders,
  AnimalHealthStatuses,
  AnimalLifeStatuses,
  AnimalPurposes,
  AnimalReproductiveStatuses,
  FEMALE_ONLY_REPRODUCTIVE_STATUSES,
  MATURE_ONLY_REPRODUCTIVE_STATUSES,
  MAX_GALLERY_ITEMS,
  MIN_MATURE_AGE_MONTHS,
} from "./animal.constants.js";
import type {
  TAnimal,
  TAnimalGender,
  TAnimalLifeStatus,
  TAnimalReproductiveStatus,
} from "./animal.interface.js";
import {
  calculateAnimalAge,
  escapeRegex,
  generateAnimalCode,
  generateAnimalQrCode,
} from "./animal.utils.js";

type TPayload = Record<string, unknown>;
type TAnimalDoc = HydratedDocument<TAnimal>;
type TUploadedFiles = {
  profilePhoto?: Express.Multer.File[];
  gallery?: Express.Multer.File[];
};

/* -------------------------------------------------------------------------- */
/*                         Farm-scoped authorization                          */
/* -------------------------------------------------------------------------- */

const { OWNER, MANAGER, WORKER, VETERINARIAN, ACCOUNTANT } = FarmMemberRoles;

/**
 * Who may do what (route table in DO.md + Business Logics "CRUD Rules").
 * Read access is any active member; everything else is listed explicitly.
 */
const AnimalPermissions = {
  REGISTER: [OWNER, MANAGER, WORKER],
  EDIT_PROFILE: [OWNER, MANAGER],
  EDIT_IDENTIFICATION: [OWNER, MANAGER],
  MOVE: [OWNER, MANAGER, WORKER],
  MEDIA: [OWNER, MANAGER, WORKER],
  LIFECYCLE: [OWNER, MANAGER],
  STATUS: [OWNER, MANAGER, VETERINARIAN],
  ARCHIVE: [OWNER],
  //"Workers can't see the finances" — purchasePrice / supplierId
  VIEW_FINANCIALS: [OWNER, MANAGER, ACCOUNTANT],
} as const satisfies Record<string, readonly TFarmMemberRole[]>;

type TAnimalAccess = {
  userObjectId: Types.ObjectId;
  farmObjectId: Types.ObjectId;
  farmCode: string;
  farmStatus: string;
  role: TFarmMemberRole;
  canViewFinancials: boolean;
};

/**
 * Resolves the caller's effective role in the farm (active membership, or super admin /
 * Farm.ownerId treated as Owner) and the farm status. Throws 403/404 otherwise.
 */
const resolveAnimalAccess = async (
  farmId: string,
  requesterUserId: string,
): Promise<TAnimalAccess> => {
  const access = await FarmMemberServices.resolveFarmAccess(
    farmId,
    requesterUserId,
  );
  const role = FarmMemberServices.getActorRole(access);
  if (!role) {
    throw new AppError(status.FORBIDDEN, "You are not an active member of this farm!");
  }

  const farm = await FarmModel.findById(access.farm._id)
    .select("status")
    .lean();

  return {
    userObjectId: access.user._id,
    farmObjectId: access.farm._id,
    farmCode: access.farm.farmId,
    farmStatus: farm?.status ?? FarmStatuses.ACTIVE,
    role,
    canViewFinancials: (
      AnimalPermissions.VIEW_FINANCIALS as readonly string[]
    ).includes(role),
  };
};

const requireRole = (
  access: TAnimalAccess,
  allowed: readonly TFarmMemberRole[],
  action: string,
) => {
  if (!allowed.includes(access.role)) {
    throw new AppError(
      status.FORBIDDEN,
      `Your farm role (${access.role}) is not allowed to ${action}!`,
    );
  }
};

/** Suspended/Inactive farms are read-only; Setup farms cannot register animals yet. */
const requireWritableFarm = (access: TAnimalAccess, isRegistration = false) => {
  if (
    access.farmStatus === FarmStatuses.ARCHIVED ||
    access.farmStatus === FarmStatuses.INACTIVE
  ) {
    throw new AppError(
      status.FORBIDDEN,
      `This farm is ${access.farmStatus.toLowerCase()} — animal records are read-only!`,
    );
  }
  if (isRegistration && access.farmStatus === FarmStatuses.SETUP) {
    throw new AppError(
      status.FORBIDDEN,
      "Animals cannot be added while the farm is still in Setup status!",
    );
  }
};

/** Sold / Dead / Transferred / Archived animals keep their history but take no new changes. */
const requireOperationalAnimal = (animal: TAnimalDoc) => {
  if (animal.lifeStatus !== AnimalLifeStatuses.ACTIVE || !animal.isActive) {
    throw new AppError(
      status.CONFLICT,
      `Animal is ${animal.lifeStatus} — its record is read-only. Reactivate it first if it was archived.`,
    );
  }
};

/* -------------------------------------------------------------------------- */
/*                         Parsing / normalisation                            */
/* -------------------------------------------------------------------------- */

const isBlank = (value: unknown) =>
  value === null || (typeof value === "string" && value.trim() === "");

const parseText = (value: unknown): string | null => {
  if (value === undefined || isBlank(value)) return null;
  return String(value).trim();
};

const parseObjectIdField = (field: string, value: unknown): Types.ObjectId => {
  if (typeof value !== "string" || !isValidObjectId(value)) {
    throw new AppError(status.BAD_REQUEST, `${field} must be a valid id!`);
  }
  return new Types.ObjectId(value);
};

const parseNonNegativeNumber = (field: string, value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new AppError(status.BAD_REQUEST, `${field} must be a non-negative number!`);
  }
  return parsed;
};

const parsePastDate = (field: string, value: unknown): Date => {
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new AppError(status.BAD_REQUEST, `${field} is not a valid date!`);
  }
  //allow "today" across timezones
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  if (date.getTime() > endOfToday.getTime()) {
    throw new AppError(status.BAD_REQUEST, `${field} cannot be in the future!`);
  }
  return date;
};

const assertEnum = (field: string, value: unknown, allowed: string[]) => {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new AppError(
      status.BAD_REQUEST,
      `${field} must be one of: ${allowed.join(", ")}!`,
    );
  }
};

//only absolute http(s) URLs are stored — blocks javascript:/data: URLs from reaching <img src>
const parseImageUrl = (field: string, value: unknown): string => {
  const raw = String(value ?? "").trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(status.BAD_REQUEST, `${field} must be a valid URL!`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AppError(status.BAD_REQUEST, `${field} must be an http(s) URL!`);
  }
  return url.toString();
};

const parseLocation = (value: unknown) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(status.BAD_REQUEST, "location must be an object!");
  }
  const raw = value as TPayload;
  const location: Record<string, string> = {};
  for (const key of ["shed", "pen", "stall"] as const) {
    const text = parseText(raw[key]);
    if (text !== null) {
      if (text.length > 50) {
        throw new AppError(status.BAD_REQUEST, `location.${key} is too long!`);
      }
      location[key] = text;
    }
  }
  return location;
};

/**
 * Biological consistency (spec §24–25): males cannot be Heifer/Pregnant/Lactating/Dry,
 * and an animal younger than MIN_MATURE_AGE_MONTHS cannot be Pregnant/Lactating/Dry.
 */
const assertReproductiveConsistency = (
  gender: TAnimalGender,
  reproductiveStatus: TAnimalReproductiveStatus,
  birthDate?: Date | null,
) => {
  if (
    gender === AnimalGenders.MALE &&
    FEMALE_ONLY_REPRODUCTIVE_STATUSES.includes(reproductiveStatus)
  ) {
    throw new AppError(
      status.BAD_REQUEST,
      `A male animal cannot have reproductive status '${reproductiveStatus}'!`,
    );
  }
  const age = calculateAnimalAge(birthDate);
  if (
    age &&
    age.totalMonths < MIN_MATURE_AGE_MONTHS &&
    MATURE_ONLY_REPRODUCTIVE_STATUSES.includes(reproductiveStatus)
  ) {
    throw new AppError(
      status.BAD_REQUEST,
      `An animal younger than ${MIN_MATURE_AGE_MONTHS} months cannot be '${reproductiveStatus}'!`,
    );
  }
};

const assertPurchaseAfterBirth = (
  birthDate?: Date | null,
  purchaseDate?: Date | null,
) => {
  if (birthDate && purchaseDate && purchaseDate.getTime() < birthDate.getTime()) {
    throw new AppError(
      status.BAD_REQUEST,
      "purchaseDate cannot be earlier than birthDate!",
    );
  }
};

const assertActiveBreed = async (breedId: Types.ObjectId) => {
  const breed = await BreedModel.findById(breedId).select("isActive").lean();
  if (!breed) {
    throw new AppError(status.NOT_FOUND, "Breed not found!");
  }
  if (!breed.isActive) {
    throw new AppError(
      status.BAD_REQUEST,
      "This breed is deactivated and cannot be assigned to animals!",
    );
  }
};

/**
 * rfid + qrCode are unique system-wide, tagNumber within the farm. The unique indexes are the
 * final guard; this pre-check gives readable errors.
 */
const assertIdentifiersAvailable = async (
  farmObjectId: Types.ObjectId,
  ids: { rfid?: string | null; tagNumber?: string | null; qrCode?: string | null },
  excludeAnimalId?: Types.ObjectId,
) => {
  const exclude = excludeAnimalId ? { _id: { $ne: excludeAnimalId } } : {};
  const checks: Array<Promise<[string, unknown]>> = [];

  if (ids.rfid) {
    checks.push(
      AnimalModel.exists({ rfid: ids.rfid, ...exclude }).then((r) => ["RFID", r]),
    );
  }
  if (ids.qrCode) {
    checks.push(
      AnimalModel.exists({ qrCode: ids.qrCode, ...exclude }).then((r) => ["QR code", r]),
    );
  }
  if (ids.tagNumber) {
    checks.push(
      AnimalModel.exists({
        farmId: farmObjectId,
        tagNumber: ids.tagNumber,
        ...exclude,
      }).then((r) => ["Tag number", r]),
    );
  }

  for (const [label, exists] of await Promise.all(checks)) {
    if (exists) {
      throw new AppError(
        status.CONFLICT,
        `${label} is already assigned to another animal!`,
      );
    }
  }
};

const toDuplicateKeyError = (error: unknown): AppError | null => {
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: number }).code === 11000
  ) {
    const keyPattern =
      (error as { keyPattern?: Record<string, unknown> }).keyPattern ?? {};
    const labels: Record<string, string> = {
      rfid: "RFID",
      qrCode: "QR code",
      tagNumber: "Tag number",
      animalCode: "Animal code",
    };
    const field = Object.keys(keyPattern).find((key) => key in labels);
    return new AppError(
      status.CONFLICT,
      `${field ? labels[field] : "Identifier"} is already assigned to another animal!`,
    );
  }
  return null;
};

const isAnimalCodeCollision = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: number }).code === 11000 &&
  "animalCode" in
    ((error as { keyPattern?: Record<string, unknown> }).keyPattern ?? {});

/* -------------------------------------------------------------------------- */
/*                              Image uploads                                 */
/* -------------------------------------------------------------------------- */

const removeLocalFiles = async (files: Express.Multer.File[]) => {
  await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => undefined)));
};

const assertImageFiles = async (files: Express.Multer.File[]) => {
  const invalid = files.find((file) => !file.mimetype?.startsWith("image/"));
  if (invalid) {
    await removeLocalFiles(files);
    throw new AppError(status.BAD_REQUEST, "Only image files can be uploaded!");
  }
};

const uploadAnimalImage = async (
  file: Express.Multer.File,
  farmCode: string,
  animalCode: string,
  suffix: string,
): Promise<string> => {
  //cloudinary public_id must not contain path separators
  const safeName = `${farmCode}-${animalCode}-${suffix}-${Date.now()}`.replace(
    /[^a-zA-Z0-9_-]/g,
    "_",
  );
  const uploaded = await uploadImageToCloudinary(safeName, file.path);
  const url = uploaded?.secure_url as string | undefined;
  if (!url) {
    throw new AppError(status.BAD_GATEWAY, "Image upload failed!");
  }
  return url;
};

/* -------------------------------------------------------------------------- */
/*                            Response shaping                                */
/* -------------------------------------------------------------------------- */

const BREED_POPULATE_FIELDS = "breedCode breedName category purpose image isActive";
const USER_POPULATE_FIELDS = "userId fullName";

/** Adds the computed age and strips financial fields for roles without finance access. */
const toAnimalResponse = (
  animal: TAnimalDoc | Record<string, unknown>,
  canViewFinancials: boolean,
) => {
  const plain = (
    typeof (animal as TAnimalDoc).toObject === "function"
      ? (animal as TAnimalDoc).toObject()
      : animal
  ) as Record<string, unknown>;
  delete plain.__v;

  if (!canViewFinancials) {
    for (const field of ANIMAL_FINANCIAL_FIELDS) delete plain[field];
  }

  return {
    ...plain,
    age: calculateAnimalAge(plain.birthDate as Date | undefined),
  };
};

const findAnimalInFarm = async (
  farmObjectId: Types.ObjectId,
  animalId: string,
): Promise<TAnimalDoc> => {
  if (!isValidObjectId(animalId)) {
    throw new AppError(status.BAD_REQUEST, "Invalid animal id!");
  }
  //farmId in the filter enforces farm isolation — an id from another farm is a 404
  const animal = await AnimalModel.findOne({ _id: animalId, farmId: farmObjectId });
  if (!animal) {
    throw new AppError(status.NOT_FOUND, "Animal not found!");
  }
  return animal;
};

const loadAnimalDetail = async (animalObjectId: Types.ObjectId) =>
  AnimalModel.findById(animalObjectId)
    .populate("breedId", BREED_POPULATE_FIELDS)
    .populate("farmId", "farmId farmName status")
    .populate("createdBy", USER_POPULATE_FIELDS)
    .populate("updatedBy", USER_POPULATE_FIELDS);

type TAnimalAudit = {
  context?: TAuditContext | undefined;
  event: string;
  action?: TAuditAction;
  /** Changes written outside set/unset (gallery). */
  extra?: { oldData: TPayload; newData: TPayload; changedFields: string[] };
};

/** Applies $set/$unset (null clears an optional field) and returns the populated detail. */
const applyAnimalUpdate = async (
  animal: TAnimalDoc,
  access: TAnimalAccess,
  set: TPayload,
  unset: string[],
  auditing: TAnimalAudit,
) => {
  const update: Record<string, unknown> = {
    $set: { ...set, updatedBy: access.userObjectId },
  };
  if (unset.length) {
    update.$unset = Object.fromEntries(unset.map((field) => [field, ""]));
  }

  try {
    await AnimalModel.updateOne({ _id: animal._id, farmId: access.farmObjectId }, update, {
      runValidators: true,
    });
  } catch (error) {
    const duplicate = toDuplicateKeyError(error);
    if (duplicate) throw duplicate;
    throw error;
  }

  const before = animal.toObject() as unknown as TPayload;
  const fields = [...Object.keys(set), ...unset];
  const changes = diffForAudit(
    Object.fromEntries(fields.map((field) => [field, before[field] ?? null])),
    Object.fromEntries(fields.map((field) => [field, set[field] ?? null])),
  );
  const changedFields = [...changes.changedFields, ...(auditing.extra?.changedFields ?? [])];
  if (changedFields.length) {
    await recordAuditLog({
      context: auditing.context,
      farmId: access.farmObjectId,
      entityType: AuditEntityTypes.ANIMAL,
      entityId: animal._id,
      action: auditing.action ?? AuditActions.UPDATE,
      module: AuditModules.ANIMAL,
      event: auditing.event,
      oldData: { ...changes.oldData, ...auditing.extra?.oldData },
      newData: { ...changes.newData, ...auditing.extra?.newData },
      changedFields,
    });
  }

  const updated = await loadAnimalDetail(animal._id);
  if (!updated) throw new AppError(status.NOT_FOUND, "Animal not found!");
  return toAnimalResponse(updated, access.canViewFinancials);
};

/* -------------------------------------------------------------------------- */
/*                                Services                                    */
/* -------------------------------------------------------------------------- */

//POST /farms/:farmId/animals — Owner / Manager / Worker
const createAnimal = async (
  farmId: string,
  requesterUserId: string,
  payload: TPayload,
  file?: Express.Multer.File,
  context?: TAuditContext,
) => {
  try {
    if (file) await assertImageFiles([file]);
    const access = await resolveAnimalAccess(farmId, requesterUserId);
    requireRole(access, AnimalPermissions.REGISTER, "register animals");
    requireWritableFarm(access, true);

    //whitelist — animalCode, lifeStatus, isActive, createdBy, gallery are system-controlled
    const breedId = parseObjectIdField("breedId", payload.breedId);
    assertEnum("gender", payload.gender, Object.values(AnimalGenders));
    assertEnum("purpose", payload.purpose, Object.values(AnimalPurposes));
    assertEnum(
      "reproductiveStatus",
      payload.reproductiveStatus,
      Object.values(AnimalReproductiveStatuses),
    );
    const healthStatus = payload.healthStatus ?? AnimalHealthStatuses.HEALTHY;
    assertEnum("healthStatus", healthStatus, Object.values(AnimalHealthStatuses));

    const gender = payload.gender as TAnimalGender;
    const reproductiveStatus = payload.reproductiveStatus as TAnimalReproductiveStatus;
    const birthDate = isBlank(payload.birthDate) || payload.birthDate === undefined
      ? null
      : parsePastDate("birthDate", payload.birthDate);
    const purchaseDate =
      isBlank(payload.purchaseDate) || payload.purchaseDate === undefined
        ? null
        : parsePastDate("purchaseDate", payload.purchaseDate);
    assertPurchaseAfterBirth(birthDate, purchaseDate);
    assertReproductiveConsistency(gender, reproductiveStatus, birthDate);

    const rfid = parseText(payload.rfid);
    const tagNumber = parseText(payload.tagNumber);
    const customQrCode = parseText(payload.qrCode);

    await assertActiveBreed(breedId);
    await assertIdentifiersAvailable(access.farmObjectId, {
      rfid,
      tagNumber,
      qrCode: customQrCode,
    });

    const data: TPayload = {
      farmId: access.farmObjectId,
      breedId,
      gender,
      purpose: payload.purpose,
      reproductiveStatus,
      healthStatus,
      lifeStatus: AnimalLifeStatuses.ACTIVE,
      isActive: true,
      createdBy: access.userObjectId,
      gallery: [],
    };
    if (rfid) data.rfid = rfid;
    if (tagNumber) data.tagNumber = tagNumber;
    for (const field of ["name", "color", "remarks"] as const) {
      const text = parseText(payload[field]);
      if (text) data[field] = text;
    }
    if (birthDate) data.birthDate = birthDate;
    if (purchaseDate) data.purchaseDate = purchaseDate;
    if (!isBlank(payload.purchasePrice) && payload.purchasePrice !== undefined) {
      data.purchasePrice = parseNonNegativeNumber("purchasePrice", payload.purchasePrice);
    }
    if (!isBlank(payload.supplierId) && payload.supplierId !== undefined) {
      data.supplierId = parseObjectIdField("supplierId", payload.supplierId);
    }
    if (!isBlank(payload.currentWeight) && payload.currentWeight !== undefined) {
      data.currentWeight = parseNonNegativeNumber("currentWeight", payload.currentWeight);
    }
    const location = parseLocation(payload.location);
    if (location && Object.keys(location).length) data.location = location;
    if (!file && !isBlank(payload.profilePhoto) && payload.profilePhoto !== undefined) {
      data.profilePhoto = parseImageUrl("profilePhoto", payload.profilePhoto);
    }

    //animalCode is last-row+1 per farm; retry when a concurrent registration took the same code
    let created: TAnimalDoc | null = null;
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      const animalCode = await generateAnimalCode(access.farmObjectId);
      try {
        created = await AnimalModel.create({
          ...data,
          animalCode,
          qrCode: customQrCode ?? generateAnimalQrCode(access.farmCode, animalCode),
        });
      } catch (error) {
        if (isAnimalCodeCollision(error)) continue;
        const duplicate = toDuplicateKeyError(error);
        if (duplicate) throw duplicate;
        throw error;
      }
    }
    if (!created) {
      throw new AppError(
        status.CONFLICT,
        "Could not generate a unique animal code, please retry!",
      );
    }

    //photo is uploaded after the code exists so the Cloudinary name is meaningful
    if (file) {
      const url = await uploadAnimalImage(file, access.farmCode, created.animalCode, "profile");
      await AnimalModel.updateOne({ _id: created._id }, { $set: { profilePhoto: url } });
    }

    // TODO(WeightRecord): when Model 11 exists, create the initial WeightRecord from currentWeight.
    await recordAuditLog({
      context,
      farmId: access.farmObjectId,
      entityType: AuditEntityTypes.ANIMAL,
      entityId: created._id,
      action: AuditActions.CREATE,
      module: AuditModules.ANIMAL,
      event: "Animal Registered",
      newData: { ...(data as unknown as TPayload), animalCode: created.animalCode, qrCode: created.qrCode },
    });

    const detail = await loadAnimalDetail(created._id);
    return toAnimalResponse(detail ?? created, access.canViewFinancials);
  } finally {
    //multer temp file is removed by uploadImageToCloudinary on success; clean up otherwise
    if (file) await removeLocalFiles([file]);
  }
};

const LIST_SORT_FIELDS = new Set([
  "animalCode",
  "name",
  "tagNumber",
  "birthDate",
  "purchaseDate",
  "purchasePrice",
  "currentWeight",
  "lifeStatus",
  "healthStatus",
  "reproductiveStatus",
  "purpose",
  "gender",
  "createdAt",
  "updatedAt",
]);

const parseListSort = (sort: unknown, canViewFinancials: boolean): string => {
  if (typeof sort !== "string" || !sort.trim()) return "-createdAt";
  const tokens = sort
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  for (const token of tokens) {
    const field = token.replace(/^-/, "");
    if (
      !LIST_SORT_FIELDS.has(field) ||
      (!canViewFinancials && field === "purchasePrice")
    ) {
      throw new AppError(status.BAD_REQUEST, `Animals cannot be sorted by '${field}'!`);
    }
  }
  return tokens.join(" ");
};

const readQueryString = (query: TPayload, key: string): string | undefined => {
  const value = query[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

//GET /farms/:farmId/animals — any active farm member
const getFarmAnimals = async (
  farmId: string,
  requesterUserId: string,
  query: TPayload,
) => {
  const access = await resolveAnimalAccess(farmId, requesterUserId);
  const filter: Record<string, unknown> = { farmId: access.farmObjectId };

  const enumFilters: Array<[string, string[]]> = [
    ["lifeStatus", Object.values(AnimalLifeStatuses)],
    ["healthStatus", Object.values(AnimalHealthStatuses)],
    ["reproductiveStatus", Object.values(AnimalReproductiveStatuses)],
    ["purpose", Object.values(AnimalPurposes)],
    ["gender", Object.values(AnimalGenders)],
  ];
  for (const [field, allowed] of enumFilters) {
    const value = readQueryString(query, field);
    if (!value) continue;
    //comma-separated values become $in (e.g. lifeStatus=Sold,Dead)
    const values = value.split(",").map((v) => v.trim()).filter(Boolean);
    values.forEach((v) => assertEnum(field, v, allowed));
    filter[field] = values.length === 1 ? values[0] : { $in: values };
  }

  const breedId = readQueryString(query, "breedId");
  if (breedId) filter.breedId = parseObjectIdField("breedId", breedId);

  for (const key of ["shed", "pen", "stall"] as const) {
    const value = readQueryString(query, key);
    if (value) filter[`location.${key}`] = value;
  }

  //by default only operational animals; an explicit lifeStatus or isActive filter overrides it
  const isActiveParam = readQueryString(query, "isActive")?.toLowerCase();
  if (isActiveParam === "true" || isActiveParam === "false") {
    filter.isActive = isActiveParam === "true";
  } else if (isActiveParam !== "all" && !filter.lifeStatus) {
    filter.isActive = true;
  }

  const minWeight = readQueryString(query, "minWeight");
  const maxWeight = readQueryString(query, "maxWeight");
  if (minWeight || maxWeight) {
    const range: Record<string, number> = {};
    if (minWeight) range.$gte = parseNonNegativeNumber("minWeight", minWeight);
    if (maxWeight) range.$lte = parseNonNegativeNumber("maxWeight", maxWeight);
    filter.currentWeight = range;
  }

  const searchTerm = readQueryString(query, "searchTerm");
  if (searchTerm) {
    const regex = new RegExp(escapeRegex(searchTerm.slice(0, 100)), "i");
    filter.$or = ["animalCode", "tagNumber", "rfid", "qrCode", "name", "color"].map(
      (field) => ({ [field]: regex }),
    );
  }

  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 100);
  const sort = parseListSort(query.sort, access.canViewFinancials);

  const [totalEntries, animals] = await Promise.all([
    AnimalModel.countDocuments(filter),
    AnimalModel.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .select("-gallery -__v")
      .populate("breedId", "breedCode breedName category purpose")
      .lean(),
  ]);

  return {
    meta: {
      page,
      limit,
      totalEntries,
      totalPage: Math.ceil(totalEntries / limit),
    },
    animals: animals.map((animal) =>
      toAnimalResponse(animal as unknown as Record<string, unknown>, access.canViewFinancials),
    ),
  };
};

//GET /farms/:farmId/animals/meta — enum values for forms and filters
const getAnimalMeta = () => ({
  genders: Object.values(AnimalGenders),
  purposes: Object.values(AnimalPurposes),
  lifeStatuses: Object.values(AnimalLifeStatuses),
  healthStatuses: Object.values(AnimalHealthStatuses),
  reproductiveStatuses: Object.values(AnimalReproductiveStatuses),
  lifeStatusTransitions: AllowedLifeStatusTransitions,
  femaleOnlyReproductiveStatuses: FEMALE_ONLY_REPRODUCTIVE_STATUSES,
});

//GET /farms/:farmId/animals/stats — dashboard counts from current Animal state (spec §32)
const getAnimalStats = async (farmId: string, requesterUserId: string) => {
  const access = await resolveAnimalAccess(farmId, requesterUserId);
  const farmObjectId = access.farmObjectId;
  const active = { farmId: farmObjectId, isActive: true };

  type TCountRow = { _id: string | null; count: number };
  const countBy = (match: Record<string, unknown>, field: string) =>
    AnimalModel.aggregate<TCountRow>([
      { $match: match },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    ]);

  const [lifeRows, healthRows, reproRows, purposeRows, genderRows, breedRows] =
    await Promise.all([
      countBy({ farmId: farmObjectId }, "lifeStatus"),
      countBy(active, "healthStatus"),
      countBy(active, "reproductiveStatus"),
      countBy(active, "purpose"),
      countBy(active, "gender"),
      AnimalModel.aggregate<{ _id: Types.ObjectId; count: number; breedName?: string; breedCode?: string }>([
        { $match: active },
        { $group: { _id: "$breedId", count: { $sum: 1 } } },
        { $lookup: { from: "breeds", localField: "_id", foreignField: "_id", as: "breed" } },
        { $unwind: { path: "$breed", preserveNullAndEmptyArrays: true } },
        { $project: { count: 1, breedName: "$breed.breedName", breedCode: "$breed.breedCode" } },
        { $sort: { count: -1 } },
      ]),
    ]);

  //enum constants drive the order and include zero counts
  const toBuckets = (rows: TCountRow[], values: string[], key: string) => {
    const counts = new Map(rows.map((row) => [row._id, row.count]));
    return values.map((value) => ({ [key]: value, count: counts.get(value) ?? 0 }));
  };

  const total = lifeRows.reduce((sum, row) => sum + row.count, 0);
  const activeTotal = healthRows.reduce((sum, row) => sum + row.count, 0);

  return {
    total,
    active: activeTotal,
    inactive: total - activeTotal,
    byLifeStatus: toBuckets(lifeRows, Object.values(AnimalLifeStatuses), "lifeStatus"),
    byHealthStatus: toBuckets(healthRows, Object.values(AnimalHealthStatuses), "healthStatus"),
    byReproductiveStatus: toBuckets(
      reproRows,
      Object.values(AnimalReproductiveStatuses),
      "reproductiveStatus",
    ),
    byPurpose: toBuckets(purposeRows, Object.values(AnimalPurposes), "purpose"),
    byGender: toBuckets(genderRows, Object.values(AnimalGenders), "gender"),
    byBreed: breedRows.map((row) => ({
      breedId: row._id,
      breedCode: row.breedCode ?? null,
      breedName: row.breedName ?? null,
      count: row.count,
    })),
  };
};

//GET /farms/:farmId/animals/:animalId — full profile with computed age
const getAnimalById = async (
  farmId: string,
  requesterUserId: string,
  animalId: string,
) => {
  const access = await resolveAnimalAccess(farmId, requesterUserId);
  const animal = await findAnimalInFarm(access.farmObjectId, animalId);
  const detail = await loadAnimalDetail(animal._id);
  return toAnimalResponse(detail ?? animal, access.canViewFinancials);
};

//GET /farms/:farmId/animals/lookup/:identifier — scanner lookup inside the farm boundary
const lookupAnimal = async (
  farmId: string,
  requesterUserId: string,
  identifier: string,
) => {
  const access = await resolveAnimalAccess(farmId, requesterUserId);
  const value = String(identifier ?? "").trim().slice(0, 128);
  if (!value) {
    throw new AppError(status.BAD_REQUEST, "An identifier is required!");
  }

  //exact matches only (no regex) — scanners send the full value
  const candidates = await AnimalModel.find({
    farmId: access.farmObjectId,
    $or: [
      { animalCode: value.toUpperCase() },
      { rfid: value },
      { qrCode: value },
      { tagNumber: value },
    ],
  }).select("_id animalCode rfid qrCode tagNumber");

  //priority when different animals match different fields: system code > RFID > QR > tag
  const priority: Array<[keyof TAnimal, string]> = [
    ["animalCode", value.toUpperCase()],
    ["rfid", value],
    ["qrCode", value],
    ["tagNumber", value],
  ];
  for (const [field, expected] of priority) {
    const match = candidates.find((animal) => animal[field] === expected);
    if (match) {
      const detail = await loadAnimalDetail(match._id);
      return {
        matchedBy: field,
        animal: toAnimalResponse(detail ?? match, access.canViewFinancials),
      };
    }
  }

  throw new AppError(status.NOT_FOUND, "No animal in this farm matches that identifier!");
};

//PUT /farms/:farmId/animals/:animalId — Owner / Manager, descriptive + acquisition fields only
const updateAnimal = async (
  farmId: string,
  requesterUserId: string,
  animalId: string,
  payload: TPayload,
  context?: TAuditContext,
) => {
  const access = await resolveAnimalAccess(farmId, requesterUserId);
  requireRole(access, AnimalPermissions.EDIT_PROFILE, "edit animal profiles");
  requireWritableFarm(access);
  const animal = await findAnimalInFarm(access.farmObjectId, animalId);
  requireOperationalAnimal(animal);

  const blocked = ["animalCode", "currentWeight", "lifeStatus", "isActive", "farmId"].filter(
    (field) => payload[field] !== undefined,
  );
  if (blocked.length) {
    throw new AppError(
      status.BAD_REQUEST,
      `${blocked.join(", ")} cannot be changed through this endpoint!`,
    );
  }

  const set: TPayload = {};
  const unset: string[] = [];

  for (const field of ["name", "color", "remarks"] as const) {
    if (payload[field] === undefined) continue;
    const text = parseText(payload[field]);
    if (text === null) unset.push(field);
    else set[field] = text;
  }

  if (payload.breedId !== undefined) {
    const breedId = parseObjectIdField("breedId", payload.breedId);
    if (!breedId.equals(animal.breedId)) {
      await assertActiveBreed(breedId);
      set.breedId = breedId;
    }
  }
  if (payload.purpose !== undefined) {
    assertEnum("purpose", payload.purpose, Object.values(AnimalPurposes));
    set.purpose = payload.purpose;
  }

  for (const field of ["birthDate", "purchaseDate"] as const) {
    if (payload[field] === undefined) continue;
    if (isBlank(payload[field])) unset.push(field);
    else set[field] = parsePastDate(field, payload[field]);
  }
  if (payload.purchasePrice !== undefined) {
    if (isBlank(payload.purchasePrice)) unset.push("purchasePrice");
    else set.purchasePrice = parseNonNegativeNumber("purchasePrice", payload.purchasePrice);
  }
  if (payload.supplierId !== undefined) {
    if (isBlank(payload.supplierId)) unset.push("supplierId");
    else set.supplierId = parseObjectIdField("supplierId", payload.supplierId);
  }

  if (!Object.keys(set).length && !unset.length) {
    throw new AppError(status.BAD_REQUEST, "No updatable animal fields were provided!");
  }

  //re-check cross-field rules against the resulting state
  const nextBirthDate = unset.includes("birthDate")
    ? null
    : ((set.birthDate as Date | undefined) ?? animal.birthDate ?? null);
  const nextPurchaseDate = unset.includes("purchaseDate")
    ? null
    : ((set.purchaseDate as Date | undefined) ?? animal.purchaseDate ?? null);
  assertPurchaseAfterBirth(nextBirthDate, nextPurchaseDate);
  assertReproductiveConsistency(animal.gender, animal.reproductiveStatus, nextBirthDate);

  return applyAnimalUpdate(animal, access, set, unset, { context, event: "Animal Updated" });
};

//PATCH /farms/:farmId/animals/:animalId/identification — Owner / Manager
const updateIdentification = async (
  farmId: string,
  requesterUserId: string,
  animalId: string,
  payload: TPayload,
  context?: TAuditContext,
) => {
  const access = await resolveAnimalAccess(farmId, requesterUserId);
  requireRole(access, AnimalPermissions.EDIT_IDENTIFICATION, "change animal identification");
  requireWritableFarm(access);
  const animal = await findAnimalInFarm(access.farmObjectId, animalId);
  requireOperationalAnimal(animal);

  const set: TPayload = {};
  const unset: string[] = [];

  for (const field of ["rfid", "tagNumber"] as const) {
    if (payload[field] === undefined) continue;
    const text = parseText(payload[field]);
    if (text === null) unset.push(field);
    else if (text !== animal[field]) set[field] = text;
  }

  //qrCode is required: it can be replaced or regenerated, never cleared
  if (payload.regenerateQrCode === true) {
    const generated = generateAnimalQrCode(access.farmCode, animal.animalCode);
    if (generated !== animal.qrCode) set.qrCode = generated;
  } else if (payload.qrCode !== undefined) {
    const text = parseText(payload.qrCode);
    if (text === null) {
      throw new AppError(
        status.BAD_REQUEST,
        "qrCode cannot be removed — send regenerateQrCode: true to restore the default!",
      );
    }
    if (text !== animal.qrCode) set.qrCode = text;
  }

  if (!Object.keys(set).length && !unset.length) {
    throw new AppError(status.BAD_REQUEST, "No identification changes were provided!");
  }

  await assertIdentifiersAvailable(
    access.farmObjectId,
    {
      rfid: (set.rfid as string | undefined) ?? null,
      tagNumber: (set.tagNumber as string | undefined) ?? null,
      qrCode: (set.qrCode as string | undefined) ?? null,
    },
    animal._id,
  );

  return applyAnimalUpdate(animal, access, set, unset, { context, event: "Animal Identification Updated" });
};

//PATCH /farms/:farmId/animals/:animalId/location — Owner / Manager / Worker
const updateLocation = async (
  farmId: string,
  requesterUserId: string,
  animalId: string,
  payload: TPayload,
  context?: TAuditContext,
) => {
  const access = await resolveAnimalAccess(farmId, requesterUserId);
  requireRole(access, AnimalPermissions.MOVE, "move animals");
  requireWritableFarm(access);
  const animal = await findAnimalInFarm(access.farmObjectId, animalId);
  requireOperationalAnimal(animal);

  const location = parseLocation(payload);
  if (!location || !Object.keys(location).length) {
    throw new AppError(
      status.BAD_REQUEST,
      "Provide at least one of shed, pen or stall!",
    );
  }

  //the whole object is replaced: it is the current location, not a merge of history
  return applyAnimalUpdate(animal, access, { location }, [], { context, event: "Location Changed" });
};

const parseIdList = (field: string, value: unknown): string[] => {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((id) => {
    if (typeof id !== "string" || !isValidObjectId(id)) {
      throw new AppError(status.BAD_REQUEST, `${field} must contain valid gallery ids!`);
    }
    return id;
  });
};

/**
 * PATCH /farms/:farmId/animals/:animalId/media — Owner / Manager / Worker
 *
 * multipart files: `profilePhoto` (1) and `gallery` (up to 10)
 * body (JSON or `data` JSON string):
 *   profilePhoto      http(s) URL to set, or null to remove (ignored when a file is uploaded)
 *   galleryCaptions   captions for uploaded gallery files, same order
 *   galleryAdd        [{ url, caption? }] images already hosted elsewhere
 *   galleryRemove     [galleryItemId]
 */
const updateMedia = async (
  farmId: string,
  requesterUserId: string,
  animalId: string,
  payload: TPayload,
  files: TUploadedFiles = {},
  context?: TAuditContext,
) => {
  const profileFile = files.profilePhoto?.[0];
  const galleryFiles = files.gallery ?? [];
  const allFiles = [...(profileFile ? [profileFile] : []), ...galleryFiles];

  try {
    await assertImageFiles(allFiles);
    const access = await resolveAnimalAccess(farmId, requesterUserId);
    requireRole(access, AnimalPermissions.MEDIA, "update animal media");
    requireWritableFarm(access);
    const animal = await findAnimalInFarm(access.farmObjectId, animalId);
    requireOperationalAnimal(animal);

    //validate everything before uploading anything
    const removeIds = parseIdList("galleryRemove", payload.galleryRemove);
    const existingIds = new Set(animal.gallery.map((item) => String(item._id)));
    const missing = removeIds.find((id) => !existingIds.has(id));
    if (missing) {
      throw new AppError(status.NOT_FOUND, `Gallery item ${missing} not found!`);
    }

    const addByUrl = (
      Array.isArray(payload.galleryAdd) ? payload.galleryAdd : payload.galleryAdd ? [payload.galleryAdd] : []
    ).map((item, index) => {
      if (!item || typeof item !== "object") {
        throw new AppError(status.BAD_REQUEST, "galleryAdd items must be objects!");
      }
      const raw = item as TPayload;
      return {
        url: parseImageUrl(`galleryAdd[${index}].url`, raw.url),
        caption: parseText(raw.caption)?.slice(0, 200),
      };
    });

    const captions = Array.isArray(payload.galleryCaptions)
      ? payload.galleryCaptions
      : [];

    const finalCount =
      animal.gallery.length - removeIds.length + addByUrl.length + galleryFiles.length;
    if (finalCount > MAX_GALLERY_ITEMS) {
      throw new AppError(
        status.BAD_REQUEST,
        `An animal can have at most ${MAX_GALLERY_ITEMS} gallery images!`,
      );
    }

    let profilePhotoChange: string | null | undefined;
    if (profileFile) {
      profilePhotoChange = await uploadAnimalImage(
        profileFile,
        access.farmCode,
        animal.animalCode,
        "profile",
      );
    } else if (payload.profilePhoto !== undefined) {
      profilePhotoChange = isBlank(payload.profilePhoto)
        ? null
        : parseImageUrl("profilePhoto", payload.profilePhoto);
    }

    const uploadedAt = new Date();
    const newItems: Array<{ url: string; caption?: string; uploadedAt: Date }> = [];
    for (const [index, file] of galleryFiles.entries()) {
      const url = await uploadAnimalImage(
        file,
        access.farmCode,
        animal.animalCode,
        `gallery-${index}`,
      );
      const caption = parseText(captions[index])?.slice(0, 200);
      newItems.push({ url, uploadedAt, ...(caption ? { caption } : {}) });
    }
    for (const item of addByUrl) {
      newItems.push({ url: item.url, uploadedAt, ...(item.caption ? { caption: item.caption } : {}) });
    }

    if (profilePhotoChange === undefined && !newItems.length && !removeIds.length) {
      throw new AppError(status.BAD_REQUEST, "No media changes were provided!");
    }

    //remove + push in sequence: MongoDB rejects $pull and $push on the same path in one update
    if (removeIds.length) {
      await AnimalModel.updateOne(
        { _id: animal._id, farmId: access.farmObjectId },
        { $pull: { gallery: { _id: { $in: removeIds.map((id) => new Types.ObjectId(id)) } } } },
      );
    }
    if (newItems.length) {
      await AnimalModel.updateOne(
        { _id: animal._id, farmId: access.farmObjectId },
        { $push: { gallery: { $each: newItems } } },
      );
    }

    const set: TPayload = {};
    const unset: string[] = [];
    if (profilePhotoChange === null) unset.push("profilePhoto");
    else if (profilePhotoChange !== undefined) set.profilePhoto = profilePhotoChange;

    const photoChanged = profilePhotoChange !== undefined;
    const galleryChanged = newItems.length > 0 || removeIds.length > 0;
    return applyAnimalUpdate(animal, access, set, unset, {
      context,
      event: !galleryChanged ? "Profile Photo Updated" : photoChanged ? "Animal Media Updated" : "Animal Gallery Updated",
      ...(galleryChanged
        ? {
            extra: {
              oldData: {
                galleryRemoved: animal.gallery
                  .filter((item) => removeIds.includes(String(item._id)))
                  .map((item) => item.url),
              },
              newData: { galleryAdded: newItems.map((item) => item.url) },
              changedFields: ["gallery"],
            },
          }
        : {}),
    });
  } finally {
    await removeLocalFiles(allFiles);
  }
};

//PATCH /farms/:farmId/animals/:animalId/lifecycle — Owner / Manager
const updateLifecycle = async (
  farmId: string,
  requesterUserId: string,
  animalId: string,
  payload: TPayload,
  context?: TAuditContext,
) => {
  const access = await resolveAnimalAccess(farmId, requesterUserId);
  requireRole(access, AnimalPermissions.LIFECYCLE, "change an animal's life status");
  requireWritableFarm(access);
  const animal = await findAnimalInFarm(access.farmObjectId, animalId);

  assertEnum("lifeStatus", payload.lifeStatus, Object.values(AnimalLifeStatuses));
  const next = payload.lifeStatus as TAnimalLifeStatus;
  const current = animal.lifeStatus;

  if (next === current) {
    throw new AppError(status.CONFLICT, `Animal is already ${current}!`);
  }
  const allowed = AllowedLifeStatusTransitions[current] ?? [];
  if (!allowed.includes(next)) {
    throw new AppError(
      status.CONFLICT,
      allowed.length
        ? `Cannot change life status from ${current} to ${next}! Allowed: ${allowed.join(", ")}.`
        : `${current} is a final life status and cannot be changed!`,
    );
  }

  //isActive is always derived from lifeStatus — never set independently
  const set: TPayload = {
    lifeStatus: next,
    isActive: next === AnimalLifeStatuses.ACTIVE,
  };
  const remarks = parseText(payload.remarks);
  if (remarks) set.remarks = remarks;

  // TODO(DeviceAssignment): close active IoT device assignments when leaving Active (Model 26).
  //Sold here books no money: POST /incomes/animal-sale does both, and /incomes/reconciliation
  //flags animals marked Sold without an income.
  const events: Partial<Record<TAnimalLifeStatus, string>> = {
    [AnimalLifeStatuses.ACTIVE]: "Animal Reactivated",
    [AnimalLifeStatuses.DEAD]: "Animal Marked Dead",
  };
  return applyAnimalUpdate(animal, access, set, [], {
    context,
    event: events[next] ?? `Animal ${next}`,
    action: next === AnimalLifeStatuses.ARCHIVED ? AuditActions.ARCHIVE : AuditActions.UPDATE,
  });
};

//PATCH /farms/:farmId/animals/:animalId/status — Owner / Manager / Veterinarian
const updateStatus = async (
  farmId: string,
  requesterUserId: string,
  animalId: string,
  payload: TPayload,
  context?: TAuditContext,
) => {
  const access = await resolveAnimalAccess(farmId, requesterUserId);
  requireRole(access, AnimalPermissions.STATUS, "change health or reproductive status");
  requireWritableFarm(access);
  const animal = await findAnimalInFarm(access.farmObjectId, animalId);
  requireOperationalAnimal(animal);

  const set: TPayload = {};
  if (payload.healthStatus !== undefined) {
    assertEnum("healthStatus", payload.healthStatus, Object.values(AnimalHealthStatuses));
    if (payload.healthStatus !== animal.healthStatus) set.healthStatus = payload.healthStatus;
  }
  if (payload.reproductiveStatus !== undefined) {
    assertEnum(
      "reproductiveStatus",
      payload.reproductiveStatus,
      Object.values(AnimalReproductiveStatuses),
    );
    const next = payload.reproductiveStatus as TAnimalReproductiveStatus;
    assertReproductiveConsistency(animal.gender, next, animal.birthDate ?? null);
    if (next !== animal.reproductiveStatus) set.reproductiveStatus = next;
  }

  if (!Object.keys(set).length) {
    throw new AppError(
      status.BAD_REQUEST,
      "Provide a healthStatus or reproductiveStatus different from the current one!",
    );
  }

  return applyAnimalUpdate(animal, access, set, [], {
    context,
    event: set.healthStatus ? "Health Status Changed" : "Reproductive Status Changed",
  });
};

//DELETE /farms/:farmId/animals/:animalId — Owner only; soft delete => Archived + isActive false
const archiveAnimal = async (
  farmId: string,
  requesterUserId: string,
  animalId: string,
  context?: TAuditContext,
) => {
  const access = await resolveAnimalAccess(farmId, requesterUserId);
  requireRole(access, AnimalPermissions.ARCHIVE, "remove animals");
  requireWritableFarm(access);
  const animal = await findAnimalInFarm(access.farmObjectId, animalId);

  if (animal.lifeStatus === AnimalLifeStatuses.ARCHIVED) {
    throw new AppError(status.CONFLICT, "Animal is already archived!");
  }
  //keep Sold/Dead/Transferred intact — overwriting them would lose the real exit reason
  if (animal.lifeStatus !== AnimalLifeStatuses.ACTIVE) {
    throw new AppError(
      status.CONFLICT,
      `Animal is already ${animal.lifeStatus} and out of active operations!`,
    );
  }

  return applyAnimalUpdate(
    animal,
    access,
    { lifeStatus: AnimalLifeStatuses.ARCHIVED, isActive: false },
    [],
    { context, event: "Animal Archived", action: AuditActions.ARCHIVE },
  );
};

export const AnimalServices = {
  createAnimal,
  getFarmAnimals,
  getAnimalMeta,
  getAnimalStats,
  getAnimalById,
  lookupAnimal,
  updateAnimal,
  updateIdentification,
  updateLocation,
  updateMedia,
  updateLifecycle,
  updateStatus,
  archiveAnimal,
};
