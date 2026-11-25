import status from "http-status";
import mongoose, { isValidObjectId, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import AppError from "../../errors/AppError.js";
import QueryBuilder from "../../builder/QueryBuilder.js";
import { AuditLogModel } from "../auditLog/auditLog.model.js";
import { AuditActions, AuditEntityTypes, AuditModules } from "../auditLog/auditLog.constants.js";
import { recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext } from "../auditLog/auditLog.utils.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { UserModel } from "../auth/auth.model.js";
import { MedicineModel } from "./medicine.model.js";
import {
  MEDICINE_IDENTITY_FIELDS,
  MEDICINE_LIMITS,
  MEDICINE_REFERENCE_SOURCES,
  MEDICINE_ROUTE_COMPATIBILITY,
  MedicineAdministrationRouteLabels,
  MedicineAdministrationRoutes,
  MedicineCategories,
  MedicineDosageForms,
} from "./medicine.constants.js";
import type { TMedicine, TMedicineUsage } from "./medicine.interface.js";
import {
  STRENGTH_PATTERN,
  computeWithdrawalWindow,
  escapeRegex,
  generateMedicineCode,
  identityKey,
  isRouteCompatible,
  normalizeText,
} from "./medicine.utils.js";

type TPayload = Record<string, unknown>;
type TMedicineDoc = HydratedDocument<TMedicine>;

/* ------------------------------------------------------------------ */
/* Field whitelists                                                    */
/* ------------------------------------------------------------------ */

//fields a client may write through POST / PUT. medicineCode, timestamps and isActive
//are never accepted (isActive is owned by PATCH /:id/toggle-active).
const WRITABLE_FIELDS = [
  "medicineName",
  "genericName",
  "brandName",
  "manufacturer",
  "category",
  "dosageForm",
  "strength",
  "administrationRoute",
  "description",
  "storageCondition",
  "withdrawalPeriodDays",
  "prescriptionRequired",
] as const;

//optional fields a PUT may clear by sending null / ""
const CLEARABLE_FIELDS = new Set<string>(["brandName", "description"]);

//final DB schema marks every field except brandName / description as required
const REQUIRED_ON_CREATE = [
  "medicineName",
  "genericName",
  "manufacturer",
  "category",
  "dosageForm",
  "strength",
  "administrationRoute",
  "storageCondition",
  "withdrawalPeriodDays",
  "prescriptionRequired",
] as const;

const SORT_FIELDS = new Set([
  "medicineName",
  "medicineCode",
  "genericName",
  "brandName",
  "manufacturer",
  "category",
  "dosageForm",
  "administrationRoute",
  "withdrawalPeriodDays",
  "prescriptionRequired",
  "isActive",
  "createdAt",
  "updatedAt",
]);

//select list for Treatment forms / Inventory item mapping
const LOOKUP_FIELDS =
  "medicineCode medicineName genericName brandName manufacturer category dosageForm strength administrationRoute storageCondition withdrawalPeriodDays prescriptionRequired";

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

/**
 * validateRequest only parses and discards, so the raw body still carries unknown
 * keys and uncoerced values. Whitelist + coerce here (breed pattern).
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
      case "medicineName":
      case "genericName":
      case "manufacturer":
        set[field] = parseString(field, value, 2, 150);
        break;
      case "brandName":
        set[field] = parseString(field, value, 1, 150);
        break;
      case "storageCondition":
        set[field] = parseString(field, value, 2, 200);
        break;
      case "strength": {
        const strength = parseString(field, value, 1, 60);
        if (!STRENGTH_PATTERN.test(strength)) {
          throw new AppError(
            status.BAD_REQUEST,
            'strength must start with a number and a unit, e.g. "200 mg/ml", "500 mg" or "10%"!',
          );
        }
        set[field] = strength;
        break;
      }
      case "description":
        if (typeof value !== "string") {
          throw new AppError(status.BAD_REQUEST, "description must be a string!");
        }
        set[field] = value.trim().slice(0, 2000);
        break;
      case "category":
        assertEnum(field, value, Object.values(MedicineCategories));
        set[field] = value;
        break;
      case "dosageForm":
        assertEnum(field, value, Object.values(MedicineDosageForms));
        set[field] = value;
        break;
      case "administrationRoute":
        assertEnum(field, value, Object.values(MedicineAdministrationRoutes));
        set[field] = value;
        break;
      case "withdrawalPeriodDays": {
        const parsed = typeof value === "number" ? value : Number(value);
        if (typeof value === "boolean" || isBlank(value) || !Number.isFinite(parsed)) {
          throw new AppError(status.BAD_REQUEST, "withdrawalPeriodDays must be a valid number!");
        }
        if (parsed < 0) {
          throw new AppError(status.BAD_REQUEST, "withdrawalPeriodDays cannot be negative!");
        }
        if (!Number.isInteger(parsed)) {
          throw new AppError(status.BAD_REQUEST, "withdrawalPeriodDays must be a whole number of days!");
        }
        if (parsed > MEDICINE_LIMITS.maxWithdrawalPeriodDays) {
          throw new AppError(
            status.BAD_REQUEST,
            `withdrawalPeriodDays cannot exceed ${MEDICINE_LIMITS.maxWithdrawalPeriodDays}!`,
          );
        }
        set[field] = parsed;
        break;
      }
      case "prescriptionRequired": {
        const parsed = parseBoolean(value);
        if (parsed === undefined) throw new AppError(status.BAD_REQUEST, `${field} must be a boolean!`);
        set[field] = parsed;
        break;
      }
    }
  }

  return { set, unset };
};

//route must be one the dosage form allows (spec §23/§92: Ointment + IV, Tablet + IV rejected)
const assertRouteCompatible = (dosageForm: string, route: string) => {
  if (!isRouteCompatible(dosageForm, route)) {
    const allowed = MEDICINE_ROUTE_COMPATIBILITY[dosageForm] ?? [];
    throw new AppError(
      status.BAD_REQUEST,
      `Administration route "${route}" is not compatible with dosage form "${dosageForm}". Allowed: ${allowed.join(", ") || "none"}!`,
    );
  }
};

/* ------------------------------------------------------------------ */
/* Access + integrity helpers                                          */
/* ------------------------------------------------------------------ */

//platform admin / superAdmin (DB role, not the token) — the only users who may browse
//retired medicines in lists; everybody else only selects from the active catalog
const isCatalogAdmin = async (actorUserId?: string): Promise<boolean> => {
  if (!actorUserId) return false;
  const user = await UserModel.findOne({ userId: actorUserId }).select("systemRole").lean();
  return user?.systemRole === SystemRoles.ADMIN || user?.systemRole === SystemRoles.SUPER_ADMIN;
};

type TIdentityValues = Partial<
  Pick<TMedicine, "medicineName" | "genericName" | "brandName" | "manufacturer" | "strength" | "dosageForm">
>;

type TDuplicateMatch = {
  _id: Types.ObjectId;
  medicineCode: string;
  medicineName: string;
  genericName?: string;
  brandName?: string;
  manufacturer: string;
  strength: string;
  dosageForm: string;
  isActive: boolean;
  //which identity rule matched
  matchedOn: "name+strength+form+manufacturer" | "generic+brand+manufacturer+strength+form";
};

/**
 * Normalized duplicate strategy (DO.md + spec §77/§78):
 *  1. medicineName + strength + dosageForm + manufacturer  -> same product
 *  2. genericName + brandName + manufacturer + strength + dosageForm (brand present) -> same product
 * genericName alone is never unique — several brands may share an active ingredient.
 * Candidates are narrowed by dosageForm in Mongo, then compared with identityKey().
 */
const findDuplicates = async (
  values: TIdentityValues,
  excludeId?: Types.ObjectId,
): Promise<TDuplicateMatch[]> => {
  if (!values.dosageForm || !values.strength || !values.manufacturer) return [];

  const candidates = await MedicineModel.find({
    dosageForm: values.dosageForm,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  })
    .select(
      "medicineCode medicineName genericName brandName manufacturer strength dosageForm isActive",
    )
    .lean();

  const k = {
    name: identityKey(values.medicineName),
    generic: identityKey(values.genericName),
    brand: identityKey(values.brandName),
    manufacturer: identityKey(values.manufacturer),
    strength: identityKey(values.strength),
  };

  const matches: TDuplicateMatch[] = [];
  for (const c of candidates) {
    if (identityKey(c.manufacturer) !== k.manufacturer || identityKey(c.strength) !== k.strength) {
      continue;
    }
    if (k.name && identityKey(c.medicineName) === k.name) {
      matches.push({ ...c, matchedOn: "name+strength+form+manufacturer" } as TDuplicateMatch);
    } else if (
      k.brand &&
      k.generic &&
      identityKey(c.brandName) === k.brand &&
      identityKey(c.genericName) === k.generic
    ) {
      matches.push({ ...c, matchedOn: "generic+brand+manufacturer+strength+form" } as TDuplicateMatch);
    }
  }
  return matches;
};

const assertNoDuplicate = async (values: TIdentityValues, excludeId?: Types.ObjectId) => {
  const [match] = await findDuplicates(values, excludeId);
  if (match) {
    throw new AppError(
      status.CONFLICT,
      `This product already exists as "${match.medicineName}" ${match.strength} ${match.dosageForm} by ${match.manufacturer} (${match.medicineCode})${match.isActive ? "" : " — it is retired; reactivate it instead"}!`,
    );
  }
};

const duplicateField = (error: unknown): string | null => {
  if (typeof error === "object" && error !== null && (error as { code?: number }).code === 11000) {
    const keyValue = (error as { keyValue?: Record<string, unknown> }).keyValue;
    return (keyValue ? Object.keys(keyValue)[0] : undefined) ?? "unknown";
  }
  return null;
};

/**
 * Counts documents referencing this medicine in Treatment (medicines[].medicineId) and
 * Inventory (itemType "Medicine"). Those APIs are not built yet, so the raw
 * collections are queried (a collection that does not exist yet counts 0).
 */
const countMedicineUsage = async (medicineId: Types.ObjectId): Promise<TMedicineUsage> => {
  const db = mongoose.connection.db;
  const counts = await Promise.all(
    MEDICINE_REFERENCE_SOURCES.map(async (source) => {
      if (!db) return 0;
      try {
        return await db.collection(source.collection).countDocuments(source.filter(medicineId));
      } catch {
        return 0;
      }
    }),
  );

  const usage: TMedicineUsage = { treatments: 0, inventories: 0, total: 0 };
  MEDICINE_REFERENCE_SOURCES.forEach((source, index) => {
    const count = counts[index] ?? 0;
    usage[source.key] = count;
    usage.total += count;
  });
  return usage;
};

//plain snapshot for audit oldData/newData (ObjectIds/Dates become strings)
const snapshot = (doc: TMedicineDoc | null, fields?: readonly string[]) => {
  if (!doc) return null;
  const plain = JSON.parse(JSON.stringify(doc.toObject())) as Record<string, unknown>;
  delete plain.__v;
  if (!fields) return plain;
  return Object.fromEntries(fields.map((field) => [field, plain[field] ?? null]));
};

const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

//resolves either a Mongo _id or a public medicineCode (MED-00001)
const findMedicineByRef = async (ref: string): Promise<TMedicineDoc> => {
  const value = String(ref ?? "").trim();
  if (!value) throw new AppError(status.BAD_REQUEST, "Medicine id or code is required!");

  const medicine = isValidObjectId(value)
    ? await MedicineModel.findById(value)
    : await MedicineModel.findOne({ medicineCode: value.toUpperCase() });

  if (!medicine) throw new AppError(status.NOT_FOUND, "Medicine not found!");
  return medicine;
};

//full product profile; retired medicines stay readable so historical Treatment /
//Inventory rows can always resolve their medicine (spec §91)
const getMedicine = async (ref: string) => {
  const medicine = await findMedicineByRef(ref);
  return {
    ...medicine.toObject(),
    administrationRouteLabel: MedicineAdministrationRouteLabels[medicine.administrationRoute],
    compatibleRoutes: MEDICINE_ROUTE_COMPATIBILITY[medicine.dosageForm] ?? [],
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

const getAllMedicines = async (query: TPayload, actorUserId?: string) => {
  const filter: Record<string, unknown> = {};

  const enumFilters = [
    ["category", Object.values(MedicineCategories)],
    ["dosageForm", Object.values(MedicineDosageForms)],
    ["administrationRoute", Object.values(MedicineAdministrationRoutes)],
  ] as const;
  for (const [field, allowed] of enumFilters) {
    const value = multiEnumFilter(query[field], allowed);
    if (value !== undefined) filter[field] = value;
  }

  const prescriptionRequired = parseBoolean(query.prescriptionRequired);
  if (prescriptionRequired !== undefined) filter.prescriptionRequired = prescriptionRequired;

  //?hasWithdrawal=true -> withdrawalPeriodDays > 0 (food-safety relevant products)
  const hasWithdrawal = parseBoolean(query.hasWithdrawal);
  if (hasWithdrawal !== undefined) {
    filter.withdrawalPeriodDays = hasWithdrawal ? { $gt: 0 } : 0;
  }

  if (typeof query.manufacturer === "string" && query.manufacturer.trim()) {
    filter.manufacturer = new RegExp(escapeRegex(query.manufacturer.trim().slice(0, 150)), "i");
  }

  //retired medicines: admins may list them (isActive=false|all); others always get active only
  const admin = await isCatalogAdmin(actorUserId);
  const rawActive = String(query.isActive ?? "").toLowerCase();
  if (!admin) {
    filter.isActive = true;
  } else if (rawActive !== "all") {
    filter.isActive = parseBoolean(query.isActive) ?? true;
  }

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
  listQuery.sort = sortTokens.length ? sortTokens.join(",") : "medicineName";
  listQuery.page = Math.max(Number(query.page) || 1, 1);
  listQuery.limit = Math.min(Math.max(Number(query.limit) || 10, 1), 100);

  if (typeof query.fields === "string" && query.fields.trim()) {
    listQuery.fields = query.fields
      .split(",")
      .map((f) => f.trim())
      .filter((f) => /^-?[A-Za-z]+$/.test(f))
      .join(",");
  }

  //multi-field lookup: active ingredient, commercial brand, product name or code (DO.md §2)
  const medicineQuery = new QueryBuilder<TMedicine>(MedicineModel.find(filter), listQuery)
    .search(["medicineName", "genericName", "brandName", "medicineCode", "manufacturer"])
    .filter()
    .sort()
    .paginate()
    .fields();

  const [meta, medicines] = await Promise.all([
    medicineQuery.countTotal(),
    medicineQuery.modelQuery,
  ]);
  return { meta, medicines };
};

/**
 * Slim selector payload for Treatment forms and Inventory item mapping.
 * Only active medicines (final schema rule: inactive medicine can't be added to a new Treatment).
 */
const getMedicineLookup = async (query: TPayload) => {
  const filter: Record<string, unknown> = { isActive: true };

  const enumFilters = [
    ["category", Object.values(MedicineCategories)],
    ["dosageForm", Object.values(MedicineDosageForms)],
    ["administrationRoute", Object.values(MedicineAdministrationRoutes)],
  ] as const;
  for (const [field, allowed] of enumFilters) {
    const value = multiEnumFilter(query[field], allowed);
    if (value !== undefined) filter[field] = value;
  }
  const prescriptionRequired = parseBoolean(query.prescriptionRequired);
  if (prescriptionRequired !== undefined) filter.prescriptionRequired = prescriptionRequired;

  const rawSearch = query.searchTerm ?? query.search;
  const searchTerm = typeof rawSearch === "string" ? rawSearch.trim() : "";
  if (searchTerm) {
    const regex = new RegExp(escapeRegex(searchTerm.slice(0, 100)), "i");
    filter.$or = [
      { medicineName: regex },
      { genericName: regex },
      { brandName: regex },
      { medicineCode: regex },
    ];
  }

  return MedicineModel.find(filter).select(LOOKUP_FIELDS).sort({ medicineName: 1 }).limit(200).lean();
};

//single source of truth for the enums + route/form matrix the frontend renders
const getMedicineMeta = () => ({
  categories: Object.values(MedicineCategories),
  dosageForms: Object.values(MedicineDosageForms),
  administrationRoutes: Object.values(MedicineAdministrationRoutes).map((value) => ({
    value,
    label: MedicineAdministrationRouteLabels[value],
  })),
  routeCompatibility: MEDICINE_ROUTE_COMPATIBILITY,
  identityFields: MEDICINE_IDENTITY_FIELDS,
  units: { withdrawalPeriodDays: "days" },
  limits: MEDICINE_LIMITS,
  strengthExamples: ["200 mg/ml", "500 mg", "10%", "5 IU/ml"],
});

const getMedicineStats = async () => {
  const [summaryRows, categoryRows, formRows] = await Promise.all([
    MedicineModel.aggregate<{
      total: number;
      active: number;
      retired: number;
      prescriptionRequired: number;
      withWithdrawal: number;
      antibiotics: number;
    }>([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: ["$isActive", 1, 0] } },
          retired: { $sum: { $cond: ["$isActive", 0, 1] } },
          //clinical counters only include catalog-active medicines
          prescriptionRequired: {
            $sum: { $cond: [{ $and: ["$isActive", "$prescriptionRequired"] }, 1, 0] },
          },
          withWithdrawal: {
            $sum: { $cond: [{ $and: ["$isActive", { $gt: ["$withdrawalPeriodDays", 0] }] }, 1, 0] },
          },
          antibiotics: {
            $sum: {
              $cond: [{ $and: ["$isActive", { $eq: ["$category", MedicineCategories.ANTIBIOTIC] }] }, 1, 0],
            },
          },
        },
      },
    ]),
    MedicineModel.aggregate<{ _id: string; count: number }>([
      { $match: { isActive: true } },
      { $group: { _id: "$category", count: { $sum: 1 } } },
    ]),
    MedicineModel.aggregate<{ _id: string; count: number }>([
      { $match: { isActive: true } },
      { $group: { _id: "$dosageForm", count: { $sum: 1 } } },
    ]),
  ]);

  const summary = summaryRows[0] ?? {
    total: 0,
    active: 0,
    retired: 0,
    prescriptionRequired: 0,
    withWithdrawal: 0,
    antibiotics: 0,
  };
  const byCategory = new Map(categoryRows.map((row) => [row._id, row.count]));
  const byForm = new Map(formRows.map((row) => [row._id, row.count]));

  return {
    total: summary.total,
    active: summary.active,
    retired: summary.retired,
    prescriptionRequired: summary.prescriptionRequired,
    withWithdrawal: summary.withWithdrawal,
    antibiotics: summary.antibiotics,
    //every enum value present (count 0 included), in enum order; active medicines only
    byCategory: Object.values(MedicineCategories).map((category) => ({
      category,
      count: byCategory.get(category) ?? 0,
    })),
    byDosageForm: Object.values(MedicineDosageForms).map((dosageForm) => ({
      dosageForm,
      count: byForm.get(dosageForm) ?? 0,
    })),
  };
};

/**
 * GET /:id/withdrawal-preview?lastAdministeredDate=YYYY-MM-DD
 * Read-only: shows the withdrawal end date Treatment / MilkRecord will derive.
 */
const getWithdrawalPreview = async (ref: string, query: TPayload) => {
  const medicine = await findMedicineByRef(ref);

  let lastAdministeredDate = new Date();
  if (typeof query.lastAdministeredDate === "string" && query.lastAdministeredDate.trim()) {
    lastAdministeredDate = new Date(query.lastAdministeredDate);
    if (Number.isNaN(lastAdministeredDate.getTime())) {
      throw new AppError(status.BAD_REQUEST, "lastAdministeredDate must be a valid date!");
    }
  }

  return {
    medicine: {
      _id: medicine._id,
      medicineCode: medicine.medicineCode,
      medicineName: medicine.medicineName,
      isActive: medicine.isActive,
    },
    ...computeWithdrawalWindow(medicine.withdrawalPeriodDays, lastAdministeredDate),
    disclaimer:
      "Reference calculation only. Follow the product label / veterinary protocol for milk and meat restrictions.",
  };
};

const getMedicineUsage = async (ref: string) => {
  const medicine = await findMedicineByRef(ref);
  const usage = await countMedicineUsage(medicine._id);
  return {
    _id: medicine._id,
    medicineCode: medicine.medicineCode,
    medicineName: medicine.medicineName,
    usage,
    canHardDelete: usage.total === 0,
    //identity fields are locked once anything references the product
    identityLocked: usage.total > 0,
  };
};

//change history of one medicine (admin only), newest first
const getMedicineAuditLogs = async (ref: string, query: TPayload) => {
  const medicine = await findMedicineByRef(ref);
  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
  const filter = { entityType: AuditEntityTypes.MEDICINE, entityId: medicine._id };

  const [total, logs] = await Promise.all([
    AuditLogModel.countDocuments(filter),
    AuditLogModel.find(filter)
      .select("-__v -ipAddress -userAgent -browser -operatingSystem -location")
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

/**
 * POST /check-duplicate — create-form pre-check (admin). Never writes; returns the
 * products that would make POST /medicines answer 409.
 */
const checkDuplicate = async (payload: TPayload) => {
  const body = payload ?? {};
  const str = (v: unknown) => (typeof v === "string" ? normalizeText(v) : undefined);
  const excludeId =
    typeof body.excludeId === "string" && isValidObjectId(body.excludeId)
      ? new Types.ObjectId(body.excludeId)
      : undefined;

  const values: TIdentityValues = {};
  const assign = (key: keyof TIdentityValues) => {
    const value = str(body[key]);
    if (value) (values as Record<string, string>)[key] = value;
  };
  (["medicineName", "genericName", "brandName", "manufacturer", "strength", "dosageForm"] as const).forEach(
    assign,
  );

  const matches = await findDuplicates(values, excludeId);
  return { isDuplicate: matches.length > 0, matches };
};

/* ------------------------------------------------------------------ */
/* Write                                                               */
/* ------------------------------------------------------------------ */

const createMedicine = async (payload: TPayload, context: TAuditContext) => {
  const { set } = pickFields(payload ?? {}, false);

  for (const field of REQUIRED_ON_CREATE) {
    if (set[field] === undefined) throw new AppError(status.BAD_REQUEST, `${field} is required!`);
  }
  assertRouteCompatible(set.dosageForm as string, set.administrationRoute as string);
  await assertNoDuplicate(set as TIdentityValues);

  //retry when two creations race for the same generated code
  let created: TMedicineDoc | null = null;
  for (let attempt = 0; attempt < 3 && !created; attempt++) {
    const medicineCode = await generateMedicineCode();
    try {
      created = await MedicineModel.create({ ...set, medicineCode, isActive: true });
    } catch (error) {
      if (duplicateField(error) === "medicineCode" && attempt < 2) continue;
      if (duplicateField(error)) {
        throw new AppError(status.CONFLICT, "Medicine code already exists, please retry!");
      }
      throw error;
    }
  }
  if (!created) throw new AppError(status.CONFLICT, "Could not generate a medicine code, please retry!");

  await recordAuditLog({
    context,
    entityType: AuditEntityTypes.MEDICINE,
    entityId: created._id,
    action: AuditActions.CREATE,
    module: AuditModules.HEALTH,
    event: "Medicine Created",
    newData: snapshot(created),
  });

  return created;
};

//most specific audit label wins (spec §80); changedFields carries the full detail
const updateEventLabel = (changed: string[]) => {
  const has = (...fields: string[]) => fields.some((f) => changed.includes(f));
  if (has("strength")) return "Strength Changed";
  if (has("administrationRoute", "dosageForm")) return "Route Changed";
  if (has("withdrawalPeriodDays")) return "Withdrawal Period Changed";
  if (has("prescriptionRequired")) return "Prescription Requirement Changed";
  if (has("manufacturer")) return "Manufacturer Changed";
  if (has("category")) return "Category Changed";
  return "Medicine Updated";
};

/**
 * Updates master data with identity protection (DO.md §3, spec §14/§70):
 * once a Treatment or Inventory row references the medicine, genericName / brandName /
 * manufacturer / strength / dosageForm are locked — a materially different product must
 * be registered as a new Medicine. Every change is audited.
 */
const updateMedicine = async (ref: string, payload: TPayload, context: TAuditContext) => {
  const medicine = await findMedicineByRef(ref);
  const body = payload ?? {};
  const { set, unset } = pickFields(body, true);

  if (!Object.keys(set).length && !unset.length) {
    throw new AppError(status.BAD_REQUEST, "No updatable medicine fields were provided!");
  }

  const before = snapshot(medicine) ?? {};
  const changedFields = [
    ...Object.keys(set).filter((field) => !sameValue(before[field], set[field])),
    ...unset.filter((field) => before[field] !== undefined && before[field] !== null),
  ];
  if (!changedFields.length) return { medicine, changedFields }; //no-op, no audit row

  //identity protection: only for products already used in history
  const identityChanges = changedFields.filter((f) =>
    (MEDICINE_IDENTITY_FIELDS as readonly string[]).includes(f),
  );
  if (identityChanges.length) {
    const usage = await countMedicineUsage(medicine._id);
    if (usage.total > 0) {
      throw new AppError(
        status.CONFLICT,
        `Cannot change ${identityChanges.join(", ")}: this medicine is referenced by ${usage.treatments} treatment(s) and ${usage.inventories} inventory item(s). Register a new medicine for a different product instead.`,
      );
    }
  }

  //effective (merged) values for cross-field rules
  const merged = { ...before, ...set } as Record<string, unknown>;
  for (const field of unset) delete merged[field];

  if (changedFields.includes("dosageForm") || changedFields.includes("administrationRoute")) {
    assertRouteCompatible(String(merged.dosageForm), String(merged.administrationRoute));
  }
  const identityTouched = changedFields.some((f) =>
    ["medicineName", ...MEDICINE_IDENTITY_FIELDS].includes(f),
  );
  if (identityTouched) {
    await assertNoDuplicate(merged as TIdentityValues, medicine._id);
  }

  const setChanged = Object.fromEntries(
    Object.entries(set).filter(([field]) => changedFields.includes(field)),
  );
  const unsetChanged = unset.filter((field) => changedFields.includes(field));

  const updated = await MedicineModel.findByIdAndUpdate(
    medicine._id,
    {
      ...(Object.keys(setChanged).length ? { $set: setChanged } : {}),
      ...(unsetChanged.length ? { $unset: Object.fromEntries(unsetChanged.map((f) => [f, 1])) } : {}),
    },
    { returnDocument: "after", runValidators: true },
  );
  if (!updated) throw new AppError(status.NOT_FOUND, "Medicine not found!");

  const changeReason =
    typeof body.changeReason === "string" && body.changeReason.trim()
      ? body.changeReason.trim().slice(0, 500)
      : undefined;

  await recordAuditLog({
    context,
    entityType: AuditEntityTypes.MEDICINE,
    entityId: updated._id,
    action: AuditActions.UPDATE,
    module: AuditModules.HEALTH,
    event: updateEventLabel(changedFields),
    oldData: Object.fromEntries(changedFields.map((f) => [f, before[f] ?? null])),
    newData: {
      ...snapshot(updated, changedFields),
      ...(changeReason ? { changeReason } : {}),
    },
    changedFields,
  });

  return { medicine: updated, changedFields };
};

//catalog availability. Retiring hides the medicine from new Treatment forms but keeps
//the document, so historical Treatment.medicines[] / Inventory references stay readable.
const setActiveStatus = async (
  medicine: TMedicineDoc,
  isActive: boolean,
  context: TAuditContext,
  reason?: string,
) => {
  if (isActive === medicine.isActive) return medicine;

  if (isActive) {
    //reactivating must not create a second active copy of the same product
    const [match] = await findDuplicates(medicine.toObject(), medicine._id);
    if (match?.isActive) {
      throw new AppError(
        status.CONFLICT,
        `An active duplicate already exists (${match.medicineCode}); cannot reactivate this medicine!`,
      );
    }
  }

  const updated = await MedicineModel.findByIdAndUpdate(
    medicine._id,
    { $set: { isActive } },
    { returnDocument: "after", runValidators: true },
  );
  if (!updated) throw new AppError(status.NOT_FOUND, "Medicine not found!");

  await recordAuditLog({
    context,
    entityType: AuditEntityTypes.MEDICINE,
    entityId: updated._id,
    action: isActive ? AuditActions.UPDATE : AuditActions.ARCHIVE,
    module: AuditModules.HEALTH,
    event: isActive ? "Medicine Activated" : "Medicine Deactivated",
    oldData: { isActive: medicine.isActive },
    newData: { isActive, ...(reason ? { reason } : {}) },
    changedFields: ["isActive"],
  });

  return updated;
};

const toggleActive = async (ref: string, payload: TPayload, context: TAuditContext) => {
  const medicine = await findMedicineByRef(ref);
  const body = payload ?? {};

  let isActive = !medicine.isActive; //no value = toggle
  if (body.isActive !== undefined) {
    const parsed = parseBoolean(body.isActive);
    if (parsed === undefined) throw new AppError(status.BAD_REQUEST, "isActive must be a boolean!");
    isActive = parsed;
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : undefined;
  return setActiveStatus(medicine, isActive, context, reason);
};

/**
 * DELETE /:id
 * Default: soft-retire (isActive=false) — the final schema allows only soft delete for
 * referenced data. ?hard=true permanently removes the document only when no Treatment /
 * Inventory row references it; otherwise 409 (hard delete is blocked, never downgraded).
 */
const deleteMedicine = async (ref: string, query: TPayload, context: TAuditContext) => {
  const medicine = await findMedicineByRef(ref);
  const hard = parseBoolean(query.hard) === true;
  const usage = await countMedicineUsage(medicine._id);

  if (!hard) {
    const retired = await setActiveStatus(medicine, false, context);
    return { mode: "retired" as const, medicine: retired, usage };
  }

  if (usage.total > 0) {
    throw new AppError(
      status.CONFLICT,
      `Cannot permanently delete: medicine is referenced by ${usage.treatments} treatment record(s) and ${usage.inventories} inventory item(s). Retire it instead.`,
    );
  }

  const oldData = snapshot(medicine);
  await MedicineModel.deleteOne({ _id: medicine._id });

  await recordAuditLog({
    context,
    entityType: AuditEntityTypes.MEDICINE,
    entityId: medicine._id,
    action: AuditActions.DELETE,
    module: AuditModules.HEALTH,
    event: "Medicine Deleted",
    oldData,
  });

  return { mode: "deleted" as const, medicine: null, usage };
};

export const MedicineServices = {
  createMedicine,
  getAllMedicines,
  getMedicineLookup,
  getMedicineMeta,
  getMedicineStats,
  getMedicine,
  getWithdrawalPreview,
  getMedicineUsage,
  getMedicineAuditLogs,
  checkDuplicate,
  updateMedicine,
  toggleActive,
  deleteMedicine,
};
