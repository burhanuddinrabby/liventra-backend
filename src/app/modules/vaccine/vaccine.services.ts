import status from "http-status";
import mongoose, { isValidObjectId, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import AppError from "../../errors/AppError.js";
import QueryBuilder from "../../builder/QueryBuilder.js";
import { AuditLogModel } from "../auditLog/auditLog.model.js";
import {
  AuditActions,
  AuditEntityTypes,
  AuditModules,
} from "../auditLog/auditLog.constants.js";
import { recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext } from "../auditLog/auditLog.utils.js";
import { VaccineModel } from "./vaccine.model.js";
import {
  DISEASE_COLLECTION,
  VACCINE_LIMITS,
  VACCINE_PROTOCOL_FIELDS,
  VACCINE_REFERENCE_SOURCES,
  VaccineAdministrationRouteLabels,
  VaccineAdministrationRoutes,
  VaccineCategories,
  VaccineDosageUnits,
} from "./vaccine.constants.js";
import type { TVaccine, TVaccineUsage } from "./vaccine.interface.js";
import {
  computeVaccineSchedule,
  escapeRegex,
  generateVaccineCode,
  normalizeText,
} from "./vaccine.utils.js";

type TPayload = Record<string, unknown>;
type TVaccineDoc = HydratedDocument<TVaccine>;

/* ------------------------------------------------------------------ */
/* Field whitelists                                                    */
/* ------------------------------------------------------------------ */

//fields a client may write through POST / PUT. vaccineCode, timestamps and isActive
//are never accepted (isActive is owned by PATCH /:id/toggle-active).
const WRITABLE_FIELDS = [
  "vaccineName",
  "shortCode",
  "targetDiseaseIds",
  "manufacturer",
  "category",
  "dosage",
  "dosageUnit",
  "administrationRoute",
  "minimumAge",
  "boosterRequired",
  "boosterAfterDays",
  "repeatIntervalDays",
  "storageTemperature",
  "description",
  "isMandatory",
] as const;

//optional fields a PUT may clear by sending null / ""
const CLEARABLE_FIELDS = new Set<string>([
  "manufacturer",
  "minimumAge",
  "boosterAfterDays",
  "repeatIntervalDays",
  "description",
]);

const SORT_FIELDS = new Set([
  "vaccineName",
  "vaccineCode",
  "shortCode",
  "category",
  "manufacturer",
  "dosage",
  "minimumAge",
  "boosterAfterDays",
  "repeatIntervalDays",
  "isMandatory",
  "isActive",
  "createdAt",
  "updatedAt",
]);

//select list for Vaccination forms / compliance checklists
const LOOKUP_FIELDS =
  "vaccineCode vaccineName shortCode category targetDiseaseIds dosage dosageUnit administrationRoute minimumAge boosterRequired boosterAfterDays repeatIntervalDays storageTemperature isMandatory";

/* ------------------------------------------------------------------ */
/* Parsing helpers                                                     */
/* ------------------------------------------------------------------ */

const parseBoolean = (value: unknown): boolean | undefined => {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
};

const isBlank = (value: unknown) =>
  value === null || (typeof value === "string" && value.trim() === "");

const parseNumber = (
  field: string,
  value: unknown,
  { min, max, integer, exclusiveMin }: { min: number; max: number; integer?: boolean; exclusiveMin?: boolean },
): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (typeof value === "boolean" || isBlank(value) || !Number.isFinite(parsed)) {
    throw new AppError(status.BAD_REQUEST, `${field} must be a valid number!`);
  }
  if (exclusiveMin ? parsed <= min : parsed < min) {
    throw new AppError(
      status.BAD_REQUEST,
      `${field} must be ${exclusiveMin ? "greater than" : "at least"} ${min}!`,
    );
  }
  if (parsed > max) throw new AppError(status.BAD_REQUEST, `${field} cannot exceed ${max}!`);
  if (integer && !Number.isInteger(parsed)) {
    throw new AppError(status.BAD_REQUEST, `${field} must be a whole number!`);
  }
  return parsed;
};

const assertEnum = (field: string, value: unknown, allowed: readonly string[]) => {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new AppError(status.BAD_REQUEST, `${field} must be one of: ${allowed.join(", ")}!`);
  }
};

const parseString = (field: string, value: unknown, min: number, max: number): string => {
  if (typeof value !== "string") throw new AppError(status.BAD_REQUEST, `${field} must be a string!`);
  const text = normalizeText(value);
  if (text.length < min || text.length > max) {
    throw new AppError(status.BAD_REQUEST, `${field} must be ${min}-${max} characters!`);
  }
  return text;
};

const parseObjectIdList = (field: string, value: unknown): Types.ObjectId[] => {
  if (!Array.isArray(value)) throw new AppError(status.BAD_REQUEST, `${field} must be an array!`);
  if (value.length > 50) throw new AppError(status.BAD_REQUEST, `${field} cannot exceed 50 items!`);
  const unique = new Map<string, Types.ObjectId>();
  for (const item of value) {
    if (typeof item !== "string" || !isValidObjectId(item)) {
      throw new AppError(status.BAD_REQUEST, `${field} must contain valid ObjectIds!`);
    }
    unique.set(item.toLowerCase(), new Types.ObjectId(item));
  }
  return [...unique.values()];
};

/**
 * validateRequest only parses and discards, so the raw body still carries unknown
 * keys and uncoerced values. Whitelist + coerce here.
 * Returns `set` (values to write) and `unset` (optional fields explicitly cleared).
 */
const pickFields = (
  payload: TPayload,
  allowClear: boolean,
): { set: Record<string, unknown>; unset: string[] } => {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];

  for (const field of WRITABLE_FIELDS) {
    const value = payload[field];
    if (value === undefined) continue;

    if (isBlank(value) && CLEARABLE_FIELDS.has(field)) {
      if (allowClear) unset.push(field);
      continue;
    }

    switch (field) {
      case "vaccineName":
        set[field] = parseString(field, value, 2, 150);
        break;
      case "shortCode": {
        const code = parseString(field, value, 1, 20).toUpperCase();
        if (!/^[A-Z0-9][A-Z0-9-]*$/.test(code)) {
          throw new AppError(status.BAD_REQUEST, "shortCode may only contain letters, digits and hyphens!");
        }
        set[field] = code;
        break;
      }
      case "manufacturer":
        set[field] = parseString(field, value, 1, 150);
        break;
      case "storageTemperature":
        set[field] = parseString(field, value, 1, 50);
        break;
      case "description":
        if (typeof value !== "string") {
          throw new AppError(status.BAD_REQUEST, "description must be a string!");
        }
        set[field] = value.trim().slice(0, 2000);
        break;
      case "targetDiseaseIds":
        set[field] = parseObjectIdList(field, value);
        break;
      case "category":
        assertEnum(field, value, Object.values(VaccineCategories));
        set[field] = value;
        break;
      case "dosageUnit":
        assertEnum(field, value, Object.values(VaccineDosageUnits));
        set[field] = value;
        break;
      case "administrationRoute":
        assertEnum(field, value, Object.values(VaccineAdministrationRoutes));
        set[field] = value;
        break;
      case "dosage":
        set[field] = parseNumber(field, value, { min: 0, max: VACCINE_LIMITS.maxDosage, exclusiveMin: true });
        break;
      case "minimumAge":
        set[field] = parseNumber(field, value, { min: 0, max: VACCINE_LIMITS.maxMinimumAgeMonths });
        break;
      case "boosterAfterDays":
      case "repeatIntervalDays":
        set[field] = parseNumber(field, value, {
          min: 1,
          max: VACCINE_LIMITS.maxIntervalDays,
          integer: true,
        });
        break;
      case "boosterRequired":
      case "isMandatory": {
        const parsed = parseBoolean(value);
        if (parsed === undefined) throw new AppError(status.BAD_REQUEST, `${field} must be a boolean!`);
        set[field] = parsed;
        break;
      }
    }
  }

  return { set, unset };
};

/**
 * Booster conditional rule (spec §67/§88): boosterRequired=true needs a positive
 * boosterAfterDays; boosterRequired=false must not carry a fake booster interval,
 * so it is cleared. Mutates set/unset in place using the effective (merged) values.
 */
const applyBoosterRule = (
  set: Record<string, unknown>,
  unset: string[],
  current?: Pick<TVaccine, "boosterRequired" | "boosterAfterDays">,
) => {
  const boosterRequired = (set.boosterRequired as boolean | undefined) ?? current?.boosterRequired ?? false;
  const boosterAfterDays = unset.includes("boosterAfterDays")
    ? undefined
    : ((set.boosterAfterDays as number | undefined) ?? current?.boosterAfterDays);

  if (boosterRequired && !boosterAfterDays) {
    throw new AppError(
      status.BAD_REQUEST,
      "boosterAfterDays is required when boosterRequired is true!",
    );
  }
  if (!boosterRequired) {
    delete set.boosterAfterDays;
    if (current?.boosterAfterDays !== undefined && !unset.includes("boosterAfterDays")) {
      unset.push("boosterAfterDays");
    }
  }
};

/* ------------------------------------------------------------------ */
/* Integrity helpers                                                   */
/* ------------------------------------------------------------------ */

const diseaseCollection = () => mongoose.connection.db?.collection(DISEASE_COLLECTION);

/**
 * Every targetDiseaseIds entry must reference an existing, active Disease (spec §13/§87).
 * The Disease module is not built yet, so the raw `diseases` collection is read.
 */
const assertDiseasesExist = async (ids: Types.ObjectId[]) => {
  if (!ids.length) return;
  const collection = diseaseCollection();
  const found = collection
    ? await collection
        .find({ _id: { $in: ids } }, { projection: { _id: 1, isActive: 1 } })
        .toArray()
    : [];
  const byId = new Map(found.map((doc) => [String(doc._id), doc]));

  const missing = ids.filter((id) => !byId.has(String(id)));
  if (missing.length) {
    throw new AppError(
      status.BAD_REQUEST,
      `Unknown disease reference(s) in targetDiseaseIds: ${missing.join(", ")}!`,
    );
  }
  const inactive = ids.filter((id) => byId.get(String(id))?.isActive === false);
  if (inactive.length) {
    throw new AppError(
      status.BAD_REQUEST,
      `Inactive disease(s) cannot be targeted: ${inactive.join(", ")}!`,
    );
  }
};

//slim disease info for the detail view (raw read: Disease model not registered yet)
const loadTargetDiseases = async (ids: Types.ObjectId[]) => {
  const collection = diseaseCollection();
  if (!ids.length || !collection) return [];
  try {
    return await collection
      .find(
        { _id: { $in: ids } },
        { projection: { diseaseCode: 1, diseaseName: 1, severity: 1, contagious: 1, isActive: 1 } },
      )
      .toArray();
  } catch {
    return [];
  }
};

//name and shortCode are both unique catalog keys (retired records included)
const assertUniqueKeys = async (
  values: { vaccineName?: string; shortCode?: string },
  excludeId?: Types.ObjectId,
) => {
  const exclude = excludeId ? { _id: { $ne: excludeId } } : {};

  if (values.vaccineName) {
    const existing = await VaccineModel.findOne({
      vaccineName: new RegExp(`^${escapeRegex(values.vaccineName)}$`, "i"),
      ...exclude,
    })
      .collation({ locale: "en", strength: 2 })
      .select("vaccineCode vaccineName isActive")
      .lean();
    if (existing) {
      throw new AppError(
        status.CONFLICT,
        `Vaccine already exists as "${existing.vaccineName}" (${existing.vaccineCode})${existing.isActive ? "" : " — it is retired; reactivate it instead"}!`,
      );
    }
  }

  if (values.shortCode) {
    const existing = await VaccineModel.findOne({ shortCode: values.shortCode, ...exclude })
      .select("vaccineCode vaccineName")
      .lean();
    if (existing) {
      throw new AppError(
        status.CONFLICT,
        `Short code "${values.shortCode}" is already used by "${existing.vaccineName}" (${existing.vaccineCode})!`,
      );
    }
  }
};

const duplicateField = (error: unknown): string | null => {
  if (typeof error === "object" && error !== null && (error as { code?: number }).code === 11000) {
    const keyValue = (error as { keyValue?: Record<string, unknown> }).keyValue;
    return (keyValue ? Object.keys(keyValue)[0] : undefined) ?? "unknown";
  }
  return null;
};

const toDuplicateKeyError = (error: unknown): AppError | null => {
  const field = duplicateField(error);
  if (!field) return null;
  const messages: Record<string, string> = {
    vaccineCode: "Vaccine code already exists, please retry!",
    shortCode: "Vaccine short code already exists!",
  };
  return new AppError(status.CONFLICT, messages[field] ?? "Vaccine name already exists!");
};

/**
 * Counts documents referencing this vaccine in Vaccination, Disease
 * (recommendedVaccineIds) and Inventory. Those modules are not implemented yet, so
 * the raw collections are queried (a collection that does not exist yet counts 0).
 */
const countVaccineUsage = async (vaccineId: Types.ObjectId): Promise<TVaccineUsage> => {
  const db = mongoose.connection.db;
  const counts = await Promise.all(
    VACCINE_REFERENCE_SOURCES.map(async (source) => {
      if (!db) return 0;
      try {
        return await db.collection(source.collection).countDocuments(source.filter(vaccineId));
      } catch {
        return 0;
      }
    }),
  );

  const usage: TVaccineUsage = { vaccinations: 0, diseases: 0, inventories: 0, total: 0 };
  VACCINE_REFERENCE_SOURCES.forEach((source, index) => {
    const count = counts[index] ?? 0;
    usage[source.key] = count;
    usage.total += count;
  });
  return usage;
};

//plain snapshot for audit oldData/newData (ObjectIds/Dates become strings)
const snapshot = (doc: TVaccineDoc | null, fields?: readonly string[]) => {
  if (!doc) return null;
  const plain = JSON.parse(JSON.stringify(doc.toObject())) as Record<string, unknown>;
  delete plain.__v;
  if (!fields) return plain;
  return Object.fromEntries(fields.map((field) => [field, plain[field] ?? null]));
};

//values equal for audit purposes (ObjectId vs string, undefined vs missing)
const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

//resolves either a Mongo _id or a public vaccineCode (VAC-00001)
const findVaccineByRef = async (ref: string): Promise<TVaccineDoc> => {
  const value = String(ref ?? "").trim();
  if (!value) throw new AppError(status.BAD_REQUEST, "Vaccine id or code is required!");

  const vaccine = isValidObjectId(value)
    ? await VaccineModel.findById(value)
    : await VaccineModel.findOne({ vaccineCode: value.toUpperCase() });

  if (!vaccine) throw new AppError(status.NOT_FOUND, "Vaccine not found!");
  return vaccine;
};

//full reference configuration + resolved target diseases + human route label
const getVaccine = async (ref: string) => {
  const vaccine = await findVaccineByRef(ref);
  const targetDiseases = await loadTargetDiseases(vaccine.targetDiseaseIds);
  return {
    ...vaccine.toObject(),
    administrationRouteLabel: VaccineAdministrationRouteLabels[vaccine.administrationRoute],
    targetDiseases,
  };
};

const multiEnumFilter = (raw: unknown, allowed: readonly string[]) => {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  //comma-separated multi-select; unknown values are ignored rather than erroring
  const values = raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => allowed.includes(v));
  if (!values.length) return undefined;
  return values.length === 1 ? values[0] : { $in: values };
};

//?targetDiseaseId= (alias ?diseaseTarget=) — one or more Disease ObjectIds, comma-separated
const diseaseFilter = (query: TPayload) => {
  const raw = query.targetDiseaseId ?? query.diseaseTarget;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const ids = raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => isValidObjectId(v))
    .map((v) => new Types.ObjectId(v));
  if (!ids.length) {
    throw new AppError(status.BAD_REQUEST, "targetDiseaseId must be a valid Disease ObjectId!");
  }
  return ids.length === 1 ? ids[0] : { $in: ids };
};

const getAllVaccines = async (query: TPayload) => {
  const filter: Record<string, unknown> = {};

  const enumFilters = [
    ["category", Object.values(VaccineCategories)],
    ["dosageUnit", Object.values(VaccineDosageUnits)],
    ["administrationRoute", Object.values(VaccineAdministrationRoutes)],
  ] as const;
  for (const [field, allowed] of enumFilters) {
    const value = multiEnumFilter(query[field], allowed);
    if (value !== undefined) filter[field] = value;
  }

  for (const field of ["isMandatory", "boosterRequired"] as const) {
    const value = parseBoolean(query[field]);
    if (value !== undefined) filter[field] = value;
  }

  //retired vaccines are hidden unless explicitly requested (isActive=false|all)
  if (String(query.isActive).toLowerCase() !== "all") {
    filter.isActive = parseBoolean(query.isActive) ?? true;
  }

  const disease = diseaseFilter(query);
  if (disease !== undefined) filter.targetDiseaseIds = disease;

  const listQuery: TPayload = {};
  const rawSearch = query.searchTerm ?? query.search;
  if (typeof rawSearch === "string" && rawSearch.trim()) {
    //QueryBuilder interpolates this straight into $regex
    listQuery.searchTerm = escapeRegex(rawSearch.trim().slice(0, 100));
  }

  const sortTokens = String(query.sort ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => SORT_FIELDS.has(token.replace(/^-/, "")));
  listQuery.sort = sortTokens.length ? sortTokens.join(",") : "vaccineName";
  listQuery.page = Math.max(Number(query.page) || 1, 1);
  listQuery.limit = Math.min(Math.max(Number(query.limit) || 10, 1), 100);

  if (typeof query.fields === "string" && query.fields.trim()) {
    listQuery.fields = query.fields
      .split(",")
      .map((f) => f.trim())
      .filter((f) => /^-?[A-Za-z]+$/.test(f))
      .join(",");
  }

  const vaccineQuery = new QueryBuilder<TVaccine>(VaccineModel.find(filter), listQuery)
    .search(["vaccineName", "vaccineCode", "shortCode", "manufacturer"])
    .filter()
    .sort()
    .paginate()
    .fields();

  const [meta, vaccines] = await Promise.all([vaccineQuery.countTotal(), vaccineQuery.modelQuery]);
  return { meta, vaccines };
};

/**
 * Slim selector payload for Vaccination forms / compliance checklists.
 * Only active vaccines (spec §86: inactive vaccines are not selectable for new events).
 */
const getVaccineLookup = async (query: TPayload) => {
  const filter: Record<string, unknown> = { isActive: true };

  const category = multiEnumFilter(query.category, Object.values(VaccineCategories));
  if (category !== undefined) filter.category = category;
  const isMandatory = parseBoolean(query.isMandatory);
  if (isMandatory !== undefined) filter.isMandatory = isMandatory;
  const disease = diseaseFilter(query);
  if (disease !== undefined) filter.targetDiseaseIds = disease;

  const searchTerm = typeof query.searchTerm === "string" ? query.searchTerm.trim() : "";
  if (searchTerm) {
    const regex = new RegExp(escapeRegex(searchTerm.slice(0, 100)), "i");
    filter.$or = [{ vaccineName: regex }, { vaccineCode: regex }, { shortCode: regex }];
  }

  return VaccineModel.find(filter).select(LOOKUP_FIELDS).sort({ vaccineName: 1 }).limit(200).lean();
};

//single source of truth for the enums the frontend renders
const getVaccineMeta = () => ({
  categories: Object.values(VaccineCategories),
  dosageUnits: Object.values(VaccineDosageUnits),
  administrationRoutes: Object.values(VaccineAdministrationRoutes).map((value) => ({
    value,
    label: VaccineAdministrationRouteLabels[value],
  })),
  units: { minimumAge: "months", boosterAfterDays: "days", repeatIntervalDays: "days" },
  limits: VACCINE_LIMITS,
});

const getVaccineStats = async () => {
  const [summaryRows, categoryRows] = await Promise.all([
    VaccineModel.aggregate<{
      total: number;
      active: number;
      retired: number;
      mandatory: number;
      withBooster: number;
    }>([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: ["$isActive", 1, 0] } },
          retired: { $sum: { $cond: ["$isActive", 0, 1] } },
          //compliance numbers only count catalog-active vaccines
          mandatory: { $sum: { $cond: [{ $and: ["$isActive", "$isMandatory"] }, 1, 0] } },
          withBooster: { $sum: { $cond: [{ $and: ["$isActive", "$boosterRequired"] }, 1, 0] } },
        },
      },
    ]),
    VaccineModel.aggregate<{ _id: string; count: number; mandatory: number }>([
      { $match: { isActive: true } },
      {
        $group: {
          _id: "$category",
          count: { $sum: 1 },
          mandatory: { $sum: { $cond: ["$isMandatory", 1, 0] } },
        },
      },
    ]),
  ]);

  const summary = summaryRows[0] ?? { total: 0, active: 0, retired: 0, mandatory: 0, withBooster: 0 };
  const byCategoryMap = new Map(categoryRows.map((row) => [row._id, row]));

  return {
    total: summary.total,
    active: summary.active,
    retired: summary.retired,
    mandatory: summary.mandatory,
    withBooster: summary.withBooster,
    //every category present (count 0 included), in enum order; active vaccines only
    byCategory: Object.values(VaccineCategories).map((category) => ({
      category,
      count: byCategoryMap.get(category)?.count ?? 0,
      mandatory: byCategoryMap.get(category)?.mandatory ?? 0,
    })),
  };
};

/**
 * GET /:id/schedule-preview?administeredDate=YYYY-MM-DD&animalAgeMonths=6
 * Read-only: shows the booster/repeat due dates the Vaccination module will derive.
 */
const getSchedulePreview = async (ref: string, query: TPayload) => {
  const vaccine = await findVaccineByRef(ref);

  let administeredDate = new Date();
  if (typeof query.administeredDate === "string" && query.administeredDate.trim()) {
    administeredDate = new Date(query.administeredDate);
    if (Number.isNaN(administeredDate.getTime())) {
      throw new AppError(status.BAD_REQUEST, "administeredDate must be a valid date!");
    }
  }

  let animalAgeMonths: number | undefined;
  if (query.animalAgeMonths !== undefined && query.animalAgeMonths !== "") {
    animalAgeMonths = parseNumber("animalAgeMonths", query.animalAgeMonths, {
      min: 0,
      max: VACCINE_LIMITS.maxMinimumAgeMonths,
    });
  }

  return {
    vaccine: {
      _id: vaccine._id,
      vaccineCode: vaccine.vaccineCode,
      vaccineName: vaccine.vaccineName,
      isActive: vaccine.isActive,
    },
    ...computeVaccineSchedule(vaccine, administeredDate, animalAgeMonths),
  };
};

const getVaccineUsage = async (ref: string) => {
  const vaccine = await findVaccineByRef(ref);
  const usage = await countVaccineUsage(vaccine._id);
  return {
    _id: vaccine._id,
    vaccineCode: vaccine.vaccineCode,
    vaccineName: vaccine.vaccineName,
    usage,
    canHardDelete: usage.total === 0,
  };
};

//change history of one vaccine (admin only), newest first
const getVaccineAuditLogs = async (ref: string, query: TPayload) => {
  const vaccine = await findVaccineByRef(ref);
  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
  const filter = { entityType: AuditEntityTypes.VACCINE, entityId: vaccine._id };

  const [total, logs] = await Promise.all([
    AuditLogModel.countDocuments(filter),
    AuditLogModel.find(filter)
      .select("-__v -ipAddress -userAgent")
      //actor identity only — no contact details in the audit timeline
      .populate("userId", "userId fullName systemRole")
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
  ]);

  return {
    meta: { page, limit, totalEntries: total, totalPage: Math.ceil(total / limit) },
    logs,
  };
};

/* ------------------------------------------------------------------ */
/* Write                                                               */
/* ------------------------------------------------------------------ */

const REQUIRED_ON_CREATE = [
  "vaccineName",
  "shortCode",
  "category",
  "dosage",
  "dosageUnit",
  "administrationRoute",
  "storageTemperature",
] as const;

const createVaccine = async (payload: TPayload, context: TAuditContext) => {
  const { set, unset } = pickFields(payload ?? {}, false);

  for (const field of REQUIRED_ON_CREATE) {
    if (set[field] === undefined) throw new AppError(status.BAD_REQUEST, `${field} is required!`);
  }
  applyBoosterRule(set, unset);

  await assertUniqueKeys({
    vaccineName: set.vaccineName as string,
    shortCode: set.shortCode as string,
  });
  await assertDiseasesExist((set.targetDiseaseIds as Types.ObjectId[] | undefined) ?? []);

  //retry when two creations race for the same generated code
  let created: TVaccineDoc | null = null;
  for (let attempt = 0; attempt < 3 && !created; attempt++) {
    const vaccineCode = await generateVaccineCode();
    try {
      created = await VaccineModel.create({
        ...set,
        vaccineCode,
        boosterRequired: (set.boosterRequired as boolean | undefined) ?? false,
        isMandatory: (set.isMandatory as boolean | undefined) ?? false,
        isActive: true,
      });
    } catch (error) {
      if (duplicateField(error) === "vaccineCode" && attempt < 2) continue;
      throw toDuplicateKeyError(error) ?? error;
    }
  }
  if (!created) throw new AppError(status.CONFLICT, "Could not generate a vaccine code, please retry!");

  await recordAuditLog({
    context,
    entityType: AuditEntityTypes.VACCINE,
    entityId: created._id,
    action: AuditActions.CREATE,
    module: AuditModules.HEALTH,
    event: "Vaccine Created",
    newData: snapshot(created),
  });

  return created;
};

//most specific audit label wins (spec §75); changedFields carries the full detail
const updateEventLabel = (changed: string[]) => {
  const has = (...fields: string[]) => fields.some((f) => changed.includes(f));
  if (has("targetDiseaseIds")) return "Target Disease Changed";
  if (has("dosage", "dosageUnit")) return "Dosage Changed";
  if (has("administrationRoute")) return "Route Changed";
  if (has("boosterRequired", "boosterAfterDays")) return "Booster Rule Changed";
  if (has("repeatIntervalDays")) return "Repeat Interval Changed";
  if (has("isMandatory")) return "Mandatory Status Changed";
  if (has("manufacturer")) return "Manufacturer Changed";
  return "Vaccine Updated";
};

/**
 * Updates master data. Historical protection (spec §74/§91): Vaccination records
 * keep their own administeredDate / nextDueDate, so nothing is recalculated here —
 * new intervals/dosage only apply to future scheduling. Every change is audited.
 */
const updateVaccine = async (ref: string, payload: TPayload, context: TAuditContext) => {
  const vaccine = await findVaccineByRef(ref);
  const { set, unset } = pickFields(payload ?? {}, true);

  if (!Object.keys(set).length && !unset.length) {
    throw new AppError(status.BAD_REQUEST, "No updatable vaccine fields were provided!");
  }
  applyBoosterRule(set, unset, vaccine);

  const before = snapshot(vaccine) ?? {};
  const changedFields = [
    ...Object.keys(set).filter(
      (field) => !sameValue(before[field], JSON.parse(JSON.stringify(set[field]))),
    ),
    ...unset.filter((field) => before[field] !== undefined && before[field] !== null),
  ];
  if (!changedFields.length) return vaccine; //nothing actually changed, no audit row

  await assertUniqueKeys(
    {
      ...(changedFields.includes("vaccineName") ? { vaccineName: set.vaccineName as string } : {}),
      ...(changedFields.includes("shortCode") ? { shortCode: set.shortCode as string } : {}),
    },
    vaccine._id,
  );
  if (changedFields.includes("targetDiseaseIds")) {
    //only newly added diseases must be active; keeping an already-linked retired one is fine
    const existing = new Set(vaccine.targetDiseaseIds.map(String));
    const added = (set.targetDiseaseIds as Types.ObjectId[]).filter((id) => !existing.has(String(id)));
    await assertDiseasesExist(added);
  }

  const setChanged = Object.fromEntries(
    Object.entries(set).filter(([field]) => changedFields.includes(field)),
  );
  const unsetChanged = unset.filter((field) => changedFields.includes(field));

  let updated: TVaccineDoc | null;
  try {
    updated = await VaccineModel.findByIdAndUpdate(
      vaccine._id,
      {
        ...(Object.keys(setChanged).length ? { $set: setChanged } : {}),
        ...(unsetChanged.length ? { $unset: Object.fromEntries(unsetChanged.map((f) => [f, 1])) } : {}),
      },
      { returnDocument: "after", runValidators: true },
    );
  } catch (error) {
    throw toDuplicateKeyError(error) ?? error;
  }
  if (!updated) throw new AppError(status.NOT_FOUND, "Vaccine not found!");

  await recordAuditLog({
    context,
    entityType: AuditEntityTypes.VACCINE,
    entityId: updated._id,
    action: AuditActions.UPDATE,
    module: AuditModules.HEALTH,
    event: updateEventLabel(changedFields),
    oldData: Object.fromEntries(changedFields.map((f) => [f, before[f] ?? null])),
    newData: snapshot(updated, changedFields),
    changedFields,
  });

  const protocolChanged = changedFields.some((f) =>
    (VACCINE_PROTOCOL_FIELDS as readonly string[]).includes(f),
  );
  return { vaccine: updated, changedFields, protocolChanged };
};

//permanent catalog status. Retiring hides the vaccine from new Vaccination forms but
//keeps the document, so historical Vaccination / Disease references never break.
const setActiveStatus = async (
  vaccine: TVaccineDoc,
  isActive: boolean,
  context: TAuditContext,
  reason?: string,
) => {
  if (isActive === vaccine.isActive) return vaccine;

  const updated = await VaccineModel.findByIdAndUpdate(
    vaccine._id,
    { $set: { isActive } },
    { returnDocument: "after", runValidators: true },
  );
  if (!updated) throw new AppError(status.NOT_FOUND, "Vaccine not found!");

  await recordAuditLog({
    context,
    entityType: AuditEntityTypes.VACCINE,
    entityId: updated._id,
    action: isActive ? AuditActions.UPDATE : AuditActions.ARCHIVE,
    module: AuditModules.HEALTH,
    event: isActive ? "Vaccine Activated" : "Vaccine Deactivated",
    oldData: { isActive: vaccine.isActive },
    newData: { isActive, ...(reason ? { reason } : {}) },
    changedFields: ["isActive"],
  });

  return updated;
};

const toggleActive = async (ref: string, payload: TPayload, context: TAuditContext) => {
  const vaccine = await findVaccineByRef(ref);
  const body = payload ?? {};

  let isActive = !vaccine.isActive; //no value = toggle
  if (body.isActive !== undefined) {
    const parsed = parseBoolean(body.isActive);
    if (parsed === undefined) throw new AppError(status.BAD_REQUEST, "isActive must be a boolean!");
    isActive = parsed;
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : undefined;
  return setActiveStatus(vaccine, isActive, context, reason);
};

/**
 * DELETE /:id
 * Default: soft-retire (isActive=false) — deactivation is preferred over deletion.
 * ?hard=true: permanently removes the document, but only when nothing references
 * it (Vaccination.vaccineId, Disease.recommendedVaccineIds, Inventory); otherwise 409.
 */
const deleteVaccine = async (ref: string, query: TPayload, context: TAuditContext) => {
  const vaccine = await findVaccineByRef(ref);
  const hard = parseBoolean(query.hard) === true;
  const usage = await countVaccineUsage(vaccine._id);

  if (!hard) {
    const retired = await setActiveStatus(vaccine, false, context);
    return { mode: "retired" as const, vaccine: retired, usage };
  }

  if (usage.total > 0) {
    throw new AppError(
      status.CONFLICT,
      `Cannot permanently delete: vaccine is referenced by ${usage.vaccinations} vaccination record(s), ${usage.diseases} disease record(s) and ${usage.inventories} inventory item(s). Retire it instead.`,
    );
  }

  const oldData = snapshot(vaccine);
  await VaccineModel.deleteOne({ _id: vaccine._id });

  await recordAuditLog({
    context,
    entityType: AuditEntityTypes.VACCINE,
    entityId: vaccine._id,
    action: AuditActions.DELETE,
    module: AuditModules.HEALTH,
    event: "Vaccine Deleted",
    oldData,
  });

  return { mode: "deleted" as const, vaccine: null, usage };
};

export const VaccineServices = {
  createVaccine,
  getAllVaccines,
  getVaccineLookup,
  getVaccineMeta,
  getVaccineStats,
  getVaccine,
  getSchedulePreview,
  getVaccineUsage,
  getVaccineAuditLogs,
  updateVaccine,
  toggleActive,
  deleteVaccine,
};
