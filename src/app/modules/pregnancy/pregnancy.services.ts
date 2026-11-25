/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable no-unused-vars */
import status from "http-status";
import mongoose, { isValidObjectId, Types } from "mongoose";
import type { ClientSession } from "mongoose";
import { NotificationProducers } from "../notification/notification.producers.js";
import AppError from "../../errors/AppError.js";
import { AnimalModel } from "../animal/animal.model.js";
import {
  AnimalGenders,
  AnimalLifeStatuses,
  AnimalReproductiveStatuses,
} from "../animal/animal.constants.js";
import QueryBuilder from "../../builder/QueryBuilder.js";
import { BreedingModel } from "../breeding/breeding.model.js";
import { PregnancyResults } from "../breeding/breeding.constants.js";
import { FarmModel } from "../farm/farm.model.js";
import { FarmStatuses } from "../farm/farm.constants.js";
import type { TFarmMemberRole } from "../farmMember/farmMember.interface.js";
import { FarmMemberServices } from "../farmMember/farmMember.service.js";
import { AuditLogModel } from "../auditLog/auditLog.model.js";
import { recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext } from "../auditLog/auditLog.utils.js";
import {
  AuditActions,
  AuditEntityTypes,
  AuditModules,
} from "../auditLog/auditLog.constants.js";
import {
  addDays,
  daysBetween,
  executeAtomically,
  escapeRegex,
  isBlank,
  pageMeta,
  parseCalendarDate,
  parseDateRange,
  parseEnum,
  parseNumber,
  parsePaging,
  round2,
  sessionOpts,
  startOfTodayUtc,
} from "./pregnancy.utils.js";
import {
  generatePregnancyNo,
  PregnancyModel,
  PregnancyCounterModel,
} from "./pregnancy.model.js";
import type { TPregnancy } from "./pregnancy.interface.js";
import {
  CalfGenders,
  CATTLE_GESTATION_DAYS,
  MAX_CONCEPTION_AFTER_SERVICE_DAYS,
  MAX_CALF_COUNT,
  MAX_GESTATION_DAYS,
  MAX_REMARKS,
  MIN_CALF_COUNT,
  MIN_GESTATION_DAYS,
  POST_CALVING_REPRODUCTIVE_STATUS,
  POST_OUTCOME_REPRODUCTIVE_STATUS,
  PregnancyPermissions,
  PREGNANCY_NO_PATTERN,
  PREGNANCY_STATUS_TRANSITIONS,
  PregnancyStatuses,
  SERVER_MANAGED_FIELDS,
} from "./pregnancy.constants.js";

type TPregnancyDoc = TPregnancy & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };
type TPayload = Record<string, unknown>;
type TUndo = (() => Promise<unknown>)[];

/* -------------------------------------------------------------------------- */
/*                         Farm-scoped authorization                          */
/* -------------------------------------------------------------------------- */

type TAccess = {
  farmObjectId: Types.ObjectId;
  farmStatus: string;
  role: TFarmMemberRole;
  memberObjectId: Types.ObjectId | null;
};

/** Active membership (super admin / Farm.ownerId act as Owner) + farm status. */
const resolveAccess = async (
  farmId: string,
  requesterUserId: string,
): Promise<TAccess> => {
  const access = await FarmMemberServices.resolveFarmAccess(farmId, requesterUserId);
  const role = FarmMemberServices.getActorRole(access);
  if (!role) throw new AppError(status.FORBIDDEN, "You are not an active member of this farm!");

  let memberObjectId = (access.membership?._id as Types.ObjectId | undefined) ?? null;
  if (!memberObjectId && access.isOwnerAccount) {
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

const requireRole = (access: TAccess, allowed: readonly string[], action: string) => {
  if (!allowed.includes(access.role)) {
    throw new AppError(status.FORBIDDEN, `Your farm role (${access.role}) is not allowed to ${action}!`);
  }
};

/** Setup / Suspended / Inactive farms cannot write pregnancy records. */
const requireWritableFarm = (access: TAccess) => {
  if (access.farmStatus !== FarmStatuses.ACTIVE) {
    throw new AppError(
      status.FORBIDDEN,
      `This farm is ${access.farmStatus} — pregnancy records can only be written on an Active farm!`,
    );
  }
};

//createdBy is signed by a FarmMember row
const requireMemberRow = (access: TAccess): Types.ObjectId => {
  if (!access.memberObjectId) {
    throw new AppError(status.FORBIDDEN, "An active farm membership is required to write pregnancy records!");
  }
  return access.memberObjectId;
};

const rejectServerFields = (body: TPayload) => {
  const sent = SERVER_MANAGED_FIELDS.filter((field) => field in body);
  if (sent.length) {
    throw new AppError(status.BAD_REQUEST, `${sent.join(", ")} cannot be sent — the server manages these values.`);
  }
};

/* -------------------------------------------------------------------------- */
/*                               Field parsing                                */
/* -------------------------------------------------------------------------- */

const parseText = (field: string, value: unknown, max = MAX_REMARKS): string | undefined => {
  if (isBlank(value)) return undefined;
  if (typeof value !== "string") throw new AppError(status.BAD_REQUEST, `${field} must be text!`);
  const text = value.trim().replace(/[ \t]+/g, " ");
  if (text.length > max) throw new AppError(status.BAD_REQUEST, `${field} cannot exceed ${max} characters!`);
  return text;
};

const requireReason = (field: string, value: unknown, action: string): string => {
  const text = parseText(field, value);
  if (!text || text.length < 3) {
    throw new AppError(status.BAD_REQUEST, `${field} is required to ${action} (at least 3 characters)!`);
  }
  return text;
};

const parseCalfCount = (value: unknown): number => {
  const num = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isFinite(num) || !Number.isInteger(num)) {
    throw new AppError(status.BAD_REQUEST, "calfCount must be a whole number!");
  }
  if (num < MIN_CALF_COUNT) throw new AppError(status.BAD_REQUEST, `calfCount must be at least ${MIN_CALF_COUNT}!`);
  if (num > MAX_CALF_COUNT) throw new AppError(status.BAD_REQUEST, `calfCount cannot exceed ${MAX_CALF_COUNT}!`);
  return num;
};

/* -------------------------------------------------------------------------- */
/*                               Record lookup                                */
/* -------------------------------------------------------------------------- */

/** Pregnancy reference: Mongo _id or PRG-YYYY-NNNNNN, always farm-scoped. */
const findRecord = async (access: TAccess, ref: string): Promise<TPregnancyDoc> => {
  const value = String(ref ?? "").trim();
  let filter: Record<string, unknown>;
  if (isValidObjectId(value)) filter = { _id: new Types.ObjectId(value) };
  else if (PREGNANCY_NO_PATTERN.test(value)) filter = { pregnancyNo: value.toUpperCase() };
  else throw new AppError(status.BAD_REQUEST, "Use a pregnancy id or a PRG-YYYY-NNNNNN number!");
  const doc = await PregnancyModel.findOne({ ...filter, farmId: access.farmObjectId }).lean();
  if (!doc) throw new AppError(status.NOT_FOUND, "Pregnancy record not found in this farm!");
  return doc as unknown as TPregnancyDoc;
};

/** Breeding reference: Mongo _id or BRD-YYYY-NNNNNN, always farm-scoped. */
const findBreeding = async (access: TAccess, ref: string) => {
  const value = String(ref ?? "").trim();
  let filter: Record<string, unknown>;
  const BRD_PATTERN = /^BRD-\d{4}-\d{6}$/i;
  if (isValidObjectId(value)) filter = { _id: new Types.ObjectId(value) };
  else if (BRD_PATTERN.test(value)) filter = { breedingNo: value.toUpperCase() };
  else throw new AppError(status.BAD_REQUEST, "Use a breeding id or a BRD-YYYY-NNNNNN number!");
  const doc = await BreedingModel.findOne({ ...filter, farmId: access.farmObjectId }).lean();
  if (!doc) throw new AppError(status.NOT_FOUND, "Breeding record not found in this farm!");
  return doc as unknown as { _id: Types.ObjectId; breedingNo: string; animalId: Types.ObjectId; farmId: Types.ObjectId; pregnancyResult: string; inseminationDate: Date | null; heatDetectedDate: Date; createdAt: Date; updatedAt: Date };
};

/* -------------------------------------------------------------------------- */
/*                              Population helpers                            */
/* -------------------------------------------------------------------------- */

const MEMBER_POPULATE = { select: "role userId", populate: { path: "userId", select: "userId fullName" } };

const populatePregnancy = <T>(query: T): T => {
  const q = query as unknown as mongoose.Query<unknown, unknown>;
  return q
    .populate("animalId", "animalCode name gender lifeStatus reproductiveStatus")
    .populate("breedingId", "breedingNo breedingMethod heatDetectedDate inseminationDate pregnancyResult")
    .populate({ path: "createdBy", ...MEMBER_POPULATE }) as unknown as T;
};

/** Latest pregnancy per animal (conceptionDate then creation). */
const latestPregnancyForAnimal = async (
  access: TAccess,
  animalId: Types.ObjectId,
  session: ClientSession | null = null,
) =>
  PregnancyModel.findOne(
    { farmId: access.farmObjectId, animalId },
    null,
    { session, sort: { conceptionDate: -1, createdAt: -1 } },
  ).lean();

/** Whether another active Pregnancy exists for this animal (excluding this record). */
const hasOtherActivePregnancy = async (
  access: TAccess,
  animalId: Types.ObjectId,
  excludeId: Types.ObjectId | null = null,
) =>
  PregnancyModel.exists({
    farmId: access.farmObjectId,
    animalId,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    pregnancyStatus: PregnancyStatuses.PREGNANT,
  });

/** Update mother's reproductiveStatus based on the latest valid pregnancy cycle. */
const syncMotherReproductiveStatus = async (
  access: TAccess,
  animalId: Types.ObjectId,
  session: ClientSession | null,
  undo: TUndo,
  notes: string[],
): Promise<{ from: string; to: string } | null> => {
  const mother = await AnimalModel.findOne({ _id: animalId, farmId: access.farmObjectId })
    .select("reproductiveStatus animalCode")
    .session(session)
    .lean();
  if (!mother) return null;
  const currentStatus = mother.reproductiveStatus as string;

  const latest = await latestPregnancyForAnimal(access, animalId, session);
  let target: string;
  if (!latest) {
    target = AnimalReproductiveStatuses.OPEN;
  } else if (latest.pregnancyStatus === PregnancyStatuses.PREGNANT) {
    target = AnimalReproductiveStatuses.PREGNANT;
  } else if (latest.pregnancyStatus === PregnancyStatuses.DELIVERED) {
    target = POST_CALVING_REPRODUCTIVE_STATUS;
  } else {
    target = AnimalReproductiveStatuses.OPEN;
  }
  if (target === currentStatus) return null;
  await AnimalModel.updateOne({ _id: animalId }, { $set: { reproductiveStatus: target } }, sessionOpts(session));
  undo.push(() => AnimalModel.updateOne({ _id: animalId }, { $set: { reproductiveStatus: currentStatus } }));
  notes.push(`Mother's reproductive status: ${currentStatus} → ${target}.`);
  return { from: currentStatus, to: target };
};

/* -------------------------------------------------------------------------- */
/*                              Create                                        */
/* -------------------------------------------------------------------------- */

const createPregnancy = async (
  farmId: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, PregnancyPermissions.CREATE, "create pregnancy records");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);
  rejectServerFields(body);

  const breedingId = String(body.breedingId ?? "").trim();
  if (!breedingId) throw new AppError(status.BAD_REQUEST, "breedingId is required!");
  const breeding = await findBreeding(access, breedingId);

  //the breeding must be confirmed before a pregnancy can be created
  if (breeding.pregnancyResult !== "Confirmed") {
    throw new AppError(status.BAD_REQUEST, "A pregnancy can only be created from a Confirmed breeding!");
  }

  //animal must belong to the same farm as the breeding and this request
  const animal = await AnimalModel.findOne({ _id: breeding.animalId, farmId: access.farmObjectId })
    .select("animalCode name gender lifeStatus reproductiveStatus")
    .lean();
  if (!animal) throw new AppError(status.NOT_FOUND, "The breeding's animal is not in this farm!");
  if (animal.gender !== "Female") {
    throw new AppError(status.BAD_REQUEST, "Only female animals can have pregnancy records!");
  }
  if (animal.lifeStatus !== "Active") {
    throw new AppError(status.BAD_REQUEST, "The animal must be Active to start a pregnancy!");
  }

  //1 Breeding → 1 Pregnancy (unique index is the guard, checked here for a clean error)
  const existing = await PregnancyModel.findOne({ breedingId: breeding._id }).lean();
  if (existing) {
    throw new AppError(
      status.CONFLICT,
      `Pregnancy ${existing.pregnancyNo} already exists for breeding ${breeding.breedingNo} — one breeding has at most one pregnancy.`,
    );
  }

  //no open Pregnant episode for this animal
  const active = await hasOtherActivePregnancy(access, breeding.animalId);
  if (active) {
    throw new AppError(
      status.CONFLICT,
      `${animal.animalCode} already has an active pregnancy — record its outcome before starting a new one.`,
    );
  }

  const today = new Date();
  const serviceDate = breeding.inseminationDate ? new Date(breeding.inseminationDate) : null;
  const heatDate = new Date(breeding.heatDetectedDate);

  //conception date defaults to the service date; must fall within heat → service + 3 days
  let conceptionDate: Date;
  if (!isBlank(body.conceptionDate)) {
    conceptionDate = parseCalendarDate("conceptionDate", body.conceptionDate);
    if (conceptionDate < heatDate) {
      throw new AppError(status.BAD_REQUEST, "conceptionDate cannot be before the heat date!");
    }
    if (serviceDate && conceptionDate > addDays(serviceDate, MAX_CONCEPTION_AFTER_SERVICE_DAYS)) {
      throw new AppError(
        status.BAD_REQUEST,
        `conceptionDate must be within ${MAX_CONCEPTION_AFTER_SERVICE_DAYS} days after the insemination date!`,
      );
    }
  } else {
    conceptionDate = serviceDate ?? heatDate;
  }

  //expected calving date defaults to conception + 283 days
  let expectedCalvingDate: Date;
  if (!isBlank(body.expectedCalvingDate)) {
    expectedCalvingDate = parseCalendarDate("expectedCalvingDate", body.expectedCalvingDate);
    const gestation = daysBetween(conceptionDate, expectedCalvingDate);
    if (gestation < MIN_GESTATION_DAYS || gestation > MAX_GESTATION_DAYS) {
      throw new AppError(
        status.BAD_REQUEST,
        `expectedCalvingDate must be ${MIN_GESTATION_DAYS}–${MAX_GESTATION_DAYS} days after conception (it is ${gestation}).`,
      );
    }
  } else {
    expectedCalvingDate = addDays(conceptionDate, CATTLE_GESTATION_DAYS);
  }

  const pregnancyNo = await generatePregnancyNo(today);
  const remarks = parseText("remarks", body.remarks);

  const result = await executeAtomically(async (session, undo) => {
    const [created] = await PregnancyModel.create(
      [
        {
          pregnancyNo,
          farmId: access.farmObjectId,
          animalId: breeding.animalId,
          breedingId: breeding._id,
          conceptionDate,
          expectedCalvingDate,
          actualCalvingDate: null,
          calfCount: null,
          calfGender: null,
          pregnancyStatus: PregnancyStatuses.PREGNANT,
          ...(remarks ? { remarks } : {}),
          createdBy: memberId,
        },
      ],
      sessionOpts(session),
    );
    if (!created) throw new AppError(status.INTERNAL_SERVER_ERROR, "Failed to create the pregnancy record!");
    undo.push(() => PregnancyModel.deleteOne({ _id: created._id }));

    //mother becomes Pregnant (this is her only/ latest cycle at creation)
    const beforeRepro = animal.reproductiveStatus as string;
    await AnimalModel.updateOne(
      { _id: breeding.animalId },
      { $set: { reproductiveStatus: AnimalReproductiveStatuses.PREGNANT } },
      sessionOpts(session),
    );
    undo.push(() => AnimalModel.updateOne({ _id: breeding.animalId }, { $set: { reproductiveStatus: beforeRepro } }));

    await recordAuditLog({
      context,
      farmId: access.farmObjectId,
      entityType: AuditEntityTypes.PREGNANCY,
      entityId: created._id,
      action: AuditActions.CREATE,
      module: AuditModules.ANIMAL,
      event: "Pregnancy Created",
      oldData: null,
      newData: {
        pregnancyNo: created.pregnancyNo,
        animalId: breeding.animalId,
        breedingId: breeding._id,
        conceptionDate,
        expectedCalvingDate,
        pregnancyStatus: PregnancyStatuses.PREGNANT,
      },
      changedFields: ["pregnancyNo", "animalId", "breedingId", "conceptionDate", "expectedCalvingDate", "pregnancyStatus"],
    });

    return created;
  });

  await NotificationProducers.pregnancyChanged(access.farmObjectId, result._id, "confirmed");
  const populated = await populatePregnancy(PregnancyModel.findById(result._id).select("-__v")).lean();
  return { pregnancy: populated };
};

/* -------------------------------------------------------------------------- */
/*                              List (farm-wide)                              */
/* -------------------------------------------------------------------------- */

const getFarmPregnancies = async (
  farmId: string,
  requesterUserId: string,
  query: TPayload,
) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, PregnancyPermissions.READ, "view pregnancy records");

  const { page, limit, skip } = parsePaging(query, 100, 10);
  const sortRaw = typeof query.sort === "string" ? query.sort : "-expectedCalvingDate";

  const filter: Record<string, unknown> = { farmId: access.farmObjectId };

  //status filter (comma list: Pregnant,Delivered,Aborted,Failed)
  if (query.pregnancyStatus) {
    const statuses = String(query.pregnancyStatus).split(",").map((s) => s.trim()).filter(Boolean);
    const invalid = statuses.filter((s) => !(Object.values(PregnancyStatuses) as string[]).includes(s));
    if (invalid.length) {
      throw new AppError(status.BAD_REQUEST, `Invalid pregnancyStatus: ${invalid.join(", ")}!`);
    }
    filter.pregnancyStatus = { $in: statuses };
  }

  //animal filter (by _id or AN-… code)
  if (query.animalId) {
    const animalRef = String(query.animalId).trim();
    if (isValidObjectId(animalRef)) {
      filter.animalId = new Types.ObjectId(animalRef);
    } else {
      const animal = await AnimalModel.findOne({
        animalCode: animalRef.toUpperCase(),
        farmId: access.farmObjectId,
      }).select("_id").lean();
      if (!animal) throw new AppError(status.NOT_FOUND, "Animal not found in this farm!");
      filter.animalId = animal._id;
    }
  }

  //date range on expectedCalvingDate (default) or conceptionDate
  const dateField = query.dateField === "conceptionDate" ? "conceptionDate" : "expectedCalvingDate";
  if (query.from || query.to) {
    Object.assign(filter, parseDateRange(query, dateField));
  }

  //upcoming calving: expected within N days
  if (query.upcomingCalvingDays) {
    const days = parseNumber("upcomingCalvingDays", query.upcomingCalvingDays, { min: 1, max: 365 });
    const from = startOfTodayUtc();
    const to = addDays(from, days);
    filter.expectedCalvingDate = { $gte: from, $lte: to };
    filter.pregnancyStatus = PregnancyStatuses.PREGNANT;
  }

  //overdue calving: Pregnant and expected date is in the past
  if (query.overdueCalving === "true") {
    filter.pregnancyStatus = PregnancyStatuses.PREGNANT;
    filter.expectedCalvingDate = { $lt: startOfTodayUtc() };
  }

  //search: pregnancyNo / animal code / name
  const searchTerm = typeof query.searchTerm === "string" ? query.searchTerm.trim() : "";
  if (searchTerm) {
    const rx = new RegExp(escapeRegex(searchTerm), "i");
    const [pregByNo, animals] = await Promise.all([
      PREGNANCY_NO_PATTERN.test(searchTerm)
        ? PregnancyModel.findOne({ pregnancyNo: searchTerm.toUpperCase() }).select("_id").lean()
        : null,
      AnimalModel.find({
        farmId: access.farmObjectId,
        $or: [{ animalCode: rx }, { name: rx }],
      }).select("_id").lean(),
    ]);
    const or: Record<string, unknown>[] = [];
    if (pregByNo) or.push({ _id: pregByNo._id });
    if (animals.length) or.push({ animalId: { $in: animals.map((a) => a._id) } });
    if (or.length) filter.$or = or;
  }

  const baseQuery = PregnancyModel.find(filter);
  const countQuery = PregnancyModel.find(filter);

  const [meta, data] = await Promise.all([
    new QueryBuilder(countQuery, { page, limit, sort: sortRaw }).countTotal(),
    populatePregnancy(
      baseQuery
        .sort(sortRaw)
        .skip(skip)
        .limit(limit)
        .select("-__v"),
    ).lean(),
  ]);
  return { meta: pageMeta(page, limit, meta.totalEntries), data };
};

/* -------------------------------------------------------------------------- */
/*                      Animal lifetime pregnancy history                     */
/* -------------------------------------------------------------------------- */

const getAnimalPregnancies = async (
  farmId: string,
  animalIdRef: string,
  requesterUserId: string,
) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, PregnancyPermissions.READ, "view animal pregnancy history");

  //resolve the animal (farm-isolated)
  const animalFilter: Record<string, unknown> = { farmId: access.farmObjectId };
  if (isValidObjectId(animalIdRef)) {
    animalFilter._id = new Types.ObjectId(animalIdRef);
  } else {
    animalFilter.animalCode = animalIdRef.toUpperCase();
  }
  const animal = await AnimalModel.findOne(animalFilter).select("animalCode name gender lifeStatus reproductiveStatus").lean();
  if (!animal) throw new AppError(status.NOT_FOUND, "Animal not found in this farm!");

  const pregnancies = await populatePregnancy(
    PregnancyModel.find({ farmId: access.farmObjectId, animalId: animal._id })
      .sort({ conceptionDate: -1, createdAt: -1 })
      .select("-__v"),
  ).lean();

  const active = pregnancies.find((p) => p.pregnancyStatus === PregnancyStatuses.PREGNANT) ?? null;

  return {
    animal: {
      _id: animal._id,
      animalCode: animal.animalCode,
      name: animal.name,
      gender: animal.gender,
      lifeStatus: animal.lifeStatus,
      reproductiveStatus: animal.reproductiveStatus,
    },
    activePregnancy: active ?? null,
    pregnancies,
  };
};

/* -------------------------------------------------------------------------- */
/*                              Analytics                                     */
/* -------------------------------------------------------------------------- */

const getPregnancyAnalytics = async (
  farmId: string,
  requesterUserId: string,
  query: TPayload,
) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, PregnancyPermissions.READ, "view pregnancy analytics");

  const match: Record<string, unknown> = { farmId: access.farmObjectId };
  if (query.from || query.to) {
    Object.assign(match, parseDateRange(query, "conceptionDate"));
  }

  const today = new Date();
  const pipeline: Record<string, unknown>[] = [
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        pregnant: {
          $sum: { $cond: [{ $eq: ["$pregnancyStatus", PregnancyStatuses.PREGNANT] }, 1, 0] },
        },
        delivered: {
          $sum: { $cond: [{ $eq: ["$pregnancyStatus", PregnancyStatuses.DELIVERED] }, 1, 0] },
        },
        aborted: {
          $sum: { $cond: [{ $eq: ["$pregnancyStatus", PregnancyStatuses.ABORTED] }, 1, 0] },
        },
        failed: {
          $sum: { $cond: [{ $eq: ["$pregnancyStatus", PregnancyStatuses.FAILED] }, 1, 0] },
        },
        twinDeliveries: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$pregnancyStatus", PregnancyStatuses.DELIVERED] },
                  { $eq: ["$calfCount", 2] },
                ],
              },
              1,
              0,
            ],
          },
        },
        totalCalves: { $sum: { $ifNull: ["$calfCount", 0] } },
        totalGestationDays: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$pregnancyStatus", PregnancyStatuses.DELIVERED] },
                  { $and: [{ $ne: ["$actualCalvingDate", null] }, { $ne: ["$conceptionDate", null] }] },
                ],
              },
              { $divide: [{ $subtract: ["$actualCalvingDate", "$conceptionDate"] }, 86400000] },
              0,
            ],
          },
        },
      },
    },
  ];

  const [summary] = await PregnancyModel.aggregate(pipeline as unknown as Parameters<typeof PregnancyModel.aggregate>[0]);
  const s = summary ?? { total: 0, pregnant: 0, delivered: 0, aborted: 0, failed: 0, twinDeliveries: 0, totalCalves: 0, totalGestationDays: 0 };

  const totalEvaluated = s.delivered + s.aborted + s.failed;
  const deliveryRate = totalEvaluated > 0 ? round2((s.delivered / totalEvaluated) * 100) : null;
  const abortionRate = s.total > 0 ? round2((s.aborted / s.total) * 100) : null;
  const twinRate = s.delivered > 0 ? round2((s.twinDeliveries / s.delivered) * 100) : null;
  const avgGestation = s.delivered > 0 && s.totalGestationDays > 0 ? round2(s.totalGestationDays / s.delivered) : null;
  const avgCalves = s.delivered > 0 ? round2(s.totalCalves / s.delivered) : null;

  //upcoming calvings (next 30 days, Pregnant)
  const upcomingFrom = today;
  const upcomingTo = addDays(today, 30);
  const upcomingCalvings = await PregnancyModel.countDocuments({
    farmId: access.farmObjectId,
    pregnancyStatus: PregnancyStatuses.PREGNANT,
    expectedCalvingDate: { $gte: upcomingFrom, $lte: upcomingTo },
  });

  //overdue calvings (Pregnant and expected date is past)
  const overdueCalvings = await PregnancyModel.countDocuments({
    farmId: access.farmObjectId,
    pregnancyStatus: PregnancyStatuses.PREGNANT,
    expectedCalvingDate: { $lt: today },
  });

  return {
    farmId: access.farmObjectId,
    totalPregnancies: s.total,
    byStatus: {
      Pregnant: s.pregnant,
      Delivered: s.delivered,
      Aborted: s.aborted,
      Failed: s.failed,
    },
    deliveryRatePercent: deliveryRate,
    abortionRatePercent: abortionRate,
    twinRatePercent: twinRate,
    averageGestationDays: avgGestation,
    averageCalvesPerDelivery: avgCalves,
    totalCalves: s.totalCalves,
    upcomingCalvings,
    overdueCalvings,
    period: query.from || query.to ? { from: query.from, to: query.to } : null,
  };
};

/* -------------------------------------------------------------------------- */
/*                              Detail                                        */
/* -------------------------------------------------------------------------- */

const getPregnancy = async (farmId: string, id: string, requesterUserId: string) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, PregnancyPermissions.READ, "view pregnancy records");

  const doc = await findRecord(access, id);

  //full detail: animal, upstream breeding (with sire parentage), creator
  const populated = await PregnancyModel.findById(doc._id)
    .select("-__v")
    .populate("animalId", "animalCode name gender lifeStatus healthStatus reproductiveStatus birthDate profilePhoto purpose breedId")
    .populate({
      path: "breedingId",
      select: "breedingNo breedingMethod heatDetectedDate inseminationDate pregnancyResult bullId semenBatchNo technicianName",
      populate: { path: "bullId", select: "animalCode name gender lifeStatus birthDate profilePhoto breedId" },
    })
    .populate({ path: "createdBy", ...MEMBER_POPULATE })
    .lean();

  if (!populated) throw new AppError(status.NOT_FOUND, "Pregnancy record not found!");

  //derived fields
  const today = new Date();
  const daysSinceConception = daysBetween(new Date(populated.conceptionDate), today);
  const daysUntilCalving = populated.expectedCalvingDate
    ? daysBetween(today, new Date(populated.expectedCalvingDate))
    : null;
  const isOverdue =
    populated.pregnancyStatus === PregnancyStatuses.PREGNANT &&
    !!populated.expectedCalvingDate &&
    new Date(populated.expectedCalvingDate) < today;

  //pregnancy duration once delivered
  const pregnancyDurationDays =
    populated.pregnancyStatus === PregnancyStatuses.DELIVERED && populated.actualCalvingDate
      ? daysBetween(new Date(populated.conceptionDate), new Date(populated.actualCalvingDate))
      : null;

  //expected vs actual calving variance (negative = early, positive = late)
  const calvingVarianceDays =
    populated.pregnancyStatus === PregnancyStatuses.DELIVERED &&
      populated.actualCalvingDate &&
      populated.expectedCalvingDate
      ? daysBetween(new Date(populated.expectedCalvingDate), new Date(populated.actualCalvingDate))
      : null;

  return {
    ...populated,
    derived: {
      daysSinceConception,
      daysUntilCalving,
      isOverdue,
      pregnancyDurationDays,
      calvingVarianceDays,
    },
  };
};

/* -------------------------------------------------------------------------- */
/*                              Deliver (calving)                             */
/* -------------------------------------------------------------------------- */

const deliverPregnancy = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, PregnancyPermissions.DELIVER, "record calving deliveries");
  requireWritableFarm(access);
  requireMemberRow(access);
  rejectServerFields(body);

  const doc = await findRecord(access, id);
  if (doc.pregnancyStatus !== PregnancyStatuses.PREGNANT) {
    throw new AppError(status.CONFLICT, `Only a Pregnant pregnancy can be delivered (current: ${doc.pregnancyStatus}).`);
  }

  const actualCalvingDate = isBlank(body.actualCalvingDate) ? new Date() : parseCalendarDate("actualCalvingDate", body.actualCalvingDate);
  if (actualCalvingDate > new Date()) {
    throw new AppError(status.BAD_REQUEST, "actualCalvingDate cannot be in the future!");
  }
  if (actualCalvingDate <= new Date(doc.conceptionDate)) {
    throw new AppError(status.BAD_REQUEST, "actualCalvingDate must be after the conception date!");
  }

  const calfCount = parseCalfCount(body.calfCount);
  const calfGender = parseEnum("calfGender", body.calfGender, Object.values(CalfGenders));
  //calfGender Twin only when calfCount = 2
  if (calfGender === CalfGenders.TWIN && calfCount !== 2) {
    throw new AppError(status.BAD_REQUEST, "calfGender 'Twin' is only valid when calfCount is 2!");
  }
  if (calfCount === 2 && calfGender !== CalfGenders.TWIN) {
    throw new AppError(status.BAD_REQUEST, "calfCount 2 requires calfGender 'Twin'!");
  }
  const gestation = daysBetween(doc.conceptionDate, actualCalvingDate);
  if (gestation < MIN_GESTATION_DAYS || gestation > MAX_GESTATION_DAYS) {
    throw new AppError(
      status.BAD_REQUEST,
      `Calving must occur ${MIN_GESTATION_DAYS}–${MAX_GESTATION_DAYS} days after conception (it is ${gestation} days).`,
    );
  }

  const remarks = parseText("remarks", body.remarks);

  const result = await executeAtomically(async (session, undo) => {
    const before = {
      pregnancyStatus: doc.pregnancyStatus,
      actualCalvingDate: doc.actualCalvingDate,
      calfCount: doc.calfCount,
      calfGender: doc.calfGender,
      remarks: doc.remarks,
    };

    const deliveryUpdates: Record<string, unknown> = {
      pregnancyStatus: PregnancyStatuses.DELIVERED,
      actualCalvingDate,
      calfCount,
      calfGender,
    };
    if (remarks) {
      deliveryUpdates.remarks = `${doc.remarks ? doc.remarks + " — " : ""}${remarks}`;
    }

    const updated = await PregnancyModel.findOneAndUpdate(
      { _id: doc._id, pregnancyStatus: PregnancyStatuses.PREGNANT },
      { $set: deliveryUpdates },
      { returnDocument: "after", ...sessionOpts(session) },
    );
    if (!updated) throw new AppError(status.CONFLICT, "This pregnancy was changed by someone else. Reload and try again.");
    undo.push(() =>
      PregnancyModel.findOneAndUpdate({ _id: doc._id }, { $set: before }, sessionOpts(session)),
    );

    //mother → Lactating after delivery
    const mother = await AnimalModel.findOne({ _id: doc.animalId, farmId: access.farmObjectId })
      .select("reproductiveStatus animalCode").session(session).lean();
    const beforeRepro = mother?.reproductiveStatus as string;
    await AnimalModel.updateOne(
      { _id: doc.animalId },
      { $set: { reproductiveStatus: POST_CALVING_REPRODUCTIVE_STATUS } },
      sessionOpts(session),
    );
    undo.push(() => AnimalModel.updateOne({ _id: doc.animalId }, { $set: { reproductiveStatus: beforeRepro } }));

    await recordAuditLog({
      context,
      farmId: access.farmObjectId,
      entityType: AuditEntityTypes.PREGNANCY,
      entityId: doc._id,
      action: AuditActions.UPDATE,
      module: AuditModules.ANIMAL,
      event: "Pregnancy Delivered",
      oldData: before,
      newData: {
        pregnancyStatus: PregnancyStatuses.DELIVERED,
        actualCalvingDate,
        calfCount,
        calfGender,
        ...(remarks ? { remarks } : {}),
      },
      changedFields: remarks
        ? ["pregnancyStatus", "actualCalvingDate", "calfCount", "calfGender", "remarks"]
        : ["pregnancyStatus", "actualCalvingDate", "calfCount", "calfGender"],
    });

    return updated;
  });

  await NotificationProducers.pregnancyChanged(access.farmObjectId, result._id, "delivered");
  const populated = await populatePregnancy(PregnancyModel.findById(result._id).select("-__v")).lean();
  return { pregnancy: populated };
};

/* -------------------------------------------------------------------------- */
/*                              Outcome (abort / fail)                        */
/* -------------------------------------------------------------------------- */

const recordPregnancyOutcome = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, PregnancyPermissions.OUTCOME, "record pregnancy outcomes");
  requireWritableFarm(access);
  requireMemberRow(access);
  rejectServerFields(body);

  const doc = await findRecord(access, id);
  if (doc.pregnancyStatus !== PregnancyStatuses.PREGNANT) {
    throw new AppError(status.CONFLICT, `Only a Pregnant pregnancy can be closed (current: ${doc.pregnancyStatus}).`);
  }

  const outcome = parseEnum("outcome", body.outcome, [PregnancyStatuses.ABORTED, PregnancyStatuses.FAILED]);
  const reason = requireReason("reason", body.reason, `record a ${outcome} outcome`);
  const remarks = parseText("remarks", body.remarks);

  const result = await executeAtomically(async (session, undo) => {
    const before = {
      pregnancyStatus: doc.pregnancyStatus,
      remarks: doc.remarks,
    };

    const combinedRemarks = [
      doc.remarks,
      `Outcome: ${outcome}.`,
      reason ? `Reason: ${reason}` : null,
      remarks,
    ].filter(Boolean).join(" — ");

    const updated = await PregnancyModel.findOneAndUpdate(
      { _id: doc._id, pregnancyStatus: PregnancyStatuses.PREGNANT },
      {
        $set: {
          pregnancyStatus: outcome,
          actualCalvingDate: null,
          calfCount: null,
          calfGender: null,
          remarks: combinedRemarks.slice(0, MAX_REMARKS),
        },
      },
      { returnDocument: "after", ...sessionOpts(session) },
    );
    if (!updated) throw new AppError(status.CONFLICT, "This pregnancy was changed by someone else. Reload and try again.");
    undo.push(() => PregnancyModel.findOneAndUpdate({ _id: doc._id }, { $set: before }, sessionOpts(session)));

    //mother returns to Open only if no newer pregnancy overrides it
    const notes: string[] = [];
    await syncMotherReproductiveStatus(access, doc.animalId, session, undo, notes);

    await recordAuditLog({
      context,
      farmId: access.farmObjectId,
      entityType: AuditEntityTypes.PREGNANCY,
      entityId: doc._id,
      action: AuditActions.UPDATE,
      module: AuditModules.ANIMAL,
      event: `Pregnancy ${outcome}`,
      oldData: before,
      newData: { pregnancyStatus: outcome, reason, remarks },
      changedFields: ["pregnancyStatus", "remarks"],
    });

    return { ...updated, notes };
  });

  await NotificationProducers.pregnancyChanged(access.farmObjectId, doc._id);
  const populated = await populatePregnancy(PregnancyModel.findById(result._id).select("-__v")).lean();
  return {
    pregnancy: populated,
    outcome,
    reason,
    reproductiveStatusUpdated: result.notes.length > 0,
  };
};

/* -------------------------------------------------------------------------- */
/*                              Correction (PUT)                              */
/* -------------------------------------------------------------------------- */

const updatePregnancy = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, PregnancyPermissions.UPDATE, "correct pregnancy records");
  requireWritableFarm(access);
  requireMemberRow(access);
  rejectServerFields(body);

  const doc = await findRecord(access, id);
  const updates: Record<string, unknown> = {};
  const changedFields: string[] = [];

  if (!isBlank(body.conceptionDate)) {
    const date = parseCalendarDate("conceptionDate", body.conceptionDate);
    if (date.getTime() !== new Date(doc.conceptionDate).getTime()) {
      updates.conceptionDate = date;
      changedFields.push("conceptionDate");
    }
  }

  if (!isBlank(body.expectedCalvingDate)) {
    const date = parseCalendarDate("expectedCalvingDate", body.expectedCalvingDate);
    const conception = updates.conceptionDate ?? doc.conceptionDate;
    const gestation = daysBetween(new Date(conception as Date), date);
    if (gestation < MIN_GESTATION_DAYS || gestation > MAX_GESTATION_DAYS) {
      throw new AppError(
        status.BAD_REQUEST,
        `expectedCalvingDate must be ${MIN_GESTATION_DAYS}–${MAX_GESTATION_DAYS} days after conception (it is ${gestation}).`,
      );
    }
    if (date.getTime() !== new Date(doc.expectedCalvingDate).getTime()) {
      updates.expectedCalvingDate = date;
      changedFields.push("expectedCalvingDate");
    }
  }

  if (!isBlank(body.remarks)) {
    const text = String(body.remarks).trim();
    if (text !== (doc.remarks ?? "")) {
      updates.remarks = text;
      changedFields.push("remarks");
    }
  }

  if (changedFields.length === 0) {
    return { mode: "unchanged", pregnancy: doc };
  }

  //a reason is expected when dates are corrected (audit trail)
  if (changedFields.includes("conceptionDate") || changedFields.includes("expectedCalvingDate")) {
    const reason = parseText("reason", body.reason);
    if (!reason || reason.length < 3) {
      throw new AppError(status.BAD_REQUEST, "reason is required when correcting conceptionDate or expectedCalvingDate (at least 3 characters)!");
    }
    changedFields.push("reason");
  }

  const oldData = {
    conceptionDate: doc.conceptionDate,
    expectedCalvingDate: doc.expectedCalvingDate,
    remarks: doc.remarks,
  };
  const newData = {
    ...(updates.conceptionDate ? { conceptionDate: updates.conceptionDate } : {}),
    ...(updates.expectedCalvingDate ? { expectedCalvingDate: updates.expectedCalvingDate } : {}),
    ...(updates.remarks ? { remarks: updates.remarks } : {}),
  };

  const result = await executeAtomically(async (session, undo) => {
    const updated = await PregnancyModel.findOneAndUpdate(
      { _id: doc._id },
      { $set: updates },
      { returnDocument: "after", ...sessionOpts(session) },
    );
    if (!updated) throw new AppError(status.CONFLICT, "This pregnancy was changed by someone else. Reload and try again.");
    undo.push(() => PregnancyModel.findOneAndUpdate({ _id: doc._id }, { $set: oldData }, sessionOpts(session)));

    await recordAuditLog({
      context,
      farmId: access.farmObjectId,
      entityType: AuditEntityTypes.PREGNANCY,
      entityId: doc._id,
      action: AuditActions.UPDATE,
      module: AuditModules.ANIMAL,
      event: "Pregnancy Corrected",
      oldData,
      newData,
      changedFields: changedFields.filter((f) => f !== "reason"),
    });

    return updated;
  });

  await NotificationProducers.pregnancyChanged(access.farmObjectId, result._id);
  const populated = await populatePregnancy(PregnancyModel.findById(result._id).select("-__v")).lean();
  return { mode: "updated", pregnancy: populated, changedFields };
};

/* -------------------------------------------------------------------------- */
/*                              Delete (blocked)                              */
/* -------------------------------------------------------------------------- */

const deletePregnancy = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  _payload: TPayload,
  context: TAuditContext,
) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, PregnancyPermissions.DELETE, "delete pregnancy records");

  await findRecord(access, id);

  //hard deletion is never allowed for historical pregnancy records
  throw new AppError(
    status.FORBIDDEN,
    "Pregnancy records are historical reproductive records and cannot be deleted. Record an outcome (Aborted / Failed) or correct the record instead.",
  );
};

/* -------------------------------------------------------------------------- */
/*                   Eligible breedings (create-form picker)                  */
/* -------------------------------------------------------------------------- */

/**
 * GET /eligible-breedings — Owner / Manager / Vet.
 *
 * Confirmed breedings of this farm that can still start a pregnancy:
 *  - pregnancyResult === "Confirmed"                (only a confirmed check starts a pregnancy)
 *  - no Pregnancy row links to them                 (1 Breeding -> 1 Pregnancy)
 *  - the female is Active and has no open "Pregnant" episode
 *
 * This only narrows the picker; POST / re-validates every rule, so a stale list can never
 * create an invalid record. Supports ?animalId= (_id or animal code), ?searchTerm= and paging.
 */
const getEligibleBreedings = async (
  farmId: string,
  requesterUserId: string,
  query: TPayload,
) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, PregnancyPermissions.CREATE, "create pregnancy records");

  const { page, limit, skip } = parsePaging(query, 100, 20);

  //every breeding that already owns a pregnancy, and every female currently carrying one
  const [linked, openEpisodes] = await Promise.all([
    PregnancyModel.find({ farmId: access.farmObjectId }).select("breedingId").lean(),
    PregnancyModel.find({ farmId: access.farmObjectId, pregnancyStatus: PregnancyStatuses.PREGNANT })
      .select("animalId")
      .lean(),
  ]);
  const linkedBreedingIds = linked.map((row) => row.breedingId);
  const busyAnimalIds = openEpisodes.map((row) => row.animalId);

  //only Active females of this farm qualify
  const animalFilter: Record<string, unknown> = {
    farmId: access.farmObjectId,
    gender: AnimalGenders.FEMALE,
    lifeStatus: AnimalLifeStatuses.ACTIVE,
    ...(busyAnimalIds.length ? { _id: { $nin: busyAnimalIds } } : {}),
  };

  //optional animal filter (by _id or AN-… code)
  if (!isBlank(query.animalId)) {
    const animalRef = String(query.animalId).trim();
    if (isValidObjectId(animalRef)) animalFilter._id = new Types.ObjectId(animalRef);
    else animalFilter.animalCode = animalRef.toUpperCase();
  }

  //free-text search on animal code / name
  const searchTerm = typeof query.searchTerm === "string" ? query.searchTerm.trim() : "";
  if (searchTerm) {
    const rx = new RegExp(escapeRegex(searchTerm), "i");
    animalFilter.$or = [{ animalCode: rx }, { name: rx }];
  }

  const eligibleAnimals = await AnimalModel.find(animalFilter).select("_id").lean();
  if (!eligibleAnimals.length) return { meta: pageMeta(page, limit, 0), data: [] };

  const filter: Record<string, unknown> = {
    farmId: access.farmObjectId,
    pregnancyResult: PregnancyResults.CONFIRMED,
    animalId: { $in: eligibleAnimals.map((a) => a._id) },
    ...(linkedBreedingIds.length ? { _id: { $nin: linkedBreedingIds } } : {}),
  };

  const [total, data] = await Promise.all([
    BreedingModel.countDocuments(filter),
    BreedingModel.find(filter)
      //newest service first: that is the breeding a user is most likely to record
      .sort({ inseminationDate: -1, heatDetectedDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("breedingNo animalId breedingMethod heatDetectedDate inseminationDate semenBatchNo technicianName pregnancyResult bullId createdAt")
      .populate("animalId", "animalCode name gender lifeStatus reproductiveStatus")
      .populate("bullId", "animalCode name gender lifeStatus")
      .lean(),
  ]);

  //the default conception / expected calving dates the create endpoint would apply
  const suggested = data.map((row) => {
    const service = row.inseminationDate ? new Date(row.inseminationDate) : new Date(row.heatDetectedDate);
    return {
      ...row,
      suggestedConceptionDate: service,
      suggestedCalvingDate: addDays(service, CATTLE_GESTATION_DAYS),
    };
  });

  return { meta: pageMeta(page, limit, total), data: suggested };
};

/* -------------------------------------------------------------------------- */
/*                         Change history (audit logs)                        */
/* -------------------------------------------------------------------------- */

/**
 * GET /:id/audit-logs — Owner / Manager / Vet: who created, delivered, closed or corrected
 * this episode. IP / user agent are never exposed to farm users. Rows written against the
 * upstream Breeding (e.g. the confirmation that created this pregnancy) are included, so the
 * episode's full paper trail reads in one list.
 */
const getAuditLogs = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  query: TPayload,
) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, PregnancyPermissions.AUDIT, "view pregnancy history");

  const doc = await findRecord(access, id);
  const { page, limit, skip } = parsePaging(query, 100, 20);

  const filter = {
    farmId: access.farmObjectId,
    $or: [
      { entityType: AuditEntityTypes.PREGNANCY, entityId: doc._id },
      { entityType: AuditEntityTypes.BREEDING, entityId: doc.breedingId },
    ],
  };

  const [total, data] = await Promise.all([
    AuditLogModel.countDocuments(filter),
    AuditLogModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      //never expose IP / user agent to farm users
      .select("logNo action event entityType oldData newData changedFields status createdAt userId")
      .populate("userId", "userId fullName")
      .lean(),
  ]);

  return { meta: pageMeta(page, limit, total), data };
};

export const PregnancyServices = {
  createPregnancy,
  getFarmPregnancies,
  getAnimalPregnancies,
  getPregnancyAnalytics,
  getEligibleBreedings,
  getPregnancy,
  getAuditLogs,
  deliverPregnancy,
  recordPregnancyOutcome,
  updatePregnancy,
  deletePregnancy,
};
