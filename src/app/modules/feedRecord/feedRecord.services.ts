import status from "http-status";
import mongoose, { isValidObjectId, Types } from "mongoose";
import type { ClientSession } from "mongoose";
import AppError from "../../errors/AppError.js";
import { AnimalModel } from "../animal/animal.model.js";
import { AnimalLifeStatuses } from "../animal/animal.constants.js";
import { AuditLogModel } from "../auditLog/auditLog.model.js";
import { AuditActions, AuditEntityTypes, AuditModules } from "../auditLog/auditLog.constants.js";
import type { TAuditAction } from "../auditLog/auditLog.interface.js";
import { recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext } from "../auditLog/auditLog.utils.js";
import { FarmModel } from "../farm/farm.model.js";
import { FarmStatuses } from "../farm/farm.constants.js";
import { FarmMemberModel } from "../farmMember/farmMember.model.js";
import type { TFarmMemberRole } from "../farmMember/farmMember.interface.js";
import { FarmMemberServices } from "../farmMember/farmMember.service.js";
import { UnitConversions } from "../feedFormula/feedFormula.constants.js";
import { convertQuantity, toKilograms, unitsCompatible } from "../feedFormula/feedFormula.utils.js";
import { FeedIngredientModel } from "../feedIngredient/feedIngredient.model.js";
import { ACTIVE_RECOMMENDATION_STATUSES } from "../feedRecommendation/feedRecommendation.constants.js";
import { FeedRecommendationModel } from "../feedRecommendation/feedRecommendation.model.js";
import { RECOMMENDATION_NO_PATTERN } from "../feedRecommendation/feedRecommendation.utils.js";
import {
  InventoryReferenceTypes,
  InventoryTransactionTypes,
} from "../inventory/inventory.constants.js";
import type { TInventoryUnit } from "../inventory/inventory.interface.js";
import { InventoryModel, InventoryTransactionModel } from "../inventory/inventory.model.js";
import {
  applyStockChange,
  findFeedInventory,
  generateTransactionNo,
  isUnusableInventory,
} from "../inventory/inventory.utils.js";
import {
  ADHERENCE_TOLERANCE_PERCENT,
  DEFAULT_SUMMARY_DAYS,
  FEEDING_SESSION_ORDER,
  FEEDING_WARNING_HEALTH_STATUSES,
  FeedingSessions,
  FeedRecordPermissions,
  FUTURE_TOLERANCE_HOURS,
  LINKABLE_RECOMMENDATION_STATUSES,
  MAX_BACKDATE_DAYS,
  MAX_ITEM_QUANTITY,
  MAX_ITEMS_PER_RECORD,
  MAX_LIST_LIMIT,
  MAX_SUMMARY_DAYS,
  MAX_TEXT_LENGTH,
  MAX_UNIT_PRICE,
  SERVER_CALCULATED_FIELDS,
} from "./feedRecord.constants.js";
import type { TFeedingSession, TFeedRecord, TFeedRecordItem } from "./feedRecord.interface.js";
import { FeedRecordModel } from "./feedRecord.model.js";
import {
  DAY_MS,
  dayKey,
  escapeRegex,
  executeAtomically,
  isBlank,
  pageMeta,
  parseBoolean,
  parseCalendarDate,
  parseDateRange,
  parseEnum,
  parseEnumList,
  parseNumber,
  parseObjectId,
  parsePaging,
  parseText,
  round,
} from "./feedRecord.utils.js";
import type { TPayload, TUndo } from "./feedRecord.utils.js";

const SESSIONS = Object.values(FeedingSessions) as string[];
const UNITS = Object.keys(UnitConversions);
const round4 = (value: number) => round(value, 4);
const sessionOpts = (session: ClientSession | null) => (session ? { session } : {});

/* -------------------------------------------------------------------------- */
/*                         Farm-scoped authorization                          */
/* -------------------------------------------------------------------------- */

type TAccess = {
  farmObjectId: Types.ObjectId;
  farmStatus: string;
  role: TFarmMemberRole;
  //FarmMember _id of the caller; null only for a super admin without a membership row
  memberObjectId: Types.ObjectId | null;
};

/** Active membership (super admin / Farm.ownerId act as Owner) + farm status. */
const resolveAccess = async (farmId: string, requesterUserId: string): Promise<TAccess> => {
  const access = await FarmMemberServices.resolveFarmAccess(farmId, requesterUserId);
  const role = FarmMemberServices.getActorRole(access);
  if (!role) throw new AppError(status.FORBIDDEN, "You are not an active member of this farm!");

  let memberObjectId = (access.membership?._id as Types.ObjectId | undefined) ?? null;
  if (!memberObjectId && access.isOwnerAccount) {
    //the owner account self-heals a missing Owner row so it can always sign records
    const row = await FarmMemberServices.ensureOwnerMembership(access.farm._id, access.user._id);
    memberObjectId = (row?._id as Types.ObjectId | undefined) ?? null;
  }
  const farm = await FarmModel.findById(access.farm._id).select("status").lean();
  return {
    farmObjectId: access.farm._id,
    farmStatus: farm?.status ?? FarmStatuses.ACTIVE,
    role,
    memberObjectId,
  };
};

const can = (access: TAccess, allowed: readonly TFarmMemberRole[]) => allowed.includes(access.role);

const requireRole = (access: TAccess, allowed: readonly TFarmMemberRole[], action: string) => {
  if (!can(access, allowed)) {
    throw new AppError(status.FORBIDDEN, `Your farm role (${access.role}) is not allowed to ${action}!`);
  }
};

/** Setup / Suspended / Inactive farms cannot log feeding (records stay readable). */
const requireWritableFarm = (access: TAccess) => {
  if (access.farmStatus !== FarmStatuses.ACTIVE) {
    throw new AppError(
      status.FORBIDDEN,
      `This farm is ${access.farmStatus} — feed records can only be written on an Active farm!`,
    );
  }
};

//stock movements and voiding are signed by a FarmMember row
const requireMemberRow = (access: TAccess): Types.ObjectId => {
  if (!access.memberObjectId) {
    throw new AppError(status.FORBIDDEN, "An active farm membership is required to write feed records!");
  }
  return access.memberObjectId;
};

//totals and void metadata are server-owned (spec §23 cost integrity)
const rejectServerFields = (body: TPayload) => {
  const sent = SERVER_CALCULATED_FIELDS.filter((field) => field in body);
  if (sent.length) {
    throw new AppError(
      status.BAD_REQUEST,
      `${sent.join(", ")} cannot be sent — the server calculates these values.`,
    );
  }
};

/* -------------------------------------------------------------------------- */
/*                             Draft construction                             */
/* -------------------------------------------------------------------------- */

type TIngredientMaster = {
  _id: Types.ObjectId;
  ingredientCode: string;
  ingredientName: string;
  category: string;
  unit: string;
  pricePerUnit: number;
  isAvailable: boolean;
  isActive: boolean;
};

//computed line + non-persisted detail for previews
type TDraftItem = TFeedRecordItem & {
  ingredientCode: string;
  category: string;
  //catalog reference price converted to this line's unit
  catalogUnitPrice: number;
  priceSource: "catalog" | "snapshot" | "manual";
  quantityKg: number | null;
};

type TDraft = {
  animal: {
    _id: Types.ObjectId;
    animalCode: string;
    name?: string;
    lifeStatus: string;
    healthStatus: string;
  };
  feedingSession: TFeedingSession;
  feedingDate: Date;
  fedBy: Types.ObjectId;
  recommendationId: Types.ObjectId | null;
  recommendation: Record<string, unknown> | null;
  remarks: string | undefined;
  items: TDraftItem[];
  totalFeedQuantity: number;
  totalCost: number;
  warnings: string[];
  blockers: string[];
};

const INGREDIENT_FIELDS = "ingredientCode ingredientName category unit pricePerUnit isAvailable isActive";

//animal reference: Mongo _id or the farm's animalCode (AN-000001)
const findAnimal = async (access: TAccess, ref: unknown) => {
  const value = String(ref ?? "").trim();
  if (!value) throw new AppError(status.BAD_REQUEST, "animalId is required!");
  const animal = await AnimalModel.findOne(
    isValidObjectId(value)
      ? { _id: new Types.ObjectId(value), farmId: access.farmObjectId }
      : { animalCode: value.toUpperCase(), farmId: access.farmObjectId },
  )
    .select("animalCode name gender lifeStatus healthStatus isActive birthDate")
    .lean();
  //an animal of another farm is reported as missing (farm isolation, spec §72)
  if (!animal) throw new AppError(status.NOT_FOUND, "Animal not found in this farm!");
  return animal;
};

//recommendation reference: Mongo _id or REC-YYYY-NNNNNN, always farm-scoped
const findRecommendationRef = async (access: TAccess, ref: unknown) => {
  const value = String(ref ?? "").trim();
  let filter: Record<string, unknown>;
  if (isValidObjectId(value)) filter = { _id: new Types.ObjectId(value) };
  else if (RECOMMENDATION_NO_PATTERN.test(value)) filter = { recommendationNo: value.toUpperCase() };
  else throw new AppError(status.BAD_REQUEST, "recommendationId must be an id or a REC-YYYY-NNNNNN number!");
  const rec = await FeedRecommendationModel.findOne({ ...filter, farmId: access.farmObjectId })
    .select("recommendationNo animalId status generatedAt estimatedDailyCost totalRecommendedDMI recommendedItems")
    .lean();
  if (!rec) throw new AppError(status.NOT_FOUND, "Feed recommendation not found in this farm!");
  return rec;
};

const parseFeedingDate = (value: unknown, birthDate?: Date | null): Date => {
  const date = parseCalendarDate("feedingDate", value);
  const now = Date.now();
  if (date.getTime() > now + FUTURE_TOLERANCE_HOURS * 60 * 60 * 1000) {
    throw new AppError(status.BAD_REQUEST, "feedingDate cannot be in the future!");
  }
  if (date.getTime() < now - MAX_BACKDATE_DAYS * DAY_MS) {
    throw new AppError(status.BAD_REQUEST, `feedingDate cannot be more than ${MAX_BACKDATE_DAYS} days in the past!`);
  }
  if (birthDate && date.getTime() < new Date(dayKey(birthDate)).getTime()) {
    throw new AppError(status.BAD_REQUEST, "feedingDate cannot be before the animal's birth date!");
  }
  return date;
};

//price per 1 `toUnit`, given a price per 1 `fromUnit`
const priceIn = (pricePerFromUnit: number, fromUnit: string, toUnit: string) =>
  round4(pricePerFromUnit * convertQuantity(1, toUnit, fromUnit));

/**
 * Validates the lines and snapshots ingredientName + unitPrice.
 *  - unit defaults to the catalog unit and must be convertible to it (kg↔g, liter↔ml).
 *  - unitPrice defaults to the catalog reference price; on a correction an existing
 *    line keeps its original snapshot price. A different price is an "actual price"
 *    and needs Owner / Manager.
 *  - totalCost = quantity × unitPrice is always calculated here (never trusted).
 */
const buildItems = async (
  access: TAccess,
  raw: unknown,
  previous: TFeedRecordItem[],
  warnings: string[],
): Promise<TDraftItem[]> => {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AppError(status.BAD_REQUEST, "items must contain at least one ingredient!");
  }
  if (raw.length > MAX_ITEMS_PER_RECORD) {
    throw new AppError(status.BAD_REQUEST, `A feed record can have at most ${MAX_ITEMS_PER_RECORD} items!`);
  }

  const lines = raw.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new AppError(status.BAD_REQUEST, `items[${index}] is invalid!`);
    const line = entry as TPayload;
    return {
      index,
      ingredientId: parseObjectId(`items[${index}].ingredientId`, line.ingredientId),
      quantity: parseNumber(`items[${index}].quantity`, line.quantity, { min: 0, max: MAX_ITEM_QUANTITY, exclusiveMin: true }),
      unit: isBlank(line.unit) ? null : parseEnum(`items[${index}].unit`, line.unit, UNITS),
      unitPrice: isBlank(line.unitPrice)
        ? null
        : parseNumber(`items[${index}].unitPrice`, line.unitPrice, { min: 0, max: MAX_UNIT_PRICE }),
    };
  });

  const seen = new Set<string>();
  for (const line of lines) {
    const key = String(line.ingredientId);
    if (seen.has(key)) {
      throw new AppError(status.BAD_REQUEST, "Each ingredient may appear only once per feed record — add the quantities together.");
    }
    seen.add(key);
  }

  const masters = (await FeedIngredientModel.find({ _id: { $in: lines.map((l) => l.ingredientId) } })
    .select(INGREDIENT_FIELDS)
    .lean()) as unknown as TIngredientMaster[];
  const masterOf = new Map(masters.map((m) => [String(m._id), m]));
  const previousOf = new Map(previous.map((p) => [String(p.ingredientId), p]));
  const mayOverridePrice = can(access, FeedRecordPermissions.OVERRIDE_PRICE);

  return lines.map((line) => {
    const master = masterOf.get(String(line.ingredientId));
    if (!master) throw new AppError(status.NOT_FOUND, `items[${line.index}]: ingredient not found!`);
    const prev = previousOf.get(String(line.ingredientId));
    //retired ingredients cannot be added, but lines already on the record stay valid
    if (!master.isActive && !prev) {
      throw new AppError(status.CONFLICT, `${master.ingredientName} is retired from the ingredient catalog!`);
    }
    if (!master.isAvailable && !prev) warnings.push(`${master.ingredientName} is marked unavailable in the catalog.`);

    const unit = line.unit ?? prev?.unit ?? master.unit;
    if (!unitsCompatible(unit, master.unit)) {
      throw new AppError(
        status.BAD_REQUEST,
        `items[${line.index}].unit "${unit}" cannot be converted to ${master.ingredientName}'s unit (${master.unit})!`,
      );
    }

    const catalogUnitPrice = priceIn(master.pricePerUnit, master.unit, unit);
    const snapshotPrice = prev ? priceIn(prev.unitPrice, prev.unit, unit) : null;
    const defaultPrice = snapshotPrice ?? catalogUnitPrice;
    let unitPrice = defaultPrice;
    let priceSource: TDraftItem["priceSource"] = prev ? "snapshot" : "catalog";
    if (line.unitPrice !== null && Math.abs(line.unitPrice - defaultPrice) > 0.0001) {
      if (!mayOverridePrice) {
        throw new AppError(
          status.FORBIDDEN,
          `Only an Owner or Manager can enter a custom price (${master.ingredientName}: reference ${defaultPrice}/${unit}).`,
        );
      }
      unitPrice = line.unitPrice;
      priceSource = "manual";
    }

    return {
      ingredientId: master._id,
      //a correction never renames a line: the original snapshot name is kept
      ingredientName: prev?.ingredientName ?? master.ingredientName,
      quantity: round4(line.quantity),
      unit,
      unitPrice,
      totalCost: round(line.quantity * unitPrice, 2),
      ingredientCode: master.ingredientCode,
      category: master.category,
      catalogUnitPrice,
      priceSource,
      quantityKg: toKilograms(line.quantity, unit),
    };
  });
};

/** Re-derives the stored lines (used when a correction does not touch items). */
const storedItemsAsDraft = (items: TFeedRecordItem[]): TDraftItem[] =>
  items.map((item) => ({
    ingredientId: item.ingredientId,
    ingredientName: item.ingredientName,
    quantity: item.quantity,
    unit: item.unit,
    unitPrice: item.unitPrice,
    totalCost: item.totalCost,
    ingredientCode: "",
    category: "",
    catalogUnitPrice: item.unitPrice,
    priceSource: "snapshot",
    quantityKg: toKilograms(item.quantity, item.unit),
  }));

/**
 * Validates a create body (existing = null) or a correction body (existing = the
 * stored record; omitted fields keep their stored values). Never writes.
 */
const buildDraft = async (
  access: TAccess,
  body: TPayload,
  existing: (TFeedRecord & { _id: Types.ObjectId }) | null,
): Promise<TDraft> => {
  const warnings: string[] = [];
  const blockers: string[] = [];

  //--- animal (immutable on corrections)
  if (existing && "animalId" in body && String(body.animalId) !== String(existing.animalId)) {
    throw new AppError(
      status.BAD_REQUEST,
      "animalId cannot be changed. Delete (void) this record and log the feeding for the right animal.",
    );
  }
  const animal = await findAnimal(access, existing ? String(existing.animalId) : body.animalId);
  const isActiveAnimal = animal.lifeStatus === AnimalLifeStatuses.ACTIVE && animal.isActive;
  if (!isActiveAnimal) {
    if (!existing) {
      //spec §41–42: Sold / Dead / Transferred / Archived animals get no new feeding history
      throw new AppError(
        status.CONFLICT,
        `Animal ${animal.animalCode} is ${animal.lifeStatus} — feeding can only be logged for active animals.`,
      );
    }
    warnings.push(`Animal ${animal.animalCode} is ${animal.lifeStatus}; this is a historical correction.`);
  }
  if (FEEDING_WARNING_HEALTH_STATUSES.includes(animal.healthStatus)) {
    warnings.push(`Animal is ${animal.healthStatus}; follow the veterinarian's feeding advice.`);
  }

  //--- session + date
  const feedingSession = (
    isBlank(body.feedingSession)
      ? existing?.feedingSession ?? parseEnum("feedingSession", body.feedingSession, SESSIONS)
      : parseEnum("feedingSession", body.feedingSession, SESSIONS)
  ) as TFeedingSession;
  let feedingDate: Date;
  if (isBlank(body.feedingDate)) {
    if (!existing) throw new AppError(status.BAD_REQUEST, "feedingDate is required!");
    feedingDate = existing.feedingDate;
  } else {
    feedingDate = parseFeedingDate(body.feedingDate, animal.birthDate ?? null);
  }

  //--- fedBy: an active member of THIS farm (spec §73); defaults to the caller
  let fedBy: Types.ObjectId;
  if (isBlank(body.fedBy)) {
    fedBy = existing?.fedBy ?? requireMemberRow(access);
  } else {
    fedBy = parseObjectId("fedBy", body.fedBy);
    const unchanged = existing && String(existing.fedBy) === String(fedBy);
    if (!unchanged) {
      const member = await FarmMemberModel.exists({ _id: fedBy, farmId: access.farmObjectId, isActive: true });
      if (!member) throw new AppError(status.BAD_REQUEST, "fedBy must be an active member of this farm!");
    }
  }

  //--- recommendation (optional; null / "" unlinks on a correction)
  let recommendationId: Types.ObjectId | null = existing?.recommendationId ?? null;
  let recommendation: Record<string, unknown> | null = null;
  if ("recommendationId" in body) {
    recommendationId = null;
    if (!isBlank(body.recommendationId)) {
      const rec = await findRecommendationRef(access, body.recommendationId);
      if (String(rec.animalId) !== String(animal._id)) {
        throw new AppError(status.BAD_REQUEST, `${rec.recommendationNo} belongs to a different animal!`);
      }
      const keepsSameLink = existing && String(existing.recommendationId) === String(rec._id);
      if (!keepsSameLink && !LINKABLE_RECOMMENDATION_STATUSES.includes(rec.status)) {
        throw new AppError(
          status.CONFLICT,
          `${rec.recommendationNo} is ${rec.status}; only ${LINKABLE_RECOMMENDATION_STATUSES.join(" / ")} plans can be followed.`,
        );
      }
      recommendationId = rec._id as Types.ObjectId;
      recommendation = rec as unknown as Record<string, unknown>;
    }
  } else if (recommendationId) {
    recommendation = (await FeedRecommendationModel.findById(recommendationId)
      .select("recommendationNo status generatedAt estimatedDailyCost totalRecommendedDMI recommendedItems")
      .lean()) as unknown as Record<string, unknown> | null;
  }
  if (recommendation && feedingDate < new Date(dayKey(recommendation.generatedAt as Date))) {
    warnings.push(`This feeding date is before ${String(recommendation.recommendationNo)} was generated.`);
  }

  //--- items
  const items =
    "items" in body || !existing
      ? await buildItems(access, body.items, existing?.items ?? [], warnings)
      : storedItemsAsDraft(existing.items);
  const pieceLines = items.filter((i) => i.quantityKg === null);
  if (pieceLines.length) {
    warnings.push(
      `${pieceLines.map((i) => i.ingredientName).join(", ")} ${pieceLines.length === 1 ? "is" : "are"} counted in pieces and not included in totalFeedQuantity (kg).`,
    );
  }
  const totalFeedQuantity = round(items.reduce((sum, i) => sum + (i.quantityKg ?? 0), 0), 3);
  const totalCost = round(items.reduce((sum, i) => sum + i.totalCost, 0), 2);

  //--- one record per animal / day / session unless explicitly allowed
  const duplicate = await FeedRecordModel.exists({
    farmId: access.farmObjectId,
    animalId: animal._id,
    feedingDate,
    feedingSession,
    isVoided: false,
    ...(existing ? { _id: { $ne: existing._id } } : {}),
  });
  if (duplicate) {
    const message = `A ${feedingSession} feeding is already logged for ${animal.animalCode} on ${dayKey(feedingDate)}.`;
    if (parseBoolean(body.allowDuplicateSession)) warnings.push(message);
    else blockers.push(`${message} Send allowDuplicateSession: true to log an extra feeding.`);
  }

  return {
    animal: {
      _id: animal._id as Types.ObjectId,
      animalCode: animal.animalCode,
      ...(animal.name ? { name: animal.name } : {}),
      lifeStatus: animal.lifeStatus,
      healthStatus: animal.healthStatus,
    },
    feedingSession,
    feedingDate,
    fedBy,
    recommendationId,
    recommendation,
    remarks: "remarks" in body ? parseText("remarks", body.remarks) : existing?.remarks,
    items,
    totalFeedQuantity,
    totalCost,
    warnings,
    blockers,
  };
};

/* -------------------------------------------------------------------------- */
/*                       Inventory planning + reconciliation                  */
/* -------------------------------------------------------------------------- */

//net stock this record has consumed per ingredient, from the ledger (source of truth)
type TLedgerEntry = { inventoryId: Types.ObjectId; consumed: number };

const loadLedger = async (
  farmObjectId: Types.ObjectId,
  recordId: Types.ObjectId,
  session: ClientSession | null = null,
): Promise<Map<string, TLedgerEntry>> => {
  const rows = await InventoryTransactionModel.aggregate<{ _id: Types.ObjectId; consumed: number }>([
    {
      $match: {
        farmId: farmObjectId,
        referenceType: InventoryReferenceTypes.FEED_RECORD,
        referenceId: recordId,
      },
    },
    {
      $group: {
        _id: "$inventoryId",
        consumed: {
          $sum: {
            $switch: {
              branches: [
                { case: { $eq: ["$transactionType", InventoryTransactionTypes.CONSUMPTION] }, then: "$quantity" },
                { case: { $eq: ["$transactionType", InventoryTransactionTypes.RETURN] }, then: { $multiply: ["$quantity", -1] } },
              ],
              default: 0,
            },
          },
        },
      },
    },
  ]).session(session);
  if (rows.length === 0) return new Map();
  const inventories = await InventoryModel.find({ _id: { $in: rows.map((r) => r._id) } })
    .select("referenceId")
    .session(session)
    .lean();
  const ledger = new Map<string, TLedgerEntry>();
  for (const row of rows) {
    const inv = inventories.find((i) => String(i._id) === String(row._id));
    if (!inv?.referenceId) continue;
    ledger.set(String(inv.referenceId), { inventoryId: row._id, consumed: round4(row.consumed) });
  }
  return ledger;
};

type TStockLine = {
  ingredientId: Types.ObjectId;
  ingredientName: string;
  tracked: boolean;
  inventoryId: Types.ObjectId | null;
  inventoryCode: string | null;
  itemName: string | null;
  inventoryStatus: string | null;
  unit: string | null;
  available: number | null;
  //already consumed by this record (corrections / voids) and the new target, in `unit`
  alreadyConsumed: number;
  required: number;
  //> 0 consume more, < 0 return
  delta: number;
  expectedAfter: number | null;
  shortfall: number;
  //price per inventory unit, recorded on the ledger row
  unitPrice: number | null;
};

/**
 * Works out how stock must move so inventory matches the record's items:
 * delta = required (new items) − already consumed (ledger). Creates have no ledger;
 * corrections move only the difference (spec §49); voids return everything.
 * Ingredients the farm does not stock are "untracked" and only produce a warning.
 */
const planStock = async (
  access: TAccess,
  items: TDraftItem[],
  ledger: Map<string, TLedgerEntry>,
  previous: TFeedRecordItem[],
  allowInsufficient: boolean,
  warnings: string[],
  blockers: string[],
): Promise<TStockLine[]> => {
  const keys = new Set([...items.map((i) => String(i.ingredientId)), ...ledger.keys()]);
  const lines: TStockLine[] = [];

  for (const key of keys) {
    const item = items.find((i) => String(i.ingredientId) === key);
    const prev = previous.find((p) => String(p.ingredientId) === key);
    const name = item?.ingredientName ?? prev?.ingredientName ?? "Ingredient";
    const entry = ledger.get(key);
    const inv = entry
      ? await InventoryModel.findById(entry.inventoryId).lean()
      : await findFeedInventory(access.farmObjectId, new Types.ObjectId(key));

    const base: TStockLine = {
      ingredientId: new Types.ObjectId(key),
      ingredientName: name,
      tracked: false,
      inventoryId: null,
      inventoryCode: null,
      itemName: null,
      inventoryStatus: null,
      unit: null,
      available: null,
      alreadyConsumed: entry?.consumed ?? 0,
      required: 0,
      delta: 0,
      expectedAfter: null,
      shortfall: 0,
      unitPrice: null,
    };
    if (!inv) {
      if (item) warnings.push(`${name} is not stocked in this farm's inventory — no stock was deducted.`);
      lines.push(base);
      continue;
    }

    let required = 0;
    if (item) {
      if (unitsCompatible(item.unit, inv.unit)) required = round4(convertQuantity(item.quantity, item.unit, inv.unit));
      else warnings.push(`${name} is fed in ${item.unit} but stocked in ${inv.unit}; stock could not be deducted.`);
    }
    const priced = item ?? prev;
    const delta = round4(required - (entry?.consumed ?? 0));
    const line: TStockLine = {
      ...base,
      tracked: true,
      inventoryId: inv._id as Types.ObjectId,
      inventoryCode: inv.inventoryCode,
      itemName: inv.itemName,
      inventoryStatus: inv.status,
      unit: inv.unit,
      available: inv.currentStock,
      required,
      delta,
      expectedAfter: round4(Math.max(0, inv.currentStock - delta)),
      unitPrice: priced && unitsCompatible(priced.unit, inv.unit) ? priceIn(priced.unitPrice, priced.unit, inv.unit) : null,
    };

    if (delta > 0) {
      if (isUnusableInventory(inv)) {
        blockers.push(`${inv.itemName} (${inv.inventoryCode}) is ${inv.status === "Inactive" ? "inactive" : "expired"} and cannot be used for feeding.`);
      } else if (inv.currentStock < delta) {
        line.shortfall = round4(delta - inv.currentStock);
        const message = `Insufficient stock for ${inv.itemName}: ${inv.currentStock} ${inv.unit} available, ${delta} ${inv.unit} needed.`;
        if (allowInsufficient) warnings.push(`${message} Stock is drawn down to 0 (authorized override).`);
        else blockers.push(message);
      }
    }
    lines.push(line);
  }
  return lines;
};

type TMovement = {
  transactionNo: string;
  transactionType: string;
  inventoryCode: string | null;
  itemName: string | null;
  quantity: number;
  unit: string | null;
  stockBefore: number;
  stockAfter: number;
};

/** Applies the planned deltas and writes one ledger row per movement. */
const applyPlan = async (
  access: TAccess,
  recordId: Types.ObjectId,
  plan: TStockLine[],
  options: {
    session: ClientSession | null;
    undo: TUndo;
    memberId: Types.ObjectId;
    allowInsufficient: boolean;
    remarks: string;
    warnings: string[];
  },
): Promise<TMovement[]> => {
  const movements: TMovement[] = [];
  for (const line of plan) {
    if (!line.tracked || !line.inventoryId || line.delta === 0) continue;
    const consuming = line.delta > 0;
    const change = await applyStockChange(line.inventoryId, -line.delta, {
      session: options.session,
      capAtZero: consuming && options.allowInsufficient,
      updatedBy: options.memberId,
    });
    if (!change) {
      //stock changed between planning and writing (another feeding / usage)
      throw new AppError(
        status.CONFLICT,
        `Stock of ${line.itemName} changed while saving and is no longer sufficient. Reload and try again.`,
      );
    }
    if (change.applied === 0) {
      options.warnings.push(`${line.itemName} had no stock left; nothing was deducted.`);
      continue;
    }
    const inventoryId = line.inventoryId;
    const applied = change.applied;
    options.undo.push(() =>
      applyStockChange(inventoryId, consuming ? applied : -applied, { session: null, capAtZero: true }),
    );

    const transactionType = consuming ? InventoryTransactionTypes.CONSUMPTION : InventoryTransactionTypes.RETURN;
    const transactionNo = await generateTransactionNo();
    const [trx] = await InventoryTransactionModel.create(
      [
        {
          transactionNo,
          farmId: access.farmObjectId,
          inventoryId,
          transactionType,
          transactionDate: new Date(),
          quantity: applied,
          ...(line.unit ? { unit: line.unit as TInventoryUnit } : {}),
          ...(line.unitPrice !== null
            ? { unitPrice: line.unitPrice, totalAmount: round(applied * line.unitPrice, 2) }
            : {}),
          referenceType: InventoryReferenceTypes.FEED_RECORD,
          referenceId: recordId,
          remarks: options.remarks,
          performedBy: options.memberId,
        },
      ],
      sessionOpts(options.session),
    );
    if (trx) options.undo.push(() => InventoryTransactionModel.deleteOne({ _id: trx._id }));
    movements.push({
      transactionNo,
      transactionType,
      inventoryCode: line.inventoryCode,
      itemName: line.itemName,
      quantity: applied,
      unit: line.unit,
      stockBefore: change.before,
      stockAfter: change.after,
    });
  }
  return movements;
};

/* -------------------------------------------------------------------------- */
/*                                Read helpers                                */
/* -------------------------------------------------------------------------- */

const MEMBER_POPULATE = { select: "role userId", populate: { path: "userId", select: "userId fullName" } };

const populateRecord = <T>(query: T, detail = false): T => {
  const q = query as unknown as mongoose.Query<unknown, unknown>;
  return q
    .populate("animalId", detail ? "animalCode name gender lifeStatus healthStatus profilePhoto" : "animalCode name")
    .populate({ path: "fedBy", ...MEMBER_POPULATE })
    .populate({ path: "voidedBy", ...MEMBER_POPULATE })
    .populate(
      "recommendationId",
      detail
        ? "recommendationNo status generatedAt estimatedDailyCost totalRecommendedDMI recommendedItems"
        : "recommendationNo status",
    ) as unknown as T;
};

const findRecord = async (access: TAccess, ref: string) => {
  const value = String(ref ?? "").trim();
  if (!isValidObjectId(value)) throw new AppError(status.BAD_REQUEST, "Invalid feed record id!");
  const doc = await FeedRecordModel.findOne({ _id: new Types.ObjectId(value), farmId: access.farmObjectId }).lean();
  if (!doc) throw new AppError(status.NOT_FOUND, "Feed record not found!");
  return doc as TFeedRecord & { _id: Types.ObjectId; updatedAt: Date };
};

const ledgerRows = (farmObjectId: Types.ObjectId, recordId: Types.ObjectId) =>
  InventoryTransactionModel.find({
    farmId: farmObjectId,
    referenceType: InventoryReferenceTypes.FEED_RECORD,
    referenceId: recordId,
  })
    .sort({ createdAt: 1 })
    .select("transactionNo transactionType transactionDate quantity unit unitPrice totalAmount remarks inventoryId performedBy createdAt")
    .populate("inventoryId", "inventoryCode itemName unit currentStock status")
    .populate({ path: "performedBy", ...MEMBER_POPULATE })
    .lean();

const loadDetail = async (access: TAccess, id: Types.ObjectId) => {
  const [record, inventoryTransactions] = await Promise.all([
    populateRecord(FeedRecordModel.findById(id).select("-__v"), true).lean(),
    ledgerRows(access.farmObjectId, id),
  ]);
  return { ...(record as Record<string, unknown>), inventoryTransactions };
};

const auditSnapshot = (record: Partial<TFeedRecord> & { _id?: unknown }) => ({
  animalId: record.animalId,
  recommendationId: record.recommendationId ?? null,
  feedingSession: record.feedingSession,
  feedingDate: record.feedingDate,
  items: (record.items ?? []).map((i) => ({
    ingredientId: i.ingredientId,
    ingredientName: i.ingredientName,
    quantity: i.quantity,
    unit: i.unit,
    unitPrice: i.unitPrice,
    totalCost: i.totalCost,
  })),
  totalFeedQuantity: record.totalFeedQuantity,
  totalCost: record.totalCost,
  remarks: record.remarks ?? null,
  fedBy: record.fedBy,
  isVoided: record.isVoided ?? false,
});

const audit = (
  context: TAuditContext,
  farmId: Types.ObjectId,
  entityId: Types.ObjectId,
  action: TAuditAction,
  event: string,
  oldData: Record<string, unknown> | null,
  newData: Record<string, unknown> | null,
  changedFields: string[] = [],
) =>
  recordAuditLog({
    context,
    farmId,
    entityType: AuditEntityTypes.FEED_RECORD,
    entityId,
    action,
    module: AuditModules.FEED,
    event,
    oldData,
    newData,
    changedFields,
  });

const itemsSignature = (items: Pick<TFeedRecordItem, "ingredientId" | "quantity" | "unit" | "unitPrice">[]) =>
  JSON.stringify(
    items
      .map((i) => [String(i.ingredientId), round4(i.quantity), i.unit, round4(i.unitPrice)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );

//public preview shape of a draft (never persisted)
const draftView = (draft: TDraft) => ({
  animal: draft.animal,
  feedingSession: draft.feedingSession,
  feedingDate: draft.feedingDate,
  fedBy: draft.fedBy,
  recommendationId: draft.recommendationId,
  recommendation: draft.recommendation
    ? {
        _id: draft.recommendation._id,
        recommendationNo: draft.recommendation.recommendationNo,
        status: draft.recommendation.status,
        estimatedDailyCost: draft.recommendation.estimatedDailyCost,
      }
    : null,
  remarks: draft.remarks ?? null,
  items: draft.items,
  totalFeedQuantity: draft.totalFeedQuantity,
  totalCost: draft.totalCost,
});

const throwIfBlocked = (blockers: string[]) => {
  if (blockers.length) {
    throw new AppError(status.UNPROCESSABLE_ENTITY, `Feed record cannot be saved: ${blockers.join(" ")}`);
  }
};

/* -------------------------------------------------------------------------- */
/*                                   Writes                                   */
/* -------------------------------------------------------------------------- */

const wantsOverride = (access: TAccess, body: TPayload) => {
  const requested = parseBoolean(body.allowInsufficientStock);
  if (requested && !can(access, FeedRecordPermissions.OVERRIDE_STOCK)) {
    throw new AppError(status.FORBIDDEN, "Only an Owner or Manager can log feeding with insufficient stock!");
  }
  return requested;
};

/** POST /preview — validates and prices a feeding + stock check. Nothing is written. */
const previewFeedRecord = async (farmId: string, requesterUserId: string, payload: TPayload) => {
  const body = payload ?? {};
  rejectServerFields(body);
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, FeedRecordPermissions.CREATE, "log feeding");
  const allowInsufficient = wantsOverride(access, body);
  const draft = await buildDraft(access, body, null);
  const stock = await planStock(access, draft.items, new Map(), [], allowInsufficient, draft.warnings, draft.blockers);
  return {
    ...draftView(draft),
    stock,
    warnings: draft.warnings,
    blockers: draft.blockers,
    canSave: draft.blockers.length === 0 && access.farmStatus === FarmStatuses.ACTIVE,
    isPreview: true,
  };
};

/**
 * POST / — logs an actual feeding. In ONE transaction: create the FeedRecord, deduct
 * Inventory.currentStock for every stocked ingredient and insert matching
 * Consumption rows (referenceType FeedRecord). Any failure rolls everything back.
 */
const createFeedRecord = async (farmId: string, requesterUserId: string, payload: TPayload, context: TAuditContext) => {
  const body = payload ?? {};
  rejectServerFields(body);
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, FeedRecordPermissions.CREATE, "log feeding");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);
  const allowInsufficient = wantsOverride(access, body);

  const draft = await buildDraft(access, body, null);
  const plan = await planStock(access, draft.items, new Map(), [], allowInsufficient, draft.warnings, draft.blockers);
  throwIfBlocked(draft.blockers);

  const data: TFeedRecord = {
    farmId: access.farmObjectId,
    animalId: draft.animal._id,
    recommendationId: draft.recommendationId,
    feedingSession: draft.feedingSession,
    feedingDate: draft.feedingDate,
    //persist only the schema fields of each line
    items: draft.items.map(({ ingredientId, ingredientName, quantity, unit, unitPrice, totalCost }) => ({
      ingredientId,
      ingredientName,
      quantity,
      unit,
      unitPrice,
      totalCost,
    })),
    totalFeedQuantity: draft.totalFeedQuantity,
    totalCost: draft.totalCost,
    ...(draft.remarks ? { remarks: draft.remarks } : {}),
    fedBy: draft.fedBy,
    isVoided: false,
  };

  const { record, movements } = await executeAtomically(async (session, undo) => {
    const [doc] = await FeedRecordModel.create([data], sessionOpts(session));
    if (!doc) throw new AppError(status.INTERNAL_SERVER_ERROR, "Failed to save the feed record!");
    undo.push(() => FeedRecordModel.deleteOne({ _id: doc._id }));
    const moved = await applyPlan(access, doc._id, plan, {
      session,
      undo,
      memberId,
      allowInsufficient,
      remarks: `Feeding ${draft.animal.animalCode} — ${draft.feedingSession} ${dayKey(draft.feedingDate)}`,
      warnings: draft.warnings,
    });
    return { record: doc, movements: moved };
  });

  await audit(context, access.farmObjectId, record._id, AuditActions.CREATE, "FeedRecord Created", null, {
    ...auditSnapshot(data),
    inventory: movements,
  });

  return { feedRecord: await loadDetail(access, record._id), stockMovements: movements, warnings: draft.warnings };
};

/**
 * PUT /:id — controlled correction (Owner / Manager). Items, quantities, price,
 * session, date, fedBy, remarks and the linked plan may change; the animal never does.
 * Inventory moves only by the net difference per ingredient (spec §49), and the
 * change is audited with oldData / newData / changedFields.
 */
const updateFeedRecord = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  rejectServerFields(body);
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, FeedRecordPermissions.UPDATE, "correct feed records");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);
  const allowInsufficient = wantsOverride(access, body);
  const reason = parseText("reason", body.reason);

  const doc = await findRecord(access, id);
  if (doc.isVoided) throw new AppError(status.CONFLICT, "This feed record was voided and can no longer be corrected!");

  const draft = await buildDraft(access, body, doc);
  const ledger = await loadLedger(access.farmObjectId, doc._id);
  const plan = await planStock(access, draft.items, ledger, doc.items, allowInsufficient, draft.warnings, draft.blockers);
  throwIfBlocked(draft.blockers);

  const nextItems = draft.items.map(({ ingredientId, ingredientName, quantity, unit, unitPrice, totalCost }) => ({
    ingredientId,
    ingredientName,
    quantity,
    unit,
    unitPrice,
    totalCost,
  }));
  const changedFields: string[] = [];
  if (draft.feedingSession !== doc.feedingSession) changedFields.push("feedingSession");
  if (draft.feedingDate.getTime() !== new Date(doc.feedingDate).getTime()) changedFields.push("feedingDate");
  if (String(draft.fedBy) !== String(doc.fedBy)) changedFields.push("fedBy");
  if (String(draft.recommendationId ?? "") !== String(doc.recommendationId ?? "")) changedFields.push("recommendationId");
  if ((draft.remarks ?? "") !== (doc.remarks ?? "")) changedFields.push("remarks");
  if (itemsSignature(nextItems) !== itemsSignature(doc.items)) changedFields.push("items", "totalFeedQuantity", "totalCost");
  const stockDrift = plan.some((l) => l.tracked && l.delta !== 0);

  if (changedFields.length === 0 && !stockDrift) {
    return { mode: "unchanged", feedRecord: await loadDetail(access, doc._id), stockMovements: [], warnings: draft.warnings };
  }

  const set: Record<string, unknown> = {
    feedingSession: draft.feedingSession,
    feedingDate: draft.feedingDate,
    fedBy: draft.fedBy,
    recommendationId: draft.recommendationId,
    items: nextItems,
    totalFeedQuantity: draft.totalFeedQuantity,
    totalCost: draft.totalCost,
  };
  const unset: Record<string, 1> = {};
  if (draft.remarks) set.remarks = draft.remarks;
  else unset.remarks = 1;

  const movements = await executeAtomically(async (session, undo) => {
    //optimistic guard: nobody else corrected / voided it since it was read
    const updated = await FeedRecordModel.updateOne(
      { _id: doc._id, updatedAt: doc.updatedAt, isVoided: false },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      sessionOpts(session),
    );
    if (updated.modifiedCount !== 1) {
      throw new AppError(status.CONFLICT, "The feed record was changed by someone else; reload and try again.");
    }
    undo.push(() =>
      FeedRecordModel.updateOne(
        { _id: doc._id },
        {
          $set: {
            feedingSession: doc.feedingSession,
            feedingDate: doc.feedingDate,
            fedBy: doc.fedBy,
            recommendationId: doc.recommendationId ?? null,
            items: doc.items,
            totalFeedQuantity: doc.totalFeedQuantity,
            totalCost: doc.totalCost,
            ...(doc.remarks ? { remarks: doc.remarks } : {}),
          },
        },
      ),
    );
    return applyPlan(access, doc._id, plan, {
      session,
      undo,
      memberId,
      allowInsufficient,
      remarks: `Correction of feeding ${draft.animal.animalCode} — ${draft.feedingSession} ${dayKey(draft.feedingDate)}${reason ? `: ${reason}` : ""}`,
      warnings: draft.warnings,
    });
  });

  const after = { ...doc, ...set, remarks: draft.remarks } as TFeedRecord;
  await audit(
    context,
    access.farmObjectId,
    doc._id,
    AuditActions.UPDATE,
    movements.length ? "FeedRecord Corrected + Inventory Reconciled" : "FeedRecord Corrected",
    auditSnapshot(doc),
    { ...auditSnapshot(after), ...(reason ? { reason } : {}), inventory: movements },
    changedFields,
  );

  return { mode: "updated", feedRecord: await loadDetail(access, doc._id), stockMovements: movements, warnings: draft.warnings };
};

/**
 * DELETE /:id — Owner. Never a silent hard delete: in one transaction the record is
 * marked voided, every unit it consumed is returned to Inventory with a compensating
 * Return row, and a Delete audit entry keeps the full oldData.
 */
const voidFeedRecord = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, FeedRecordPermissions.DELETE, "delete feed records");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);
  const reason = parseText("reason", body.reason);

  const doc = await findRecord(access, id);
  if (doc.isVoided) throw new AppError(status.CONFLICT, "This feed record is already voided!");

  const warnings: string[] = [];
  const ledger = await loadLedger(access.farmObjectId, doc._id);
  const plan = await planStock(access, [], ledger, doc.items, true, warnings, []);

  const voidedAt = new Date();
  const movements = await executeAtomically(async (session, undo) => {
    const updated = await FeedRecordModel.updateOne(
      { _id: doc._id, updatedAt: doc.updatedAt, isVoided: false },
      { $set: { isVoided: true, voidedAt, voidedBy: memberId, ...(reason ? { voidReason: reason } : {}) } },
      sessionOpts(session),
    );
    if (updated.modifiedCount !== 1) {
      throw new AppError(status.CONFLICT, "The feed record was changed by someone else; reload and try again.");
    }
    undo.push(() =>
      FeedRecordModel.updateOne(
        { _id: doc._id },
        { $set: { isVoided: false, voidedAt: null, voidedBy: null }, $unset: { voidReason: 1 } },
      ),
    );
    return applyPlan(access, doc._id, plan, {
      session,
      undo,
      memberId,
      allowInsufficient: true,
      remarks: `Reversal of voided feed record${reason ? `: ${reason}` : ""}`,
      warnings,
    });
  });

  await audit(
    context,
    access.farmObjectId,
    doc._id,
    AuditActions.DELETE,
    "FeedRecord Voided",
    auditSnapshot(doc),
    { isVoided: true, voidedAt, ...(reason ? { voidReason: reason } : {}), inventory: movements },
    ["isVoided", "voidedAt", "voidedBy", ...(reason ? ["voidReason"] : [])],
  );

  return { _id: doc._id, isVoided: true, voidedAt, stockMovements: movements, warnings };
};

/* -------------------------------------------------------------------------- */
/*                                    Reads                                   */
/* -------------------------------------------------------------------------- */

const LIST_SORT_FIELDS = new Set(["feedingDate", "createdAt", "totalCost", "totalFeedQuantity", "feedingSession"]);

const parseSort = (value: unknown): Record<string, 1 | -1> => {
  if (isBlank(value)) return { feedingDate: -1, createdAt: -1, _id: -1 };
  const sort: Record<string, 1 | -1> = {};
  for (const raw of String(value).split(",")) {
    const key = raw.trim();
    const field = key.replace(/^-/, "");
    if (!LIST_SORT_FIELDS.has(field)) throw new AppError(status.BAD_REQUEST, `Cannot sort by "${field}"!`);
    sort[field] = key.startsWith("-") ? -1 : 1;
  }
  sort._id = -1;
  return sort;
};

//voided rows are hidden unless an Owner / Manager asks for them
const voidFilter = (access: TAccess, query: TPayload) => {
  const mode = String(query.voided ?? (parseBoolean(query.includeVoided) ? "include" : "exclude"));
  if (mode === "exclude" || !can(access, FeedRecordPermissions.AUDIT)) return { isVoided: false };
  if (mode === "only") return { isVoided: true };
  return {};
};

const buildListFilter = async (access: TAccess, query: TPayload) => {
  const filter: Record<string, unknown> = { farmId: access.farmObjectId, ...voidFilter(access, query) };
  if (!isBlank(query.animalId)) filter.animalId = (await findAnimal(access, query.animalId))._id;
  if (!isBlank(query.feedingSession)) {
    const values = parseEnumList("feedingSession", query.feedingSession, SESSIONS);
    filter.feedingSession = values.length === 1 ? values[0] : { $in: values };
  }
  if (!isBlank(query.recommendationId)) {
    filter.recommendationId =
      String(query.recommendationId) === "none" ? null : (await findRecommendationRef(access, query.recommendationId))._id;
  }
  if (!isBlank(query.fedBy)) filter.fedBy = parseObjectId("fedBy", query.fedBy);
  if (!isBlank(query.ingredientId)) filter["items.ingredientId"] = parseObjectId("ingredientId", query.ingredientId);
  Object.assign(filter, parseDateRange(query));
  if (!isBlank(query.searchTerm)) {
    const term = { $regex: escapeRegex(String(query.searchTerm).trim().slice(0, 100)), $options: "i" };
    filter.$or = [{ remarks: term }, { "items.ingredientName": term }];
  }
  return filter;
};

/** GET / — farm-wide feeding events with filters + pagination. */
const getFarmFeedRecords = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const filter = await buildListFilter(access, query);
  const { page, limit, skip } = parsePaging(query, MAX_LIST_LIMIT);
  const [total, data, totals] = await Promise.all([
    FeedRecordModel.countDocuments(filter),
    populateRecord(FeedRecordModel.find(filter).sort(parseSort(query.sort)).skip(skip).limit(limit).select("-__v")).lean(),
    FeedRecordModel.aggregate([
      { $match: filter },
      { $group: { _id: null, totalCost: { $sum: "$totalCost" }, totalFeedQuantity: { $sum: "$totalFeedQuantity" } } },
    ]),
  ]);
  return {
    meta: pageMeta(page, limit, total),
    data: {
      records: data,
      //totals of the whole filtered set, not only this page
      summary: {
        records: total,
        totalCost: round(totals[0]?.totalCost ?? 0, 2),
        totalFeedQuantity: round(totals[0]?.totalFeedQuantity ?? 0, 3),
      },
    },
  };
};

//a date window (default: the last DEFAULT_SUMMARY_DAYS days, capped at MAX_SUMMARY_DAYS)
const summaryWindow = (query: TPayload) => {
  const range = parseDateRange(query).feedingDate as { $gte?: Date; $lte?: Date } | undefined;
  const to = range?.$lte ?? new Date(new Date(dayKey(new Date())).getTime() + DAY_MS - 1);
  const from = range?.$gte ?? new Date(to.getTime() - DEFAULT_SUMMARY_DAYS * DAY_MS + 1);
  if (to.getTime() - from.getTime() > MAX_SUMMARY_DAYS * DAY_MS) {
    throw new AppError(status.BAD_REQUEST, `The date range cannot exceed ${MAX_SUMMARY_DAYS} days!`);
  }
  return { from, to };
};

/**
 * GET /animals/:animalId/feed-records — chronological history of one animal plus
 * daily summaries (all sessions of a day added up), ingredient totals and the active
 * plan for a quick recommended-vs-actual comparison.
 */
const getAnimalFeedRecords = async (farmId: string, animalRef: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const animal = await findAnimal(access, animalRef);
  const { from, to } = summaryWindow(query);
  const base = { farmId: access.farmObjectId, animalId: animal._id, isVoided: false };
  const windowMatch = { ...base, feedingDate: { $gte: from, $lte: to } };

  const listFilter: Record<string, unknown> = { ...windowMatch };
  if (!isBlank(query.feedingSession)) {
    listFilter.feedingSession = { $in: parseEnumList("feedingSession", query.feedingSession, SESSIONS) };
  }
  const { page, limit, skip } = parsePaging(query, MAX_LIST_LIMIT, 20);

  const [total, records, daily, ingredients, activeRecommendation, lastFeeding] = await Promise.all([
    FeedRecordModel.countDocuments(listFilter),
    populateRecord(
      FeedRecordModel.find(listFilter).sort({ feedingDate: -1, createdAt: -1 }).skip(skip).limit(limit).select("-__v"),
    ).lean(),
    FeedRecordModel.aggregate<{
      _id: Date;
      records: number;
      sessions: string[];
      totalFeedQuantity: number;
      totalCost: number;
    }>([
      { $match: windowMatch },
      {
        $group: {
          _id: "$feedingDate",
          records: { $sum: 1 },
          sessions: { $push: "$feedingSession" },
          totalFeedQuantity: { $sum: "$totalFeedQuantity" },
          totalCost: { $sum: "$totalCost" },
        },
      },
      { $sort: { _id: -1 } },
    ]),
    FeedRecordModel.aggregate<{ _id: { ingredientId: Types.ObjectId; unit: string }; ingredientName: string; quantity: number; totalCost: number }>([
      { $match: windowMatch },
      { $unwind: "$items" },
      {
        $group: {
          _id: { ingredientId: "$items.ingredientId", unit: "$items.unit" },
          ingredientName: { $last: "$items.ingredientName" },
          quantity: { $sum: "$items.quantity" },
          totalCost: { $sum: "$items.totalCost" },
        },
      },
      { $sort: { totalCost: -1 } },
    ]),
    FeedRecommendationModel.findOne({
      farmId: access.farmObjectId,
      animalId: animal._id,
      status: { $in: ACTIVE_RECOMMENDATION_STATUSES },
    })
      .sort({ generatedAt: -1 })
      .select("recommendationNo status generatedAt estimatedDailyCost totalRecommendedDMI recommendedItems")
      .lean(),
    FeedRecordModel.findOne(base).sort({ feedingDate: -1, createdAt: -1 }).select("feedingDate feedingSession totalCost").lean(),
  ]);

  const days = daily.length;
  const windowCost = daily.reduce((s, d) => s + d.totalCost, 0);
  const windowQty = daily.reduce((s, d) => s + d.totalFeedQuantity, 0);

  return {
    meta: pageMeta(page, limit, total),
    data: {
      animal: { _id: animal._id, animalCode: animal.animalCode, name: animal.name, lifeStatus: animal.lifeStatus, healthStatus: animal.healthStatus },
      window: { from, to },
      summary: {
        daysFed: days,
        records: daily.reduce((s, d) => s + d.records, 0),
        totalCost: round(windowCost, 2),
        totalFeedQuantity: round(windowQty, 3),
        avgDailyCost: days ? round(windowCost / days, 2) : 0,
        avgDailyFeedQuantity: days ? round(windowQty / days, 3) : 0,
        lastFeeding: lastFeeding ?? null,
      },
      dailySummaries: daily.map((d) => ({
        date: d._id,
        records: d.records,
        sessions: [...d.sessions].sort((a, b) => (FEEDING_SESSION_ORDER[a] ?? 9) - (FEEDING_SESSION_ORDER[b] ?? 9)),
        totalFeedQuantity: round(d.totalFeedQuantity, 3),
        totalCost: round(d.totalCost, 2),
        //vs the current active plan's estimated daily cost
        costVariance: activeRecommendation ? round(d.totalCost - activeRecommendation.estimatedDailyCost, 2) : null,
      })),
      ingredientTotals: ingredients.map((i) => ({
        ingredientId: i._id.ingredientId,
        ingredientName: i.ingredientName,
        unit: i._id.unit,
        quantity: round(i.quantity, 3),
        totalCost: round(i.totalCost, 2),
      })),
      activeRecommendation: activeRecommendation ?? null,
      records,
    },
  };
};

/** GET /:id — one feeding event with animal, fedBy, linked plan and its stock ledger. */
const getFeedRecord = async (farmId: string, id: string, requesterUserId: string) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const doc = await findRecord(access, id);
  return loadDetail(access, doc._id);
};

/**
 * GET /adherence/:recommendationId — Recommended vs Actual (spec §37, §53).
 * A recommendation is a DAILY plan, so linked records are added up per feeding day
 * and the average actual day is compared with the plan, per ingredient and in cost.
 */
const getAdherence = async (farmId: string, recommendationRef: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const rec = await findRecommendationRef(access, recommendationRef);
  const filter = {
    farmId: access.farmObjectId,
    recommendationId: rec._id,
    isVoided: false,
    ...parseDateRange(query),
  };
  const records = await FeedRecordModel.find(filter)
    .sort({ feedingDate: 1 })
    .select("feedingDate feedingSession items totalCost totalFeedQuantity")
    .limit(5000)
    .lean();
  const animal = await AnimalModel.findById(rec.animalId).select("animalCode name").lean();

  const dayKeys = [...new Set(records.map((r) => dayKey(r.feedingDate)))];
  const days = dayKeys.length;
  const recommended = rec.recommendedItems ?? [];

  //actual quantity per ingredient, converted to the plan's unit where possible
  type TActual = { ingredientName: string; unit: string; quantity: number; cost: number; convertible: boolean };
  const actualOf = new Map<string, TActual>();
  for (const record of records) {
    for (const item of record.items) {
      const key = String(item.ingredientId);
      const planned = recommended.find((r) => String(r.ingredientId) === key);
      const targetUnit = planned?.unit ?? item.unit;
      const convertible = unitsCompatible(item.unit, targetUnit);
      const entry = actualOf.get(key) ?? { ingredientName: item.ingredientName, unit: targetUnit, quantity: 0, cost: 0, convertible: true };
      entry.quantity += convertible ? convertQuantity(item.quantity, item.unit, targetUnit) : 0;
      entry.cost += item.totalCost;
      entry.convertible &&= convertible;
      actualOf.set(key, entry);
    }
  }

  const band = (pct: number | null) =>
    pct === null ? "Not fed" : Math.abs(pct) <= ADHERENCE_TOLERANCE_PERCENT ? "On plan" : pct < 0 ? "Under-fed" : "Over-fed";

  const ingredients = recommended.map((planned) => {
    const actual = actualOf.get(String(planned.ingredientId));
    const avgDaily = actual && days ? actual.quantity / days : 0;
    const variance = avgDaily - planned.quantity;
    const variancePercent = planned.quantity > 0 ? round((variance / planned.quantity) * 100, 2) : null;
    return {
      ingredientId: planned.ingredientId,
      ingredientName: planned.ingredientName,
      unit: planned.unit,
      recommendedDailyQuantity: planned.quantity,
      recommendedDailyCost: planned.estimatedCost,
      actualTotalQuantity: round(actual?.quantity ?? 0, 3),
      actualAvgDailyQuantity: round(avgDaily, 3),
      actualAvgDailyCost: actual && days ? round(actual.cost / days, 2) : 0,
      varianceQuantity: round(variance, 3),
      variancePercent: actual ? variancePercent : days ? -100 : null,
      status: !days ? "No data" : actual ? band(variancePercent) : "Not fed",
    };
  });
  //fed although the plan does not contain them
  const extraIngredients = [...actualOf.entries()]
    .filter(([key]) => !recommended.some((r) => String(r.ingredientId) === key))
    .map(([key, a]) => ({
      ingredientId: key,
      ingredientName: a.ingredientName,
      unit: a.unit,
      actualTotalQuantity: round(a.quantity, 3),
      actualAvgDailyQuantity: days ? round(a.quantity / days, 3) : 0,
      actualAvgDailyCost: days ? round(a.cost / days, 2) : 0,
    }));

  const daily = dayKeys.map((key) => {
    const dayRecords = records.filter((r) => dayKey(r.feedingDate) === key);
    const cost = dayRecords.reduce((s, r) => s + r.totalCost, 0);
    const qty = dayRecords.reduce((s, r) => s + r.totalFeedQuantity, 0);
    return {
      date: key,
      sessions: dayRecords.map((r) => r.feedingSession),
      totalFeedQuantity: round(qty, 3),
      totalCost: round(cost, 2),
      costVariance: round(cost - rec.estimatedDailyCost, 2),
    };
  });

  const recommendedKg = recommended.reduce((s, r) => s + (toKilograms(r.quantity, r.unit) ?? 0), 0);
  const actualTotalCost = records.reduce((s, r) => s + r.totalCost, 0);
  const actualTotalKg = records.reduce((s, r) => s + r.totalFeedQuantity, 0);
  const avgDailyKg = days ? actualTotalKg / days : 0;
  const avgDailyCost = days ? actualTotalCost / days : 0;
  const quantityAdherencePercent = recommendedKg > 0 && days ? round((avgDailyKg / recommendedKg) * 100, 1) : null;

  return {
    recommendation: {
      _id: rec._id,
      recommendationNo: rec.recommendationNo,
      status: rec.status,
      generatedAt: rec.generatedAt,
      estimatedDailyCost: rec.estimatedDailyCost,
      totalRecommendedDMI: rec.totalRecommendedDMI,
      recommendedDailyQuantityKg: round(recommendedKg, 3),
    },
    animal,
    period: {
      from: daily[0]?.date ?? null,
      to: daily[daily.length - 1]?.date ?? null,
      daysLogged: days,
      records: records.length,
    },
    summary: {
      actualAvgDailyQuantityKg: round(avgDailyKg, 3),
      quantityVarianceKg: days ? round(avgDailyKg - recommendedKg, 3) : null,
      quantityAdherencePercent,
      actualTotalCost: round(actualTotalCost, 2),
      actualAvgDailyCost: round(avgDailyCost, 2),
      estimatedTotalCost: round(rec.estimatedDailyCost * days, 2),
      //positive = spent more than planned
      costVariance: days ? round(avgDailyCost - rec.estimatedDailyCost, 2) : null,
      costVariancePercent:
        days && rec.estimatedDailyCost > 0 ? round(((avgDailyCost - rec.estimatedDailyCost) / rec.estimatedDailyCost) * 100, 2) : null,
      status:
        quantityAdherencePercent === null
          ? "No data"
          : band(round(quantityAdherencePercent - 100, 2)),
      tolerancePercent: ADHERENCE_TOLERANCE_PERCENT,
    },
    ingredients,
    extraIngredients,
    daily,
  };
};

/** GET /stats — farm dashboard numbers for a date window (default last 30 days). */
const getStats = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const { from, to } = summaryWindow(query);
  const match = { farmId: access.farmObjectId, isVoided: false, feedingDate: { $gte: from, $lte: to } };
  const today = new Date(dayKey(new Date()));

  const [totals, bySession, topIngredients, trend, todayRows, voided, linked] = await Promise.all([
    FeedRecordModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          records: { $sum: 1 },
          totalCost: { $sum: "$totalCost" },
          totalFeedQuantity: { $sum: "$totalFeedQuantity" },
          animals: { $addToSet: "$animalId" },
        },
      },
    ]),
    FeedRecordModel.aggregate([
      { $match: match },
      { $group: { _id: "$feedingSession", records: { $sum: 1 }, totalCost: { $sum: "$totalCost" } } },
    ]),
    FeedRecordModel.aggregate([
      { $match: match },
      { $unwind: "$items" },
      {
        $group: {
          _id: { ingredientId: "$items.ingredientId", unit: "$items.unit" },
          ingredientName: { $last: "$items.ingredientName" },
          quantity: { $sum: "$items.quantity" },
          totalCost: { $sum: "$items.totalCost" },
        },
      },
      { $sort: { totalCost: -1 } },
      { $limit: 5 },
    ]),
    FeedRecordModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$feedingDate",
          records: { $sum: 1 },
          totalCost: { $sum: "$totalCost" },
          totalFeedQuantity: { $sum: "$totalFeedQuantity" },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    FeedRecordModel.aggregate([
      { $match: { farmId: access.farmObjectId, isVoided: false, feedingDate: today } },
      { $group: { _id: null, records: { $sum: 1 }, totalCost: { $sum: "$totalCost" }, animals: { $addToSet: "$animalId" } } },
    ]),
    can(access, FeedRecordPermissions.AUDIT)
      ? FeedRecordModel.countDocuments({ farmId: access.farmObjectId, isVoided: true, feedingDate: { $gte: from, $lte: to } })
      : Promise.resolve(null),
    FeedRecordModel.countDocuments({ ...match, recommendationId: { $ne: null } }),
  ]);
  const t = totals[0];
  const days = trend.length;
  return {
    window: { from, to },
    records: t?.records ?? 0,
    animalsFed: t?.animals?.length ?? 0,
    totalCost: round(t?.totalCost ?? 0, 2),
    totalFeedQuantity: round(t?.totalFeedQuantity ?? 0, 3),
    avgDailyCost: days ? round((t?.totalCost ?? 0) / days, 2) : 0,
    linkedToPlan: linked,
    voided,
    today: {
      records: todayRows[0]?.records ?? 0,
      animalsFed: todayRows[0]?.animals?.length ?? 0,
      totalCost: round(todayRows[0]?.totalCost ?? 0, 2),
    },
    bySession: Object.fromEntries(
      SESSIONS.map((s) => {
        const row = bySession.find((b) => b._id === s);
        return [s, { records: row?.records ?? 0, totalCost: round(row?.totalCost ?? 0, 2) }];
      }),
    ),
    topIngredients: topIngredients.map((i) => ({
      ingredientId: i._id.ingredientId,
      ingredientName: i.ingredientName,
      unit: i._id.unit,
      quantity: round(i.quantity, 3),
      totalCost: round(i.totalCost, 2),
    })),
    dailyTrend: trend.map((d) => ({
      date: d._id,
      records: d.records,
      totalCost: round(d.totalCost, 2),
      totalFeedQuantity: round(d.totalFeedQuantity, 3),
    })),
  };
};

/** GET /meta — enums, limits and permissions for forms and filters. */
const getMeta = () => ({
  feedingSessions: SESSIONS,
  units: UNITS,
  permissions: FeedRecordPermissions,
  linkableRecommendationStatuses: LINKABLE_RECOMMENDATION_STATUSES,
  limits: {
    maxItems: MAX_ITEMS_PER_RECORD,
    maxItemQuantity: MAX_ITEM_QUANTITY,
    maxBackdateDays: MAX_BACKDATE_DAYS,
    maxTextLength: MAX_TEXT_LENGTH,
    maxSummaryDays: MAX_SUMMARY_DAYS,
  },
  adherenceTolerancePercent: ADHERENCE_TOLERANCE_PERCENT,
  totalsUnits: { totalFeedQuantity: "kg (liters 1:1, pieces excluded)", totalCost: "BDT" },
});

/**
 * GET /feeders — active members who can be picked as fedBy. Only the name, code and
 * farm role are returned (no phone / NID / salary), so every member may call it.
 */
const getFeeders = async (farmId: string, requesterUserId: string) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const rows = await FarmMemberModel.find({ farmId: access.farmObjectId, isActive: true })
    .select("role userId")
    .populate("userId", "userId fullName")
    .sort({ role: 1 })
    .lean();
  return {
    me: access.memberObjectId,
    members: rows.map((row) => {
      const user = row.userId as unknown as { userId?: string; fullName?: string } | null;
      return { _id: row._id, role: row.role, userId: user?.userId ?? null, fullName: user?.fullName ?? null };
    }),
  };
};

/** GET /:id/audit-logs — Owner / Manager: who created, corrected or voided the record. */
const getAuditLogs = async (farmId: string, id: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, FeedRecordPermissions.AUDIT, "view feed record history");
  const doc = await findRecord(access, id);
  const { page, limit, skip } = parsePaging(query, MAX_LIST_LIMIT);
  const filter = { entityType: AuditEntityTypes.FEED_RECORD, entityId: doc._id, farmId: access.farmObjectId };
  const [total, data] = await Promise.all([
    AuditLogModel.countDocuments(filter),
    AuditLogModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      //never expose IP / user agent to farm users
      .select("logNo action event oldData newData changedFields status createdAt userId")
      .populate("userId", "userId fullName")
      .lean(),
  ]);
  return { meta: pageMeta(page, limit, total), data };
};

export const FeedRecordServices = {
  previewFeedRecord,
  createFeedRecord,
  updateFeedRecord,
  voidFeedRecord,
  getFarmFeedRecords,
  getAnimalFeedRecords,
  getFeedRecord,
  getAdherence,
  getStats,
  getMeta,
  getFeeders,
  getAuditLogs,
};
