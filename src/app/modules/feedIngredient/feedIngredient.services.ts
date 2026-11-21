import status from "http-status";
import mongoose, { isValidObjectId, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import AppError from "../../errors/AppError.js";
import QueryBuilder from "../../builder/QueryBuilder.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { UserModel } from "../auth/auth.model.js";
import { FarmMemberModel } from "../farmMember/farmMember.model.js";
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";
import { AuditLogModel } from "../auditLog/auditLog.model.js";
import {
  AuditActions,
  AuditEntityTypes,
  AuditModules,
} from "../auditLog/auditLog.constants.js";
import { recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext } from "../auditLog/auditLog.utils.js";
import { FeedIngredientModel } from "./feedIngredient.model.js";
import {
  FEED_INGREDIENT_NUTRITION_FIELDS,
  FEED_INGREDIENT_OPTIONAL_NUMERIC_FIELDS,
  FEED_INGREDIENT_PERCENT_FIELDS,
  FEED_INGREDIENT_REFERENCE_SOURCES,
  FEED_INGREDIENT_REQUIRED_NUMERIC_FIELDS,
  FeedIngredientCategories,
  FeedIngredientNutritionUnits,
  FeedIngredientUnits,
} from "./feedIngredient.constants.js";
import type {
  TFeedIngredient,
  TIngredientUsage,
} from "./feedIngredient.interface.js";
import {
  escapeRegex,
  generateIngredientCode,
  normalizeIngredientName,
  variantNameRegex,
} from "./feedIngredient.utils.js";

type TPayload = Record<string, unknown>;
type TIngredientDoc = HydratedDocument<TFeedIngredient>;

/* ------------------------------------------------------------------ */
/* Field whitelists                                                    */
/* ------------------------------------------------------------------ */

//fields a client may write through POST / PUT. ingredientCode, timestamps and
//isActive are never accepted; isAvailable only at creation (afterwards it is owned
//by PATCH /:id/availability, isActive by /:id/toggle-active).
const UPDATABLE_FIELDS = [
  "ingredientName",
  "unit",
  "category",
  ...FEED_INGREDIENT_REQUIRED_NUMERIC_FIELDS,
  ...FEED_INGREDIENT_OPTIONAL_NUMERIC_FIELDS,
  "supplierId",
  "description",
] as const;

const CREATABLE_FIELDS = [...UPDATABLE_FIELDS, "isAvailable"] as const;

//optional fields a PUT may clear by sending null / ""
const CLEARABLE_FIELDS = new Set<string>([
  ...FEED_INGREDIENT_OPTIONAL_NUMERIC_FIELDS,
  "supplierId",
  "description",
]);

const NUMERIC_FIELDS = new Set<string>([
  ...FEED_INGREDIENT_REQUIRED_NUMERIC_FIELDS,
  ...FEED_INGREDIENT_OPTIONAL_NUMERIC_FIELDS,
]);
const PERCENT_FIELDS = new Set<string>(FEED_INGREDIENT_PERCENT_FIELDS);

const SORT_FIELDS = new Set([
  "ingredientName",
  "ingredientCode",
  "category",
  "unit",
  "pricePerUnit",
  "dryMatterPercentage",
  "crudeProtein",
  "crudeFiber",
  "energy",
  "availability",
  "isAvailable",
  "isActive",
  "createdAt",
  "updatedAt",
]);

//select list for formula builders / cost estimators (everything they calculate with)
const LOOKUP_FIELDS =
  "ingredientCode ingredientName category unit pricePerUnit dryMatterPercentage crudeProtein crudeFiber energy calcium phosphorus isAvailable isActive";

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

const parseNumber = (field: string, value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (typeof value === "boolean" || isBlank(value) || !Number.isFinite(parsed)) {
    throw new AppError(status.BAD_REQUEST, `${field} must be a valid number!`);
  }
  if (parsed < 0) {
    throw new AppError(status.BAD_REQUEST, `${field} cannot be negative!`);
  }
  if (PERCENT_FIELDS.has(field) && parsed > 100) {
    throw new AppError(status.BAD_REQUEST, `${field} cannot exceed 100%!`);
  }
  return parsed;
};

const assertEnum = (field: string, value: unknown, allowed: readonly string[]) => {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new AppError(status.BAD_REQUEST, `${field} must be one of: ${allowed.join(", ")}!`);
  }
};

/**
 * validateRequest only parses and discards, so the raw body still carries unknown
 * keys and uncoerced values. Whitelist + coerce here.
 * Returns `set` (values to write) and `unset` (optional fields explicitly cleared).
 */
const pickFields = (
  payload: TPayload,
  allowed: readonly string[],
  allowClear: boolean,
): { set: Record<string, unknown>; unset: string[] } => {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];

  for (const field of allowed) {
    const value = payload[field];
    if (value === undefined) continue;

    if (isBlank(value) && CLEARABLE_FIELDS.has(field)) {
      if (allowClear) unset.push(field);
      continue;
    }

    if (NUMERIC_FIELDS.has(field)) {
      set[field] = parseNumber(field, value);
    } else if (field === "ingredientName") {
      if (typeof value !== "string") {
        throw new AppError(status.BAD_REQUEST, "ingredientName must be a string!");
      }
      const name = normalizeIngredientName(value);
      if (name.length < 2 || name.length > 100) {
        throw new AppError(status.BAD_REQUEST, "Ingredient name must be 2-100 characters!");
      }
      set[field] = name;
    } else if (field === "unit") {
      assertEnum("unit", value, Object.values(FeedIngredientUnits));
      set[field] = value;
    } else if (field === "category") {
      assertEnum("category", value, Object.values(FeedIngredientCategories));
      set[field] = value;
    } else if (field === "supplierId") {
      if (!isValidObjectId(value) || typeof value !== "string") {
        throw new AppError(status.BAD_REQUEST, "supplierId must be a valid ObjectId!");
      }
      set[field] = new Types.ObjectId(value);
    } else if (field === "description") {
      if (typeof value !== "string") {
        throw new AppError(status.BAD_REQUEST, "description must be a string!");
      }
      set[field] = value.trim().slice(0, 2000);
    } else if (field === "isAvailable") {
      const parsed = parseBoolean(value);
      if (parsed === undefined) {
        throw new AppError(status.BAD_REQUEST, "isAvailable must be a boolean!");
      }
      set[field] = parsed;
    }
  }

  return { set, unset };
};

/* ------------------------------------------------------------------ */
/* Integrity helpers                                                   */
/* ------------------------------------------------------------------ */

//one canonical ingredient: reject names that only differ by case/spacing/punctuation
const assertNameAvailable = async (name: string, excludeId?: Types.ObjectId) => {
  const variant = variantNameRegex(name);
  const nameFilter = variant ? { ingredientName: variant } : { ingredientName: name };
  const existing = await FeedIngredientModel.findOne({
    ...nameFilter,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  })
    .collation({ locale: "en", strength: 2 })
    .select("ingredientCode ingredientName isActive")
    .lean();

  if (existing) {
    throw new AppError(
      status.CONFLICT,
      `Ingredient already exists as "${existing.ingredientName}" (${existing.ingredientCode})${existing.isActive ? "" : " — it is retired; reactivate it instead"}!`,
    );
  }
};

const toDuplicateKeyError = (error: unknown): AppError | null => {
  if (typeof error === "object" && error !== null && (error as { code?: number }).code === 11000) {
    const keyValue = (error as { keyValue?: Record<string, unknown> }).keyValue;
    const field = keyValue ? Object.keys(keyValue)[0] : undefined;
    return new AppError(
      status.CONFLICT,
      field === "ingredientCode"
        ? "Ingredient code already exists, please retry!"
        : "Ingredient name already exists!",
    );
  }
  return null;
};

const isDuplicateCode = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: number }).code === 11000 &&
  Object.keys((error as { keyValue?: Record<string, unknown> }).keyValue ?? {})[0] ===
    "ingredientCode";

/**
 * Counts documents referencing this ingredient in FeedFormula, FeedRecommendation,
 * FeedRecord and Inventory. Those modules are not implemented yet, so the raw
 * collections are queried (a collection that does not exist yet counts 0).
 */
const countIngredientUsage = async (ingredientId: Types.ObjectId): Promise<TIngredientUsage> => {
  const db = mongoose.connection.db;
  const counts = await Promise.all(
    FEED_INGREDIENT_REFERENCE_SOURCES.map(async (source) => {
      if (!db) return 0;
      try {
        return await db.collection(source.collection).countDocuments({ [source.path]: ingredientId });
      } catch {
        return 0;
      }
    }),
  );

  const usage = { feedFormulas: 0, feedRecommendations: 0, feedRecords: 0, inventories: 0, total: 0 };
  FEED_INGREDIENT_REFERENCE_SOURCES.forEach((source, index) => {
    const count = counts[index] ?? 0;
    usage[source.key] = count;
    usage.total += count;
  });
  return usage;
};

//plain snapshot for audit oldData/newData (ObjectIds/Dates become strings)
const snapshot = (doc: TIngredientDoc | null, fields?: readonly string[]) => {
  if (!doc) return null;
  const plain = JSON.parse(JSON.stringify(doc.toObject())) as Record<string, unknown>;
  delete plain.__v;
  if (!fields) return plain;
  return Object.fromEntries(fields.map((field) => [field, plain[field] ?? null]));
};

/* ------------------------------------------------------------------ */
/* Authorization (beyond the route-level auth middleware)              */
/* ------------------------------------------------------------------ */

const isPlatformAdmin = (role?: string) =>
  role === SystemRoles.ADMIN || role === SystemRoles.SUPER_ADMIN;

/**
 * Availability may also be toggled by farm "Manager"s. Ingredients are global
 * master data, so this means: an Owner or Manager with an active membership in at
 * least one farm (farm owners always hold an active Owner row).
 * Platform admin/superAdmin pass through; the role is re-read from the DB.
 */
const assertCanManageAvailability = async (actorUserId?: string) => {
  const user = actorUserId
    ? await UserModel.findOne({ userId: actorUserId }).select("_id systemRole").lean()
    : null;
  if (!user) throw new AppError(status.FORBIDDEN, "You're not authorized!");
  if (isPlatformAdmin(user.systemRole as string)) return;

  const membership = await FarmMemberModel.exists({
    userId: user._id,
    isActive: true,
    role: { $in: [FarmMemberRoles.OWNER, FarmMemberRoles.MANAGER] },
  });
  if (!membership) {
    throw new AppError(
      status.FORBIDDEN,
      "Only platform admins or farm Owners/Managers can change ingredient availability!",
    );
  }
};

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

//resolves either a Mongo _id or a public ingredientCode (ING-00001)
const findIngredientByRef = async (ref: string): Promise<TIngredientDoc> => {
  const value = String(ref ?? "").trim();
  if (!value) throw new AppError(status.BAD_REQUEST, "Ingredient id or code is required!");

  const ingredient = isValidObjectId(value)
    ? await FeedIngredientModel.findById(value)
    : await FeedIngredientModel.findOne({ ingredientCode: value.toUpperCase() });

  if (!ingredient) throw new AppError(status.NOT_FOUND, "Feed ingredient not found!");
  return ingredient;
};

const getIngredient = async (ref: string) => findIngredientByRef(ref);

const getAllIngredients = async (query: TPayload) => {
  const filter: Record<string, unknown> = {};

  for (const [field, allowed] of [
    ["category", Object.values(FeedIngredientCategories)],
    ["unit", Object.values(FeedIngredientUnits)],
  ] as const) {
    const raw = query[field];
    if (typeof raw === "string" && raw.trim()) {
      //comma-separated multi-select; unknown values are ignored rather than erroring
      const values = raw
        .split(",")
        .map((v) => v.trim())
        .filter((v) => (allowed as readonly string[]).includes(v));
      if (values.length) filter[field] = values.length === 1 ? values[0] : { $in: values };
    }
  }

  const isAvailable = parseBoolean(query.isAvailable);
  if (isAvailable !== undefined) filter.isAvailable = isAvailable;

  //retired ingredients are hidden unless explicitly requested (isActive=false|all)
  if (String(query.isActive).toLowerCase() !== "all") {
    filter.isActive = parseBoolean(query.isActive) ?? true;
  }

  if (typeof query.supplierId === "string" && isValidObjectId(query.supplierId)) {
    filter.supplierId = new Types.ObjectId(query.supplierId);
  }

  const price: Record<string, number> = {};
  const minPrice = Number(query.minPrice);
  const maxPrice = Number(query.maxPrice);
  if (query.minPrice !== undefined && Number.isFinite(minPrice)) price.$gte = minPrice;
  if (query.maxPrice !== undefined && Number.isFinite(maxPrice)) price.$lte = maxPrice;
  if (Object.keys(price).length) filter.pricePerUnit = price;

  const listQuery: TPayload = {};
  if (typeof query.searchTerm === "string" && query.searchTerm.trim()) {
    //QueryBuilder interpolates this straight into $regex
    listQuery.searchTerm = escapeRegex(query.searchTerm.trim().slice(0, 100));
  }

  const sortTokens = String(query.sort ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => SORT_FIELDS.has(token.replace(/^-/, "")));
  listQuery.sort = sortTokens.length ? sortTokens.join(",") : "ingredientName";
  listQuery.page = Math.max(Number(query.page) || 1, 1);
  listQuery.limit = Math.min(Math.max(Number(query.limit) || 10, 1), 100);

  if (typeof query.fields === "string" && query.fields.trim()) {
    listQuery.fields = query.fields
      .split(",")
      .map((f) => f.trim())
      .filter((f) => /^-?[A-Za-z]+$/.test(f))
      .join(",");
  }

  const ingredientQuery = new QueryBuilder<TFeedIngredient>(
    FeedIngredientModel.find(filter),
    listQuery,
  )
    .search(["ingredientName", "ingredientCode"])
    .filter()
    .sort()
    .paginate()
    .fields();

  const [meta, ingredients] = await Promise.all([
    ingredientQuery.countTotal(),
    ingredientQuery.modelQuery,
  ]);
  return { meta, ingredients };
};

/**
 * Slim selector payload for the formula builder / cost estimator.
 * Only active ingredients; unavailable ones are excluded unless
 * includeUnavailable=true (so the UI can show them disabled with a warning).
 */
const getIngredientLookup = async (query: TPayload) => {
  const filter: Record<string, unknown> = { isActive: true };
  if (parseBoolean(query.includeUnavailable) !== true) filter.isAvailable = true;

  if (typeof query.category === "string" && query.category.trim()) {
    const values = query.category
      .split(",")
      .map((v) => v.trim())
      .filter((v) => (Object.values(FeedIngredientCategories) as string[]).includes(v));
    if (values.length) filter.category = { $in: values };
  }

  const searchTerm = typeof query.searchTerm === "string" ? query.searchTerm.trim() : "";
  if (searchTerm) {
    const regex = new RegExp(escapeRegex(searchTerm.slice(0, 100)), "i");
    filter.$or = [{ ingredientName: regex }, { ingredientCode: regex }];
  }

  return FeedIngredientModel.find(filter)
    .select(LOOKUP_FIELDS)
    .sort({ ingredientName: 1 })
    .limit(200)
    .lean();
};

//single source of truth for the enums/units the frontend renders
const getIngredientMeta = () => ({
  units: Object.values(FeedIngredientUnits),
  categories: Object.values(FeedIngredientCategories),
  nutritionUnits: FeedIngredientNutritionUnits,
  currency: "BDT",
});

const getIngredientStats = async () => {
  const [summaryRows, categoryRows] = await Promise.all([
    FeedIngredientModel.aggregate<{
      total: number;
      active: number;
      retired: number;
      available: number;
      unavailable: number;
    }>([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: ["$isActive", 1, 0] } },
          retired: { $sum: { $cond: ["$isActive", 0, 1] } },
          //availability only matters for catalog-active ingredients
          available: { $sum: { $cond: [{ $and: ["$isActive", "$isAvailable"] }, 1, 0] } },
          unavailable: {
            $sum: { $cond: [{ $and: ["$isActive", { $not: ["$isAvailable"] }] }, 1, 0] },
          },
        },
      },
    ]),
    FeedIngredientModel.aggregate<{ _id: string; count: number; avgPrice: number }>([
      { $match: { isActive: true } },
      { $group: { _id: "$category", count: { $sum: 1 }, avgPrice: { $avg: "$pricePerUnit" } } },
    ]),
  ]);

  const summary = summaryRows[0] ?? { total: 0, active: 0, retired: 0, available: 0, unavailable: 0 };
  const byCategoryMap = new Map(categoryRows.map((row) => [row._id, row]));

  return {
    total: summary.total,
    active: summary.active,
    retired: summary.retired,
    available: summary.available,
    unavailable: summary.unavailable,
    //every category present (count 0 included), in enum order; active ingredients only
    byCategory: Object.values(FeedIngredientCategories).map((category) => ({
      category,
      count: byCategoryMap.get(category)?.count ?? 0,
      avgPricePerUnit: Math.round((byCategoryMap.get(category)?.avgPrice ?? 0) * 100) / 100,
    })),
  };
};

const getIngredientUsage = async (ref: string) => {
  const ingredient = await findIngredientByRef(ref);
  const usage = await countIngredientUsage(ingredient._id);
  return {
    _id: ingredient._id,
    ingredientCode: ingredient.ingredientCode,
    ingredientName: ingredient.ingredientName,
    usage,
    canHardDelete: usage.total === 0,
  };
};

//change history of one ingredient (admin only), newest first
const getIngredientAuditLogs = async (ref: string, query: TPayload) => {
  const ingredient = await findIngredientByRef(ref);
  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
  const filter = { entityType: AuditEntityTypes.FEED_INGREDIENT, entityId: ingredient._id };

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

const createIngredient = async (payload: TPayload, context: TAuditContext) => {
  const { set } = pickFields(payload ?? {}, CREATABLE_FIELDS, false);

  const name = set.ingredientName as string | undefined;
  if (!name) throw new AppError(status.BAD_REQUEST, "Ingredient name is required!");
  if (set.unit === undefined) assertEnum("unit", undefined, Object.values(FeedIngredientUnits));
  if (set.category === undefined) {
    assertEnum("category", undefined, Object.values(FeedIngredientCategories));
  }
  for (const field of FEED_INGREDIENT_REQUIRED_NUMERIC_FIELDS) {
    if (set[field] === undefined) throw new AppError(status.BAD_REQUEST, `${field} is required!`);
  }

  await assertNameAvailable(name);

  //retry when two creations race for the same generated code
  let created: TIngredientDoc | null = null;
  for (let attempt = 0; attempt < 3 && !created; attempt++) {
    const ingredientCode = await generateIngredientCode();
    try {
      created = await FeedIngredientModel.create({
        ...set,
        ingredientCode,
        isAvailable: (set.isAvailable as boolean | undefined) ?? true,
        isActive: true,
      });
    } catch (error) {
      if (isDuplicateCode(error) && attempt < 2) continue;
      throw toDuplicateKeyError(error) ?? error;
    }
  }
  if (!created) throw new AppError(status.CONFLICT, "Could not generate an ingredient code, please retry!");

  await recordAuditLog({
    context,
    entityType: AuditEntityTypes.FEED_INGREDIENT,
    entityId: created._id,
    action: AuditActions.CREATE,
    module: AuditModules.FEED,
    event: "Ingredient Created",
    newData: snapshot(created),
  });

  return created;
};

//values equal for audit purposes (ObjectId vs string, undefined vs missing)
const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Updates master data. Historical protection: FeedRecommendation/FeedRecord keep
 * their own price/nutrition snapshots, so nothing is recalculated here — the new
 * values only affect future formula costs and recommendations.
 */
const updateIngredient = async (ref: string, payload: TPayload, context: TAuditContext) => {
  const ingredient = await findIngredientByRef(ref);
  const { set, unset } = pickFields(payload ?? {}, UPDATABLE_FIELDS, true);

  if (!Object.keys(set).length && !unset.length) {
    throw new AppError(status.BAD_REQUEST, "No updatable ingredient fields were provided!");
  }

  const before = snapshot(ingredient) ?? {};
  const changedFields = [
    ...Object.keys(set).filter((field) => !sameValue(before[field], JSON.parse(JSON.stringify(set[field])))),
    ...unset.filter((field) => before[field] !== undefined && before[field] !== null),
  ];
  if (!changedFields.length) return ingredient; //nothing actually changed, no audit row

  if (changedFields.includes("ingredientName")) {
    await assertNameAvailable(set.ingredientName as string, ingredient._id);
  }

  let updated: TIngredientDoc | null;
  try {
    updated = await FeedIngredientModel.findByIdAndUpdate(
      ingredient._id,
      {
        ...(Object.keys(set).length ? { $set: set } : {}),
        ...(unset.length ? { $unset: Object.fromEntries(unset.map((f) => [f, 1])) } : {}),
      },
      { returnDocument: "after", runValidators: true },
    );
  } catch (error) {
    throw toDuplicateKeyError(error) ?? error;
  }
  if (!updated) throw new AppError(status.NOT_FOUND, "Feed ingredient not found!");

  //most specific label wins; changedFields carries the full detail
  const nutritionChanged = changedFields.some((f) =>
    (FEED_INGREDIENT_NUTRITION_FIELDS as readonly string[]).includes(f),
  );
  const event = changedFields.includes("pricePerUnit")
    ? "Ingredient Price Changed"
    : nutritionChanged
      ? "Ingredient Nutrition Changed"
      : changedFields.includes("supplierId")
        ? "Supplier Changed"
        : "Ingredient Updated";

  await recordAuditLog({
    context,
    entityType: AuditEntityTypes.FEED_INGREDIENT,
    entityId: updated._id,
    action: AuditActions.UPDATE,
    module: AuditModules.FEED,
    event,
    oldData: Object.fromEntries(changedFields.map((f) => [f, before[f] ?? null])),
    newData: snapshot(updated, changedFields),
    changedFields,
  });

  return updated;
};

const updateAvailability = async (ref: string, payload: TPayload, context: TAuditContext) => {
  await assertCanManageAvailability(context.actorUserId);
  const ingredient = await findIngredientByRef(ref);

  if (!ingredient.isActive) {
    throw new AppError(
      status.CONFLICT,
      "This ingredient is retired from the catalog; reactivate it before changing availability!",
    );
  }

  const body = payload ?? {};
  let isAvailable = !ingredient.isAvailable; //no value = toggle
  if (body.isAvailable !== undefined) {
    const parsed = parseBoolean(body.isAvailable);
    if (parsed === undefined) throw new AppError(status.BAD_REQUEST, "isAvailable must be a boolean!");
    isAvailable = parsed;
  }
  if (isAvailable === ingredient.isAvailable) return ingredient;

  const updated = await FeedIngredientModel.findByIdAndUpdate(
    ingredient._id,
    { $set: { isAvailable } },
    { returnDocument: "after", runValidators: true },
  );
  if (!updated) throw new AppError(status.NOT_FOUND, "Feed ingredient not found!");

  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  await recordAuditLog({
    context,
    entityType: AuditEntityTypes.FEED_INGREDIENT,
    entityId: updated._id,
    action: AuditActions.UPDATE,
    module: AuditModules.FEED,
    event: "Ingredient Availability Changed",
    oldData: { isAvailable: ingredient.isAvailable },
    newData: { isAvailable, ...(reason ? { reason } : {}) },
    changedFields: ["isAvailable"],
  });

  return updated;
};

//permanent catalog status. Retiring hides the ingredient from new formulas but keeps
//the document, so historical formulas/recommendations/records never break.
const setActiveStatus = async (
  ingredient: TIngredientDoc,
  isActive: boolean,
  context: TAuditContext,
  reason?: string,
) => {
  if (isActive === ingredient.isActive) return ingredient;

  if (isActive) {
    //a variant may have been created while this one was retired
    await assertNameAvailable(ingredient.ingredientName, ingredient._id);
  }

  const updated = await FeedIngredientModel.findByIdAndUpdate(
    ingredient._id,
    { $set: { isActive } },
    { returnDocument: "after", runValidators: true },
  );
  if (!updated) throw new AppError(status.NOT_FOUND, "Feed ingredient not found!");

  await recordAuditLog({
    context,
    entityType: AuditEntityTypes.FEED_INGREDIENT,
    entityId: updated._id,
    action: isActive ? AuditActions.UPDATE : AuditActions.ARCHIVE,
    module: AuditModules.FEED,
    event: isActive ? "Ingredient Activated" : "Ingredient Deactivated",
    oldData: { isActive: ingredient.isActive },
    newData: { isActive, ...(reason ? { reason } : {}) },
    changedFields: ["isActive"],
  });

  return updated;
};

const toggleActive = async (ref: string, payload: TPayload, context: TAuditContext) => {
  const ingredient = await findIngredientByRef(ref);
  const body = payload ?? {};

  let isActive = !ingredient.isActive; //no value = toggle
  if (body.isActive !== undefined) {
    const parsed = parseBoolean(body.isActive);
    if (parsed === undefined) throw new AppError(status.BAD_REQUEST, "isActive must be a boolean!");
    isActive = parsed;
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : undefined;
  return setActiveStatus(ingredient, isActive, context, reason);
};

/**
 * DELETE /:id
 * Default: soft-retire (isActive=false) — the final rule is "FeedIngredient will be
 * soft deleted".
 * ?hard=true: permanently removes the document, but only when nothing references
 * it (FeedFormula, FeedRecommendation, FeedRecord, Inventory); otherwise 409.
 */
const deleteIngredient = async (ref: string, query: TPayload, context: TAuditContext) => {
  const ingredient = await findIngredientByRef(ref);
  const hard = parseBoolean(query.hard) === true;
  const usage = await countIngredientUsage(ingredient._id);

  if (!hard) {
    const retired = await setActiveStatus(ingredient, false, context);
    return { mode: "retired" as const, ingredient: retired, usage };
  }

  if (usage.total > 0) {
    throw new AppError(
      status.CONFLICT,
      `Cannot permanently delete: ingredient is referenced by ${usage.feedFormulas} formula(s), ${usage.feedRecommendations} recommendation(s), ${usage.feedRecords} feed record(s) and ${usage.inventories} inventory item(s). Retire it instead.`,
    );
  }

  const oldData = snapshot(ingredient);
  await FeedIngredientModel.deleteOne({ _id: ingredient._id });

  await recordAuditLog({
    context,
    entityType: AuditEntityTypes.FEED_INGREDIENT,
    entityId: ingredient._id,
    action: AuditActions.DELETE,
    module: AuditModules.FEED,
    event: "Ingredient Deleted",
    oldData,
  });

  return { mode: "deleted" as const, ingredient: null, usage };
};

export const FeedIngredientServices = {
  createIngredient,
  getAllIngredients,
  getIngredientLookup,
  getIngredientMeta,
  getIngredientStats,
  getIngredient,
  getIngredientUsage,
  getIngredientAuditLogs,
  updateIngredient,
  updateAvailability,
  toggleActive,
  deleteIngredient,
};
