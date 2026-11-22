import status from "http-status";
import mongoose, { isValidObjectId, Types } from "mongoose";
import type { ClientSession, HydratedDocument } from "mongoose";
import AppError from "../../errors/AppError.js";
import QueryBuilder from "../../builder/QueryBuilder.js";
import { AuditLogModel } from "../auditLog/auditLog.model.js";
import { AuditActions, AuditEntityTypes, AuditModules } from "../auditLog/auditLog.constants.js";
import { recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext } from "../auditLog/auditLog.utils.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { UserModel } from "../auth/auth.model.js";
import { executeAtomically } from "../feedRecord/feedRecord.utils.js";
import type { TUndo } from "../feedRecord/feedRecord.utils.js";
import { VaccineModel } from "../vaccine/vaccine.model.js";
import { DiseaseModel } from "./disease.model.js";
import {
  DISEASE_CLINICAL_FIELDS,
  DISEASE_LIMITS,
  DISEASE_REFERENCE_SOURCES,
  DiseaseCategories,
  DiseaseSeverities,
  SYMPTOM_SEARCH_DISCLAIMER,
} from "./disease.constants.js";
import type { TDisease, TDiseaseUsage } from "./disease.interface.js";
import {
  cleanStringList,
  escapeRegex,
  generateDiseaseCode,
  isSimilarName,
  normalizeText,
} from "./disease.utils.js";

type TPayload = Record<string, unknown>;
type TDiseaseDoc = HydratedDocument<TDisease>;

/* ------------------------------------------------------------------ */
/* Field whitelists                                                    */
/* ------------------------------------------------------------------ */

//fields a client may write through POST / PUT. diseaseCode, timestamps and isActive are
//never accepted (isActive is owned by PATCH /:id/toggle-active).
const WRITABLE_FIELDS = [
  "diseaseName",
  "category",
  "symptoms",
  "causes",
  "prevention",
  "severity",
  "contagious",
  "recommendedVaccineIds",
  "description",
] as const;

//optional text fields a PUT may clear by sending null / ""
const CLEARABLE_FIELDS = new Set<string>(["prevention", "description"]);

const SORT_FIELDS = new Set([
  "diseaseName",
  "diseaseCode",
  "category",
  "severity",
  "contagious",
  "isActive",
  "createdAt",
  "updatedAt",
]);

//select list for Treatment forms / health guides
const LOOKUP_FIELDS = "diseaseCode diseaseName category severity contagious";

//slim vaccine shape shown on a disease ("prevent with ...")
const VACCINE_SUMMARY_FIELDS =
  "vaccineCode vaccineName shortCode category dosage dosageUnit administrationRoute minimumAge boosterRequired boosterAfterDays repeatIntervalDays isMandatory isActive";

const SEVERITY_RANK: Record<string, number> = { Low: 1, Medium: 2, High: 3, Critical: 4 };

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

//long free text keeps its line breaks; only the ends are trimmed
const parseLongText = (field: string, value: unknown, max: number): string => {
  if (typeof value !== "string") throw new AppError(status.BAD_REQUEST, `${field} must be a string!`);
  const text = value.trim();
  if (text.length > max) throw new AppError(status.BAD_REQUEST, `${field} cannot exceed ${max} characters!`);
  return text;
};

//array of non-empty strings, trimmed + de-duplicated case-insensitively (spec §54)
const parseStringList = (field: string, value: unknown): string[] => {
  if (!Array.isArray(value)) throw new AppError(status.BAD_REQUEST, `${field} must be an array of strings!`);
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new AppError(status.BAD_REQUEST, `${field} items must be non-empty strings!`);
    }
    if (item.trim().length > DISEASE_LIMITS.maxListItemLength) {
      throw new AppError(
        status.BAD_REQUEST,
        `${field} items cannot exceed ${DISEASE_LIMITS.maxListItemLength} characters!`,
      );
    }
  }
  const cleaned = cleanStringList(value as string[]);
  if (cleaned.length > DISEASE_LIMITS.maxListItems) {
    throw new AppError(status.BAD_REQUEST, `${field} cannot exceed ${DISEASE_LIMITS.maxListItems} items!`);
  }
  return cleaned;
};

const parseObjectIdList = (field: string, value: unknown): Types.ObjectId[] => {
  if (!Array.isArray(value)) throw new AppError(status.BAD_REQUEST, `${field} must be an array!`);
  if (value.length > DISEASE_LIMITS.maxRecommendedVaccines) {
    throw new AppError(
      status.BAD_REQUEST,
      `${field} cannot exceed ${DISEASE_LIMITS.maxRecommendedVaccines} items!`,
    );
  }
  const unique = new Map<string, Types.ObjectId>();
  for (const item of value) {
    if (typeof item !== "string" || !isValidObjectId(item)) {
      throw new AppError(status.BAD_REQUEST, `${field} must contain valid Vaccine ObjectIds!`);
    }
    unique.set(item.toLowerCase(), new Types.ObjectId(item));
  }
  return [...unique.values()];
};

/**
 * validateRequest only parses and discards, so the raw body still carries unknown keys
 * and uncoerced values. Whitelist + coerce here.
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
      case "diseaseName":
        set[field] = parseString(field, value, 2, DISEASE_LIMITS.maxNameLength);
        break;
      case "category":
        assertEnum(field, value, Object.values(DiseaseCategories));
        set[field] = value;
        break;
      case "severity":
        assertEnum(field, value, Object.values(DiseaseSeverities));
        set[field] = value;
        break;
      case "symptoms":
      case "causes":
        set[field] = parseStringList(field, value);
        break;
      case "prevention":
        set[field] = parseLongText(field, value, DISEASE_LIMITS.maxPreventionLength);
        break;
      case "description":
        set[field] = parseLongText(field, value, DISEASE_LIMITS.maxDescriptionLength);
        break;
      case "contagious": {
        const parsed = parseBoolean(value);
        if (parsed === undefined) throw new AppError(status.BAD_REQUEST, "contagious must be a boolean!");
        set[field] = parsed;
        break;
      }
      case "recommendedVaccineIds":
        set[field] = parseObjectIdList(field, value);
        break;
    }
  }

  if (Array.isArray(set.symptoms) && set.symptoms.length === 0) {
    throw new AppError(status.BAD_REQUEST, "At least one symptom is required!");
  }
  return { set, unset };
};

/* ------------------------------------------------------------------ */
/* Access helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Platform admin / superAdmin (DB role, not the token) — the only users who may write
 * the master catalog or browse deactivated diseases in lists (spec §51/§85).
 */
const isCatalogAdmin = async (actorUserId?: string): Promise<boolean> => {
  if (!actorUserId) return false;
  const user = await UserModel.findOne({ userId: actorUserId }).select("systemRole").lean();
  return user?.systemRole === SystemRoles.ADMIN || user?.systemRole === SystemRoles.SUPER_ADMIN;
};

/* ------------------------------------------------------------------ */
/* Integrity helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Every recommendedVaccineIds entry must reference an existing Vaccine (spec §23/§77).
 * Newly linked vaccines must also be active; keeping an already-linked retired one is fine.
 */
const assertVaccinesExist = async (ids: Types.ObjectId[]) => {
  if (!ids.length) return;
  const found = await VaccineModel.find({ _id: { $in: ids } }).select("_id isActive vaccineName").lean();
  const byId = new Map(found.map((doc) => [String(doc._id), doc]));

  const missing = ids.filter((id) => !byId.has(String(id)));
  if (missing.length) {
    throw new AppError(
      status.BAD_REQUEST,
      `Unknown vaccine reference(s) in recommendedVaccineIds: ${missing.join(", ")}!`,
    );
  }
  const inactive = ids.filter((id) => byId.get(String(id))?.isActive === false);
  if (inactive.length) {
    throw new AppError(
      status.BAD_REQUEST,
      `Retired vaccine(s) cannot be recommended: ${inactive
        .map((id) => byId.get(String(id))?.vaccineName ?? String(id))
        .join(", ")}!`,
    );
  }
};

type TNameMatch = {
  _id: Types.ObjectId;
  diseaseCode: string;
  diseaseName: string;
  isActive: boolean;
  match: "exact" | "similar";
};

/**
 * Normalized duplicate detection (spec §10/§47/§78). The master catalog is small, so all
 * names are compared in memory: "Foot & Mouth Disease", "foot and mouth" and "FMD" all
 * match "Foot and Mouth Disease".
 */
const findNameMatches = async (name: string, excludeId?: Types.ObjectId): Promise<TNameMatch[]> => {
  const rows = await DiseaseModel.find(excludeId ? { _id: { $ne: excludeId } } : {})
    .select("diseaseCode diseaseName isActive")
    .lean();
  const matches: TNameMatch[] = [];
  for (const row of rows) {
    const match = isSimilarName(name, row.diseaseName);
    if (match) {
      matches.push({
        _id: row._id,
        diseaseCode: row.diseaseCode,
        diseaseName: row.diseaseName,
        isActive: row.isActive,
        match,
      });
    }
  }
  //exact first
  return matches.sort((a, b) => (a.match === b.match ? 0 : a.match === "exact" ? -1 : 1));
};

/**
 * Exact normalized match → always 409. A merely similar name (abbreviation, missing
 * "Disease") → 409 unless the admin re-submits with confirmDuplicate: true.
 */
const assertUniqueName = async (name: string, confirmDuplicate: boolean, excludeId?: Types.ObjectId) => {
  const matches = await findNameMatches(name, excludeId);
  const exact = matches.find((m) => m.match === "exact");
  if (exact) {
    throw new AppError(
      status.CONFLICT,
      `Disease already exists as "${exact.diseaseName}" (${exact.diseaseCode})${exact.isActive ? "" : " — it is deactivated; reactivate it instead"}!`,
    );
  }
  const similar = matches[0];
  if (similar && !confirmDuplicate) {
    throw new AppError(
      status.CONFLICT,
      `"${name}" looks like the existing disease "${similar.diseaseName}" (${similar.diseaseCode}). Review it, or resend with confirmDuplicate: true if it is a different disease.`,
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

const toDuplicateKeyError = (error: unknown): AppError | null => {
  const field = duplicateField(error);
  if (!field) return null;
  return new AppError(
    status.CONFLICT,
    field === "diseaseCode" ? "Disease code already exists, please retry!" : "Disease name already exists!",
  );
};

/**
 * Counts documents referencing this disease: Treatment (raw collection — module not
 * built yet; a missing collection counts 0) and Vaccine.targetDiseaseIds.
 */
const countDiseaseUsage = async (diseaseId: Types.ObjectId): Promise<TDiseaseUsage> => {
  const db = mongoose.connection.db;
  const counts = await Promise.all(
    DISEASE_REFERENCE_SOURCES.map(async (source) => {
      if (!db) return 0;
      try {
        return await db.collection(source.collection).countDocuments(source.filter(diseaseId));
      } catch {
        return 0;
      }
    }),
  );
  const usage: TDiseaseUsage = { treatments: 0, vaccines: 0, total: 0 };
  DISEASE_REFERENCE_SOURCES.forEach((source, index) => {
    const count = counts[index] ?? 0;
    usage[source.key] = count;
    usage.total += count;
  });
  return usage;
};

//plain snapshot for audit oldData/newData (ObjectIds/Dates become strings)
const snapshot = (doc: TDiseaseDoc | null, fields?: readonly string[]) => {
  if (!doc) return null;
  const plain = JSON.parse(JSON.stringify(doc.toObject())) as Record<string, unknown>;
  delete plain.__v;
  if (!fields) return plain;
  return Object.fromEntries(fields.map((field) => [field, plain[field] ?? null]));
};

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/* ------------------------------------------------------------------ */
/* Disease ↔ Vaccine relationship (spec §56/§57/§84)                   */
/* ------------------------------------------------------------------ */

type TLinkChange = { linked: Types.ObjectId[]; unlinked: Types.ObjectId[] };

/**
 * Mirrors recommendation changes onto Vaccine.targetDiseaseIds so both sides agree.
 * Only vaccines whose list actually changes are written, so the undo steps (used on a
 * standalone mongod without transactions) restore the exact previous state.
 */
const syncVaccineTargets = async (
  diseaseId: Types.ObjectId,
  added: Types.ObjectId[],
  removed: Types.ObjectId[],
  session: ClientSession | null,
  undo: TUndo,
): Promise<TLinkChange> => {
  const opts = session ? { session } : {};
  const change: TLinkChange = { linked: [], unlinked: [] };

  if (added.length) {
    const toLink = await VaccineModel.find(
      { _id: { $in: added }, targetDiseaseIds: { $ne: diseaseId } },
      { _id: 1 },
      opts,
    ).lean();
    change.linked = toLink.map((v) => v._id);
    if (change.linked.length) {
      await VaccineModel.updateMany(
        { _id: { $in: change.linked } },
        { $addToSet: { targetDiseaseIds: diseaseId } },
        opts,
      );
      undo.push(() =>
        VaccineModel.updateMany({ _id: { $in: change.linked } }, { $pull: { targetDiseaseIds: diseaseId } }),
      );
    }
  }

  if (removed.length) {
    const toUnlink = await VaccineModel.find(
      { _id: { $in: removed }, targetDiseaseIds: diseaseId },
      { _id: 1 },
      opts,
    ).lean();
    change.unlinked = toUnlink.map((v) => v._id);
    if (change.unlinked.length) {
      await VaccineModel.updateMany(
        { _id: { $in: change.unlinked } },
        { $pull: { targetDiseaseIds: diseaseId } },
        opts,
      );
      undo.push(() =>
        VaccineModel.updateMany(
          { _id: { $in: change.unlinked } },
          { $addToSet: { targetDiseaseIds: diseaseId } },
        ),
      );
    }
  }
  return change;
};

//one audit row per vaccine whose targetDiseaseIds changed (written after commit)
const auditVaccineLinks = async (
  disease: Pick<TDisease, "diseaseCode" | "diseaseName"> & { _id: Types.ObjectId },
  change: TLinkChange,
  context: TAuditContext,
) => {
  const rows = [
    ...change.linked.map((id) => ({ id, linked: true })),
    ...change.unlinked.map((id) => ({ id, linked: false })),
  ];
  await Promise.all(
    rows.map(({ id, linked }) =>
      recordAuditLog({
        context,
        entityType: AuditEntityTypes.VACCINE,
        entityId: id,
        action: AuditActions.UPDATE,
        module: AuditModules.HEALTH,
        event: "Target Disease Changed",
        oldData: null,
        newData: {
          [linked ? "addedTargetDiseaseId" : "removedTargetDiseaseId"]: String(disease._id),
          diseaseCode: disease.diseaseCode,
          diseaseName: disease.diseaseName,
          source: "Disease recommended-vaccine sync",
        },
        changedFields: ["targetDiseaseIds"],
      }),
    ),
  );
};

const diffIds = (before: Types.ObjectId[], after: Types.ObjectId[]) => {
  const b = new Set(before.map(String));
  const a = new Set(after.map(String));
  return {
    added: after.filter((id) => !b.has(String(id))),
    removed: before.filter((id) => !a.has(String(id))),
  };
};

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

//resolves either a Mongo _id or a public diseaseCode (DIS-00001)
const findDiseaseByRef = async (ref: string): Promise<TDiseaseDoc> => {
  const value = String(ref ?? "").trim();
  if (!value) throw new AppError(status.BAD_REQUEST, "Disease id or code is required!");

  const disease = isValidObjectId(value)
    ? await DiseaseModel.findById(value)
    : await DiseaseModel.findOne({ diseaseCode: value.toUpperCase() });

  if (!disease) throw new AppError(status.NOT_FOUND, "Disease not found!");
  return disease;
};

/**
 * Bidirectional prevention view: the recommended vaccines resolved from
 * recommendedVaccineIds. Farm users only see active vaccines (what they can actually
 * schedule); admins also get the retired ones so they can clean up the links.
 */
const loadRecommendedVaccines = async (ids: Types.ObjectId[], includeInactive: boolean) => {
  if (!ids.length) return { active: [], inactive: [] };
  const vaccines = await VaccineModel.find({ _id: { $in: ids } })
    .select(VACCINE_SUMMARY_FIELDS)
    .sort({ vaccineName: 1 })
    .lean();
  return {
    active: vaccines.filter((v) => v.isActive),
    inactive: includeInactive ? vaccines.filter((v) => !v.isActive) : [],
  };
};

/**
 * Full disease detail. Deactivated diseases stay readable by id/code for everyone so
 * historical Treatment references remain resolvable (spec §50/§76).
 */
const getDisease = async (ref: string, actorUserId?: string) => {
  const disease = await findDiseaseByRef(ref);
  const admin = await isCatalogAdmin(actorUserId);
  const { active, inactive } = await loadRecommendedVaccines(disease.recommendedVaccineIds, admin);

  return {
    ...disease.toObject(),
    recommendedVaccines: active,
    ...(admin ? { inactiveRecommendedVaccines: inactive } : {}),
    //vaccines linked but retired (count only for farm users)
    retiredRecommendedVaccineCount: disease.recommendedVaccineIds.length - active.length,
  };
};

const getRecommendedVaccines = async (ref: string, actorUserId?: string) => {
  const disease = await findDiseaseByRef(ref);
  const admin = await isCatalogAdmin(actorUserId);
  const { active, inactive } = await loadRecommendedVaccines(disease.recommendedVaccineIds, admin);
  return {
    disease: {
      _id: disease._id,
      diseaseCode: disease.diseaseCode,
      diseaseName: disease.diseaseName,
      isActive: disease.isActive,
      prevention: disease.prevention ?? null,
    },
    vaccines: active,
    ...(admin ? { inactiveVaccines: inactive } : {}),
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

//?recommendedVaccineId= (alias ?vaccineId=) — one or more Vaccine ObjectIds, comma-separated
const vaccineFilter = (query: TPayload) => {
  const raw = query.recommendedVaccineId ?? query.vaccineId;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const ids = raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => isValidObjectId(v))
    .map((v) => new Types.ObjectId(v));
  if (!ids.length) throw new AppError(status.BAD_REQUEST, "recommendedVaccineId must be a valid Vaccine ObjectId!");
  return ids.length === 1 ? ids[0] : { $in: ids };
};

/**
 * GET / — paginated catalog. Defaults to isActive=true; isActive=false|all (historical
 * inspection) is honoured only for platform admins — farm users always get active rows.
 */
const getAllDiseases = async (query: TPayload, actorUserId?: string) => {
  const filter: Record<string, unknown> = {};

  const category = multiEnumFilter(query.category, Object.values(DiseaseCategories));
  if (category !== undefined) filter.category = category;
  const severity = multiEnumFilter(query.severity, Object.values(DiseaseSeverities));
  if (severity !== undefined) filter.severity = severity;
  const contagious = parseBoolean(query.contagious);
  if (contagious !== undefined) filter.contagious = contagious;

  const requested = String(query.isActive ?? "").toLowerCase();
  const admin = requested && requested !== "true" ? await isCatalogAdmin(actorUserId) : false;
  if (admin && requested === "all") {
    //no isActive filter
  } else if (admin && requested === "false") {
    filter.isActive = false;
  } else {
    filter.isActive = true;
  }

  const vaccine = vaccineFilter(query);
  if (vaccine !== undefined) filter.recommendedVaccineIds = vaccine;

  //?symptom=Fever — diseases listing a symptom containing the text
  if (typeof query.symptom === "string" && query.symptom.trim()) {
    filter.symptoms = new RegExp(escapeRegex(query.symptom.trim().slice(0, 100)), "i");
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
  listQuery.sort = sortTokens.length ? sortTokens.join(",") : "diseaseName";
  listQuery.page = Math.max(Number(query.page) || 1, 1);
  listQuery.limit = Math.min(Math.max(Number(query.limit) || 10, 1), 100);

  if (typeof query.fields === "string" && query.fields.trim()) {
    listQuery.fields = query.fields
      .split(",")
      .map((f) => f.trim())
      .filter((f) => /^-?[A-Za-z]+$/.test(f))
      .join(",");
  }

  const diseaseQuery = new QueryBuilder<TDisease>(DiseaseModel.find(filter), listQuery)
    .search(["diseaseName", "diseaseCode", "symptoms", "causes"])
    .filter()
    .sort()
    .paginate()
    .fields();

  const [meta, diseases] = await Promise.all([diseaseQuery.countTotal(), diseaseQuery.modelQuery]);
  return { meta, diseases };
};

/**
 * Slim selector payload for Treatment forms / health guides.
 * Only active diseases (spec §26: inactive diseases are not selectable for new records).
 */
const getDiseaseLookup = async (query: TPayload) => {
  const filter: Record<string, unknown> = { isActive: true };

  const category = multiEnumFilter(query.category, Object.values(DiseaseCategories));
  if (category !== undefined) filter.category = category;
  const severity = multiEnumFilter(query.severity, Object.values(DiseaseSeverities));
  if (severity !== undefined) filter.severity = severity;
  const contagious = parseBoolean(query.contagious);
  if (contagious !== undefined) filter.contagious = contagious;
  const vaccine = vaccineFilter(query);
  if (vaccine !== undefined) filter.recommendedVaccineIds = vaccine;

  const searchTerm = typeof query.searchTerm === "string" ? query.searchTerm.trim() : "";
  if (searchTerm) {
    const regex = new RegExp(escapeRegex(searchTerm.slice(0, 100)), "i");
    filter.$or = [{ diseaseName: regex }, { diseaseCode: regex }];
  }

  return DiseaseModel.find(filter).select(LOOKUP_FIELDS).sort({ diseaseName: 1 }).limit(200).lean();
};

//single source of truth for the enums the frontend renders
const getDiseaseMeta = () => ({
  categories: Object.values(DiseaseCategories),
  severities: Object.values(DiseaseSeverities),
  limits: DISEASE_LIMITS,
  symptomSearchDisclaimer: SYMPTOM_SEARCH_DISCLAIMER,
});

const getDiseaseStats = async () => {
  const [summaryRows, categoryRows, severityRows] = await Promise.all([
    DiseaseModel.aggregate<{
      total: number;
      active: number;
      inactive: number;
      contagious: number;
      withVaccines: number;
    }>([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: ["$isActive", 1, 0] } },
          inactive: { $sum: { $cond: ["$isActive", 0, 1] } },
          //health numbers only count catalog-active diseases
          contagious: { $sum: { $cond: [{ $and: ["$isActive", "$contagious"] }, 1, 0] } },
          withVaccines: {
            $sum: {
              $cond: [
                { $and: ["$isActive", { $gt: [{ $size: { $ifNull: ["$recommendedVaccineIds", []] } }, 0] }] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
    DiseaseModel.aggregate<{ _id: string; count: number; contagious: number }>([
      { $match: { isActive: true } },
      { $group: { _id: "$category", count: { $sum: 1 }, contagious: { $sum: { $cond: ["$contagious", 1, 0] } } } },
    ]),
    DiseaseModel.aggregate<{ _id: string; count: number }>([
      { $match: { isActive: true } },
      { $group: { _id: "$severity", count: { $sum: 1 } } },
    ]),
  ]);

  const summary = summaryRows[0] ?? { total: 0, active: 0, inactive: 0, contagious: 0, withVaccines: 0 };
  const byCategory = new Map(categoryRows.map((row) => [row._id, row]));
  const bySeverity = new Map(severityRows.map((row) => [row._id, row.count]));

  return {
    total: summary.total,
    active: summary.active,
    inactive: summary.inactive,
    contagious: summary.contagious,
    withRecommendedVaccines: summary.withVaccines,
    withoutRecommendedVaccines: summary.active - summary.withVaccines,
    //every enum value present (0 included), in enum order; active diseases only
    byCategory: Object.values(DiseaseCategories).map((value) => ({
      category: value,
      count: byCategory.get(value)?.count ?? 0,
      contagious: byCategory.get(value)?.contagious ?? 0,
    })),
    bySeverity: Object.values(DiseaseSeverities).map((value) => ({
      severity: value,
      count: bySeverity.get(value) ?? 0,
    })),
  };
};

//?symptoms=Fever,Salivation or ?symptoms=Fever&symptoms=Salivation
const parseSymptomQuery = (raw: unknown): string[] => {
  const parts = (Array.isArray(raw) ? raw : [raw])
    .filter((v): v is string => typeof v === "string")
    .flatMap((v) => v.split(","));
  const symptoms = cleanStringList(parts).map((s) => s.slice(0, 100));
  if (!symptoms.length) {
    throw new AppError(status.BAD_REQUEST, "Provide at least one symptom, e.g. ?symptoms=Fever,Salivation");
  }
  if (symptoms.length > DISEASE_LIMITS.maxSymptomQuery) {
    throw new AppError(status.BAD_REQUEST, `At most ${DISEASE_LIMITS.maxSymptomQuery} symptoms can be searched at once!`);
  }
  return symptoms;
};

/**
 * GET /search-by-symptoms — reference lookup ranked by symptom overlap.
 * Clinical safety rule (spec §16/§44): never presented as a diagnosis; every response
 * carries the disclaimer. A query symptom matches a disease symptom when either text
 * contains the other, case-insensitively ("fever" ↔ "High Fever").
 */
const searchBySymptoms = async (query: TPayload) => {
  const symptoms = parseSymptomQuery(query.symptoms ?? query.symptom);
  const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 50);

  const category = multiEnumFilter(query.category, Object.values(DiseaseCategories));

  //the active master catalog is small, so overlap is scored in memory — a regex
  //prefilter would miss the reverse direction ("High Fever" query vs "Fever" symptom)
  const candidateFilter: Record<string, unknown> = { isActive: true };
  if (category !== undefined) candidateFilter.category = category;
  const candidates = await DiseaseModel.find(candidateFilter)
    .select("diseaseCode diseaseName category severity contagious symptoms recommendedVaccineIds")
    .lean();

  const lowered = symptoms.map((s) => s.toLowerCase());
  const results = candidates
    .map((disease) => {
      const diseaseSymptoms = disease.symptoms ?? [];
      const matchedQuery: string[] = [];
      const matchedDisease = new Set<string>();
      lowered.forEach((q, index) => {
        const hits = diseaseSymptoms.filter((ds) => {
          const d = ds.toLowerCase();
          return d.includes(q) || q.includes(d);
        });
        if (hits.length) {
          matchedQuery.push(symptoms[index] as string);
          hits.forEach((h) => matchedDisease.add(h));
        }
      });
      return {
        _id: disease._id,
        diseaseCode: disease.diseaseCode,
        diseaseName: disease.diseaseName,
        category: disease.category,
        severity: disease.severity,
        contagious: disease.contagious,
        recommendedVaccineCount: disease.recommendedVaccineIds?.length ?? 0,
        matchedSymptoms: matchedQuery,
        matchedDiseaseSymptoms: [...matchedDisease],
        unmatchedQuerySymptoms: symptoms.filter((s) => !matchedQuery.includes(s)),
        matchCount: matchedQuery.length,
        //share of the observed symptoms this disease explains
        queryCoverage: Number((matchedQuery.length / symptoms.length).toFixed(2)),
        //share of this disease's listed symptoms that were observed
        diseaseCoverage: diseaseSymptoms.length
          ? Number((matchedDisease.size / diseaseSymptoms.length).toFixed(2))
          : 0,
      };
    })
    .filter((row) => row.matchCount > 0)
    .sort(
      (a, b) =>
        b.matchCount - a.matchCount ||
        b.diseaseCoverage - a.diseaseCoverage ||
        (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
        a.diseaseName.localeCompare(b.diseaseName),
    );

  return {
    disclaimer: SYMPTOM_SEARCH_DISCLAIMER,
    querySymptoms: symptoms,
    totalMatches: results.length,
    results: results.slice(0, limit),
  };
};

//GET /check-name?diseaseName=&excludeId= — lets the admin form warn before submitting
const checkDiseaseName = async (query: TPayload) => {
  const name = typeof query.diseaseName === "string" ? normalizeText(query.diseaseName) : "";
  if (name.length < 2) throw new AppError(status.BAD_REQUEST, "diseaseName must be at least 2 characters!");
  const excludeId =
    typeof query.excludeId === "string" && isValidObjectId(query.excludeId)
      ? new Types.ObjectId(query.excludeId)
      : undefined;
  const matches = await findNameMatches(name, excludeId);
  return {
    diseaseName: name,
    available: !matches.some((m) => m.match === "exact"),
    requiresConfirmation: matches.length > 0 && !matches.some((m) => m.match === "exact"),
    matches,
  };
};

const getDiseaseUsage = async (ref: string) => {
  const disease = await findDiseaseByRef(ref);
  const usage = await countDiseaseUsage(disease._id);
  return {
    _id: disease._id,
    diseaseCode: disease.diseaseCode,
    diseaseName: disease.diseaseName,
    isActive: disease.isActive,
    usage,
    canHardDelete: usage.total === 0,
  };
};

//change history of one disease (admin only), newest first
const getDiseaseAuditLogs = async (ref: string, query: TPayload) => {
  const disease = await findDiseaseByRef(ref);
  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
  const filter = { entityType: AuditEntityTypes.DISEASE, entityId: disease._id };

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

const REQUIRED_ON_CREATE = ["diseaseName", "category", "symptoms", "severity"] as const;

/**
 * POST / — canonical master record. diseaseCode is generated (DIS-00001), the name goes
 * through normalized duplicate detection, every recommended vaccine must exist and be
 * active, and (unless syncVaccineTargets=false) the disease is added to each vaccine's
 * targetDiseaseIds in the same atomic unit.
 */
const createDisease = async (payload: TPayload, context: TAuditContext) => {
  const body = payload ?? {};
  const { set } = pickFields(body, false);

  for (const field of REQUIRED_ON_CREATE) {
    if (set[field] === undefined) throw new AppError(status.BAD_REQUEST, `${field} is required!`);
  }
  const confirmDuplicate = parseBoolean(body.confirmDuplicate) === true;
  const sync = parseBoolean(body.syncVaccineTargets) !== false;

  await assertUniqueName(set.diseaseName as string, confirmDuplicate);
  const vaccineIds = (set.recommendedVaccineIds as Types.ObjectId[] | undefined) ?? [];
  await assertVaccinesExist(vaccineIds);

  //retry when two creations race for the same generated code
  let result: { created: TDiseaseDoc; change: TLinkChange } | null = null;
  for (let attempt = 0; attempt < 3 && !result; attempt++) {
    const diseaseCode = await generateDiseaseCode();
    try {
      result = await executeAtomically(async (session, undo) => {
        const [created] = await DiseaseModel.create(
          [
            {
              ...set,
              diseaseCode,
              causes: (set.causes as string[] | undefined) ?? [],
              contagious: (set.contagious as boolean | undefined) ?? false,
              recommendedVaccineIds: vaccineIds,
              isActive: true,
            },
          ],
          session ? { session } : {},
        );
        if (!created) throw new AppError(status.INTERNAL_SERVER_ERROR, "Disease could not be created!");
        undo.push(() => DiseaseModel.deleteOne({ _id: created._id }));

        const change = sync
          ? await syncVaccineTargets(created._id, vaccineIds, [], session, undo)
          : { linked: [], unlinked: [] };
        return { created, change };
      });
    } catch (error) {
      if (duplicateField(error) === "diseaseCode" && attempt < 2) continue;
      throw toDuplicateKeyError(error) ?? error;
    }
  }
  if (!result) throw new AppError(status.CONFLICT, "Could not generate a disease code, please retry!");
  const { created, change } = result;

  await recordAuditLog({
    context,
    entityType: AuditEntityTypes.DISEASE,
    entityId: created._id,
    action: AuditActions.CREATE,
    module: AuditModules.HEALTH,
    event: "Disease Created",
    newData: snapshot(created),
  });
  await auditVaccineLinks(created, change, context);

  return created;
};

//most specific audit label wins (spec §69); changedFields carries the full detail
const updateEventLabel = (changed: string[]) => {
  const has = (...fields: string[]) => fields.some((f) => changed.includes(f));
  if (has("category")) return "Category Changed";
  if (has("recommendedVaccineIds")) return "Recommended Vaccine Changed";
  if (has("symptoms")) return "Symptoms Changed";
  if (has("prevention")) return "Prevention Changed";
  if (has("severity", "contagious")) return "Severity Changed";
  if (has("causes")) return "Causes Changed";
  if (has("diseaseName")) return "Disease Renamed";
  return "Disease Updated";
};

type TUpdateResult = { disease: TDiseaseDoc; changedFields: string[]; clinicalChanged: boolean };

/**
 * Writes the changed fields (+ optional vaccine sync) atomically and audits once.
 * Shared by PUT and PATCH /recommended-vaccines.
 */
const applyDiseaseChanges = async (
  disease: TDiseaseDoc,
  setChanged: Record<string, unknown>,
  unsetChanged: string[],
  changedFields: string[],
  sync: boolean,
  context: TAuditContext,
  eventOverride?: string,
): Promise<TUpdateResult> => {
  const before = snapshot(disease) ?? {};
  const vaccineDiff = changedFields.includes("recommendedVaccineIds")
    ? diffIds(disease.recommendedVaccineIds, setChanged.recommendedVaccineIds as Types.ObjectId[])
    : { added: [], removed: [] };

  let result: { updated: TDiseaseDoc; change: TLinkChange };
  try {
    result = await executeAtomically(async (session, undo) => {
      const updated = await DiseaseModel.findByIdAndUpdate(
        disease._id,
        {
          ...(Object.keys(setChanged).length ? { $set: setChanged } : {}),
          ...(unsetChanged.length ? { $unset: Object.fromEntries(unsetChanged.map((f) => [f, 1])) } : {}),
        },
        { returnDocument: "after", runValidators: true, ...(session ? { session } : {}) },
      );
      if (!updated) throw new AppError(status.NOT_FOUND, "Disease not found!");

      //compensation: restore the previous values of exactly the changed fields
      const restoreSet: Record<string, unknown> = {};
      const restoreUnset: Record<string, 1> = {};
      for (const field of changedFields) {
        const old = (disease.toObject() as Record<string, unknown>)[field];
        if (old === undefined || old === null) restoreUnset[field] = 1;
        else restoreSet[field] = old;
      }
      undo.push(() =>
        DiseaseModel.updateOne(
          { _id: disease._id },
          {
            ...(Object.keys(restoreSet).length ? { $set: restoreSet } : {}),
            ...(Object.keys(restoreUnset).length ? { $unset: restoreUnset } : {}),
          },
        ),
      );

      const change =
        sync && (vaccineDiff.added.length || vaccineDiff.removed.length)
          ? await syncVaccineTargets(disease._id, vaccineDiff.added, vaccineDiff.removed, session, undo)
          : { linked: [], unlinked: [] };
      return { updated, change };
    });
  } catch (error) {
    throw toDuplicateKeyError(error) ?? error;
  }

  const { updated, change } = result;
  await recordAuditLog({
    context,
    entityType: AuditEntityTypes.DISEASE,
    entityId: updated._id,
    action: AuditActions.UPDATE,
    module: AuditModules.HEALTH,
    event: eventOverride ?? updateEventLabel(changedFields),
    oldData: Object.fromEntries(changedFields.map((f) => [f, before[f] ?? null])),
    newData: snapshot(updated, changedFields),
    changedFields,
  });
  await auditVaccineLinks(updated, change, context);

  const clinicalChanged = changedFields.some((f) =>
    (DISEASE_CLINICAL_FIELDS as readonly string[]).includes(f),
  );
  return { disease: updated, changedFields, clinicalChanged };
};

/**
 * PUT /:id — refine master guidance. Arrays are trimmed/de-duplicated, the name goes
 * through duplicate detection again, newly added vaccines must be active. Historical
 * Treatment / Vaccination records keep the same disease identity (spec §49/§81).
 */
const updateDisease = async (ref: string, payload: TPayload, context: TAuditContext) => {
  const body = payload ?? {};
  const disease = await findDiseaseByRef(ref);
  const { set, unset } = pickFields(body, true);

  if (!Object.keys(set).length && !unset.length) {
    throw new AppError(status.BAD_REQUEST, "No updatable disease fields were provided!");
  }

  const before = snapshot(disease) ?? {};
  const changedFields = [
    ...Object.keys(set).filter((field) => !sameValue(before[field], JSON.parse(JSON.stringify(set[field])))),
    ...unset.filter((field) => before[field] !== undefined && before[field] !== null),
  ];
  if (!changedFields.length) {
    return { disease, changedFields: [], clinicalChanged: false } satisfies TUpdateResult;
  }

  if (changedFields.includes("diseaseName")) {
    await assertUniqueName(set.diseaseName as string, parseBoolean(body.confirmDuplicate) === true, disease._id);
  }
  if (changedFields.includes("recommendedVaccineIds")) {
    const { added } = diffIds(disease.recommendedVaccineIds, set.recommendedVaccineIds as Types.ObjectId[]);
    await assertVaccinesExist(added);
  }

  const setChanged = Object.fromEntries(Object.entries(set).filter(([field]) => changedFields.includes(field)));
  const unsetChanged = unset.filter((field) => changedFields.includes(field));
  const sync = parseBoolean(body.syncVaccineTargets) !== false;

  return applyDiseaseChanges(disease, setChanged, unsetChanged, changedFields, sync, context);
};

/**
 * PATCH /:id/recommended-vaccines { add?: [], remove?: [], syncVaccineTargets? }
 * $addToSet / $pull semantics without resending the full list. Removing a vaccine only
 * changes current prevention guidance; historical Vaccination records are untouched.
 */
const updateRecommendedVaccines = async (ref: string, payload: TPayload, context: TAuditContext) => {
  const body = payload ?? {};
  const disease = await findDiseaseByRef(ref);
  const add = body.add === undefined ? [] : parseObjectIdList("add", body.add);
  const remove = body.remove === undefined ? [] : parseObjectIdList("remove", body.remove);
  if (!add.length && !remove.length) {
    throw new AppError(status.BAD_REQUEST, "Provide at least one vaccine id in add or remove!");
  }
  const removeSet = new Set(remove.map(String));
  if (add.some((id) => removeSet.has(String(id)))) {
    throw new AppError(status.BAD_REQUEST, "The same vaccine cannot be added and removed in one request!");
  }

  const current = disease.recommendedVaccineIds;
  const currentSet = new Set(current.map(String));
  const toAdd = add.filter((id) => !currentSet.has(String(id)));
  await assertVaccinesExist(toAdd);

  const next = [...current.filter((id) => !removeSet.has(String(id))), ...toAdd];
  if (next.length > DISEASE_LIMITS.maxRecommendedVaccines) {
    throw new AppError(
      status.BAD_REQUEST,
      `A disease can recommend at most ${DISEASE_LIMITS.maxRecommendedVaccines} vaccines!`,
    );
  }
  const removedCount = current.length - (next.length - toAdd.length);
  const sync = parseBoolean(body.syncVaccineTargets) !== false;

  if (!toAdd.length && !removedCount) {
    //every id was already linked / already absent — no write, no audit row
    return { disease, changedFields: [], clinicalChanged: false, added: 0, removed: 0 };
  }

  const result = await applyDiseaseChanges(
    disease,
    { recommendedVaccineIds: next },
    [],
    ["recommendedVaccineIds"],
    sync,
    context,
    "Recommended Vaccine Changed",
  );
  return { ...result, added: toAdd.length, removed: removedCount };
};

//permanent catalog status. Deactivating hides the disease from new Treatment selection
//but keeps the document, so historical references never break (spec §50).
const setActiveStatus = async (
  disease: TDiseaseDoc,
  isActive: boolean,
  context: TAuditContext,
  reason?: string,
) => {
  if (isActive === disease.isActive) return disease;

  const updated = await DiseaseModel.findByIdAndUpdate(
    disease._id,
    { $set: { isActive } },
    { returnDocument: "after", runValidators: true },
  );
  if (!updated) throw new AppError(status.NOT_FOUND, "Disease not found!");

  await recordAuditLog({
    context,
    entityType: AuditEntityTypes.DISEASE,
    entityId: updated._id,
    action: isActive ? AuditActions.UPDATE : AuditActions.ARCHIVE,
    module: AuditModules.HEALTH,
    event: isActive ? "Disease Activated" : "Disease Deactivated",
    oldData: { isActive: disease.isActive },
    newData: { isActive, ...(reason ? { reason } : {}) },
    changedFields: ["isActive"],
  });
  return updated;
};

const toggleActive = async (ref: string, payload: TPayload, context: TAuditContext) => {
  const disease = await findDiseaseByRef(ref);
  const body = payload ?? {};

  let isActive = !disease.isActive; //no value = toggle
  if (body.isActive !== undefined) {
    const parsed = parseBoolean(body.isActive);
    if (parsed === undefined) throw new AppError(status.BAD_REQUEST, "isActive must be a boolean!");
    isActive = parsed;
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : undefined;
  return setActiveStatus(disease, isActive, context, reason);
};

/**
 * DELETE /:id
 * Default: soft delete (isActive=false) — the final schema allows only soft delete.
 * ?hard=true: permanently removes the record only when nothing references it (Treatment,
 * Vaccine.targetDiseaseIds). A referenced disease is deactivated instead, never removed.
 */
const deleteDisease = async (ref: string, query: TPayload, context: TAuditContext) => {
  const disease = await findDiseaseByRef(ref);
  const hard = parseBoolean(query.hard) === true;
  const usage = await countDiseaseUsage(disease._id);

  if (!hard || usage.total > 0) {
    const deactivated = await setActiveStatus(disease, false, context, hard ? "Hard delete blocked: disease is referenced" : undefined);
    return { mode: "deactivated" as const, hardDeleteBlocked: hard, disease: deactivated, usage };
  }

  const oldData = snapshot(disease);
  await DiseaseModel.deleteOne({ _id: disease._id });

  await recordAuditLog({
    context,
    entityType: AuditEntityTypes.DISEASE,
    entityId: disease._id,
    action: AuditActions.DELETE,
    module: AuditModules.HEALTH,
    event: "Disease Deleted",
    oldData,
  });
  return { mode: "deleted" as const, hardDeleteBlocked: false, disease: null, usage };
};

export const DiseaseServices = {
  createDisease,
  getAllDiseases,
  getDiseaseLookup,
  getDiseaseMeta,
  getDiseaseStats,
  searchBySymptoms,
  checkDiseaseName,
  getDisease,
  getRecommendedVaccines,
  getDiseaseUsage,
  getDiseaseAuditLogs,
  updateDisease,
  updateRecommendedVaccines,
  toggleActive,
  deleteDisease,
};
