import status from "http-status";
import mongoose, { isValidObjectId, Types } from "mongoose";
import type { ClientSession } from "mongoose";
import AppError from "../../errors/AppError.js";
import { AnimalModel } from "../animal/animal.model.js";
import { AnimalHealthStatuses, AnimalLifeStatuses } from "../animal/animal.constants.js";
import { AuditLogModel } from "../auditLog/auditLog.model.js";
import { AuditActions, AuditEntityTypes, AuditModules } from "../auditLog/auditLog.constants.js";
import type { TAuditAction } from "../auditLog/auditLog.interface.js";
import { recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext } from "../auditLog/auditLog.utils.js";
import { DiseaseModel } from "../disease/disease.model.js";
import { FarmModel } from "../farm/farm.model.js";
import { FarmStatuses } from "../farm/farm.constants.js";
import { FarmMemberModel } from "../farmMember/farmMember.model.js";
import type { TFarmMemberRole } from "../farmMember/farmMember.interface.js";
import { FarmMemberServices } from "../farmMember/farmMember.service.js";
import {
  escapeRegex,
  executeAtomically,
  isBlank,
  pageMeta,
  parseCalendarDate,
  parseDateRange,
  parseEnumList,
  parseNumber,
  parsePaging,
} from "../feedRecord/feedRecord.utils.js";
import type { TPayload, TUndo } from "../feedRecord/feedRecord.utils.js";
import {
  InventoryItemTypes,
  InventoryReferenceTypes,
  InventoryTransactionTypes,
} from "../inventory/inventory.constants.js";
import type { TInventoryUnit } from "../inventory/inventory.interface.js";
import { InventoryModel, InventoryTransactionModel } from "../inventory/inventory.model.js";
import { applyStockChange, generateTransactionNo, isUnusableInventory } from "../inventory/inventory.utils.js";
import {
  MEDICINE_ROUTE_COMPATIBILITY,
  MedicineAdministrationRouteLabels,
  MedicineAdministrationRoutes,
} from "../medicine/medicine.constants.js";
import { MedicineModel } from "../medicine/medicine.model.js";
import {
  CONSUMABLE_STATUSES,
  DEFAULT_FOLLOW_UP_DAYS,
  DELETABLE_STATUSES,
  DOSAGE_UNIT_COMPATIBILITY,
  DUPLICATE_WINDOW_DAYS,
  DURATION_SUGGESTIONS,
  FREQUENCY_SUGGESTIONS,
  FUTURE_TOLERANCE_HOURS,
  MAX_ANIMAL_HISTORY,
  MAX_BACKDATE_DAYS,
  MAX_CONSUME_QUANTITY,
  MAX_DOSAGE,
  MAX_ESTIMATED_COST,
  MAX_FOLLOW_UP_AHEAD_DAYS,
  MAX_FOLLOW_UP_DAYS,
  MAX_LIST_LIMIT,
  MAX_MEDICINES,
  MAX_SHORT_TEXT,
  MAX_SYMPTOM_LENGTH,
  MAX_SYMPTOMS,
  MAX_TEXT_LENGTH,
  OPEN_STATUSES,
  PRESCRIBER_ROLES,
  REOPEN_FROM,
  SERVER_MANAGED_FIELDS,
  TREATED_BY_ROLES,
  TREATMENT_NO_PATTERN,
  TREATMENT_TRANSITIONS,
  TreatmentDosageUnits,
  TreatmentPermissions,
  TreatmentStatuses,
  WITHDRAWAL_LOOKBACK_DAYS,
} from "./treatment.constants.js";
import type { TTreatment, TTreatmentMedicine, TTreatmentStatus } from "./treatment.interface.js";
import { TreatmentModel } from "./treatment.model.js";
import {
  addDays,
  computeWithdrawals,
  DAY_MS,
  dayKey,
  daysBetween,
  generateTreatmentNo,
  startOfTodayUtc,
} from "./treatment.utils.js";
import type { TWithdrawalMedicine, TWithdrawalTreatment } from "./treatment.utils.js";

const STATUSES = Object.values(TreatmentStatuses) as string[];
const DOSAGE_UNITS = Object.values(TreatmentDosageUnits) as string[];
const ROUTES = Object.values(MedicineAdministrationRoutes) as string[];
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
const round2 = (value: number) => Math.round(value * 100) / 100;
const sessionOpts = (session: ClientSession | null) => (session ? { session } : {});

type TTreatmentDoc = TTreatment & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

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

const can = (access: TAccess, allowed: readonly string[]) => allowed.includes(access.role);

const requireRole = (access: TAccess, allowed: readonly string[], action: string) => {
  if (!can(access, allowed)) {
    throw new AppError(status.FORBIDDEN, `Your farm role (${access.role}) is not allowed to ${action}!`);
  }
};

/** Setup / Suspended / Inactive farms cannot write treatments (records stay readable). */
const requireWritableFarm = (access: TAccess) => {
  if (access.farmStatus !== FarmStatuses.ACTIVE) {
    throw new AppError(
      status.FORBIDDEN,
      `This farm is ${access.farmStatus} — treatments can only be written on an Active farm!`,
    );
  }
};

//createdBy / stock movements are signed by a FarmMember row
const requireMemberRow = (access: TAccess): Types.ObjectId => {
  if (!access.memberObjectId) {
    throw new AppError(status.FORBIDDEN, "An active farm membership is required to write treatment records!");
  }
  return access.memberObjectId;
};

const rejectServerFields = (body: TPayload, allowCompletedDate = false) => {
  const sent = SERVER_MANAGED_FIELDS.filter(
    (field) => field in body && !(allowCompletedDate && field === "completedDate"),
  );
  if (sent.length) {
    throw new AppError(status.BAD_REQUEST, `${sent.join(", ")} cannot be sent — the server manages these values.`);
  }
};

/* -------------------------------------------------------------------------- */
/*                               Field parsing                                */
/* -------------------------------------------------------------------------- */

const parseText = (field: string, value: unknown, max = MAX_TEXT_LENGTH): string | undefined => {
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

/** Observed symptoms: trimmed, de-duplicated case-insensitively, capped. */
const parseSymptoms = (value: unknown): string[] => {
  if (isBlank(value)) return [];
  if (!Array.isArray(value)) throw new AppError(status.BAD_REQUEST, "symptoms must be a list of text!");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const text = parseText("symptoms[]", raw, MAX_SYMPTOM_LENGTH);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  if (out.length > MAX_SYMPTOMS) throw new AppError(status.BAD_REQUEST, `At most ${MAX_SYMPTOMS} symptoms can be recorded!`);
  return out;
};

const parseCost = (value: unknown): number | null =>
  isBlank(value) ? null : round2(parseNumber("estimatedCost", value, { min: 0, max: MAX_ESTIMATED_COST }));

const FUTURE_MS = FUTURE_TOLERANCE_HOURS * 60 * 60 * 1000;

/**
 * diagnosisDate (spec §17–20): calendar day, backdating allowed (≤ MAX_BACKDATE_DAYS),
 * never in the future, never before the animal's birth date.
 */
const parseDiagnosisDate = (value: unknown, birthDate?: Date | null): Date => {
  const date = parseCalendarDate("diagnosisDate", value);
  const now = Date.now();
  if (date.getTime() > now + FUTURE_MS) {
    throw new AppError(status.BAD_REQUEST, "diagnosisDate cannot be in the future!");
  }
  if (date.getTime() < now - MAX_BACKDATE_DAYS * DAY_MS) {
    throw new AppError(status.BAD_REQUEST, `diagnosisDate cannot be more than ${MAX_BACKDATE_DAYS} days in the past!`);
  }
  if (birthDate && date.getTime() < new Date(dayKey(birthDate)).getTime()) {
    throw new AppError(status.BAD_REQUEST, "diagnosisDate cannot be before the animal's birth date!");
  }
  return date;
};

/** followUpDate (spec §57): on/after the diagnosis day, at most MAX_FOLLOW_UP_AHEAD_DAYS ahead. */
const parseFollowUpDate = (value: unknown, diagnosisDate: Date): Date | null => {
  if (value === null || isBlank(value)) return null;
  const date = parseCalendarDate("followUpDate", value);
  if (date < diagnosisDate) throw new AppError(status.BAD_REQUEST, "followUpDate cannot be before the diagnosis date!");
  if (date.getTime() > Date.now() + MAX_FOLLOW_UP_AHEAD_DAYS * DAY_MS) {
    throw new AppError(status.BAD_REQUEST, `followUpDate cannot be more than ${MAX_FOLLOW_UP_AHEAD_DAYS} days ahead!`);
  }
  return date;
};

/** completedDate (spec §59–60): on/after diagnosis, never in the future; defaults to today. */
const parseCompletedDate = (value: unknown, diagnosisDate: Date): Date => {
  const date = isBlank(value) ? startOfTodayUtc() : parseCalendarDate("completedDate", value);
  if (date.getTime() > Date.now() + FUTURE_MS) throw new AppError(status.BAD_REQUEST, "completedDate cannot be in the future!");
  if (date < diagnosisDate) throw new AppError(status.BAD_REQUEST, "completedDate cannot be before the diagnosis date!");
  return date;
};

/* -------------------------------------------------------------------------- */
/*                               Reference lookups                            */
/* -------------------------------------------------------------------------- */

type TAnimalRef = {
  _id: Types.ObjectId;
  animalCode: string;
  name?: string;
  gender?: string;
  lifeStatus: string;
  healthStatus: string;
  birthDate?: Date | null;
};

const ANIMAL_FIELDS = "animalCode name gender lifeStatus healthStatus birthDate";

//animal reference: Mongo _id or the farm's animalCode (AN-000001), always farm-scoped
const findAnimal = async (access: TAccess, ref: unknown): Promise<TAnimalRef> => {
  const value = String(ref ?? "").trim();
  if (!value) throw new AppError(status.BAD_REQUEST, "animalId is required!");
  const animal = await AnimalModel.findOne(
    isValidObjectId(value)
      ? { _id: new Types.ObjectId(value), farmId: access.farmObjectId }
      : { animalCode: value.toUpperCase(), farmId: access.farmObjectId },
  )
    .select(ANIMAL_FIELDS)
    .lean();
  //an animal of another farm is reported as missing (farm isolation, spec §10)
  if (!animal) throw new AppError(status.NOT_FOUND, "Animal not found in this farm!");
  return animal as unknown as TAnimalRef;
};

//new episodes only for Active animals (Quarantine is a health status and is allowed)
const requireTreatableAnimal = (animal: TAnimalRef) => {
  if (animal.lifeStatus !== AnimalLifeStatuses.ACTIVE) {
    throw new AppError(
      status.CONFLICT,
      `${animal.animalCode} is ${animal.lifeStatus} — treatments can only be started for Active animals!`,
    );
  }
};

type TDiseaseRef = {
  _id: Types.ObjectId;
  diseaseCode: string;
  diseaseName: string;
  category?: string;
  severity?: string;
  contagious?: boolean;
  symptoms?: string[];
  isActive: boolean;
};

const DISEASE_FIELDS = "diseaseCode diseaseName category severity contagious symptoms isActive";

//disease reference: Mongo _id or diseaseCode (DIS-00001)
const findDisease = async (ref: unknown): Promise<TDiseaseRef> => {
  const value = String(ref ?? "").trim();
  if (!value) throw new AppError(status.BAD_REQUEST, "diseaseId is required!");
  const disease = await DiseaseModel.findOne(
    isValidObjectId(value) ? { _id: new Types.ObjectId(value) } : { diseaseCode: value.toUpperCase() },
  )
    .select(DISEASE_FIELDS)
    .lean();
  if (!disease) throw new AppError(status.NOT_FOUND, "Disease not found in the disease catalog!");
  return disease as unknown as TDiseaseRef;
};

const requireActiveDisease = (disease: TDiseaseRef) => {
  if (!disease.isActive) {
    throw new AppError(status.CONFLICT, `${disease.diseaseName} is deactivated in the disease catalog and cannot be used for a new treatment!`);
  }
};

type TMedicineRef = {
  _id: Types.ObjectId;
  medicineCode: string;
  medicineName: string;
  genericName?: string;
  dosageForm: string;
  strength?: string;
  administrationRoute: string;
  withdrawalPeriodDays: number;
  prescriptionRequired: boolean;
  isActive: boolean;
};

const MEDICINE_FIELDS =
  "medicineCode medicineName genericName dosageForm strength administrationRoute withdrawalPeriodDays prescriptionRequired isActive";

//medicine references: Mongo _id or medicineCode (MED-00001), resolved in one query
const findMedicines = async (refs: string[]): Promise<Map<string, TMedicineRef>> => {
  const ids = refs.filter((r) => isValidObjectId(r)).map((r) => new Types.ObjectId(r));
  const codes = refs.filter((r) => !isValidObjectId(r)).map((r) => r.toUpperCase());
  const or: Record<string, unknown>[] = [];
  if (ids.length) or.push({ _id: { $in: ids } });
  if (codes.length) or.push({ medicineCode: { $in: codes } });
  const rows = or.length ? await MedicineModel.find({ $or: or }).select(MEDICINE_FIELDS).lean() : [];
  const map = new Map<string, TMedicineRef>();
  for (const row of rows as unknown as TMedicineRef[]) {
    map.set(String(row._id), row);
    map.set(row.medicineCode.toUpperCase(), row);
  }
  return map;
};

type TMemberRef = { _id: Types.ObjectId; role: string };

//treatedBy must be an active member of THIS farm whose role may treat animals
const resolveTreatedBy = async (access: TAccess, ref: unknown): Promise<TMemberRef> => {
  if (isBlank(ref)) {
    const me = requireMemberRow(access);
    if (!TREATED_BY_ROLES.includes(access.role)) {
      throw new AppError(status.BAD_REQUEST, "Choose who is treating the animal (treatedBy)!");
    }
    return { _id: me, role: access.role };
  }
  const value = String(ref).trim();
  if (!isValidObjectId(value)) throw new AppError(status.BAD_REQUEST, "treatedBy must be a farm member id!");
  const member = await FarmMemberModel.findOne({
    _id: new Types.ObjectId(value),
    farmId: access.farmObjectId,
    isActive: true,
  })
    .select("_id role")
    .lean();
  if (!member) throw new AppError(status.BAD_REQUEST, "treatedBy must be an active member of this farm!");
  if (!TREATED_BY_ROLES.includes(member.role)) {
    throw new AppError(status.BAD_REQUEST, `A ${member.role} cannot be recorded as the person treating the animal!`);
  }
  return { _id: member._id as Types.ObjectId, role: member.role };
};

/* -------------------------------------------------------------------------- */
/*                          Medicine-line validation                          */
/* -------------------------------------------------------------------------- */

type TParsedLines = {
  lines: TTreatmentMedicine[];
  medicines: Map<string, TMedicineRef>;
  prescriptionMedicines: TMedicineRef[];
};

/**
 * Validates medicines[] (spec §29–41): every medicine exists (and is active unless it
 * was already on this episode), dosage > 0, the dose unit fits the dosage form and the
 * route is compatible with Medicine.dosageForm. One line per medicine.
 */
const parseMedicineLines = async (
  value: unknown,
  options: { keepInactive?: Set<string>; previous?: TTreatmentMedicine[] } = {},
): Promise<TParsedLines> => {
  if (!Array.isArray(value) || !value.length) {
    throw new AppError(status.BAD_REQUEST, "Add at least one medicine to the treatment!");
  }
  if (value.length > MAX_MEDICINES) {
    throw new AppError(status.BAD_REQUEST, `At most ${MAX_MEDICINES} medicines per treatment!`);
  }
  const raw = value as TPayload[];
  const refs = raw.map((line, i) => {
    const ref = String(line?.medicineId ?? "").trim();
    if (!ref) throw new AppError(status.BAD_REQUEST, `medicines[${i}].medicineId is required!`);
    return ref;
  });
  const found = await findMedicines(refs);

  const lines: TTreatmentMedicine[] = [];
  const used = new Set<string>();
  const byId = new Map<string, TMedicineRef>();
  for (const [i, line] of raw.entries()) {
    const label = `medicines[${i}]`;
    const ref = refs[i]!;
    const medicine = found.get(isValidObjectId(ref) ? ref : ref.toUpperCase());
    if (!medicine) throw new AppError(status.NOT_FOUND, `${label}: medicine ${ref} not found in the medicine catalog!`);
    const id = String(medicine._id);
    if (!medicine.isActive && !options.keepInactive?.has(id)) {
      throw new AppError(status.CONFLICT, `${medicine.medicineName} is retired from the medicine catalog and cannot be prescribed!`);
    }
    if (used.has(id)) {
      throw new AppError(status.BAD_REQUEST, `${medicine.medicineName} is listed twice — combine it into one line.`);
    }
    used.add(id);
    byId.set(id, medicine);

    const dosage = round4(parseNumber(`${label}.dosage`, line.dosage, { min: 0, max: MAX_DOSAGE, exclusiveMin: true }));
    const dosageUnit = String(line.dosageUnit ?? "");
    if (!DOSAGE_UNITS.includes(dosageUnit)) {
      throw new AppError(status.BAD_REQUEST, `${label}.dosageUnit must be one of: ${DOSAGE_UNITS.join(", ")}!`);
    }
    const unitsForForm = DOSAGE_UNIT_COMPATIBILITY[medicine.dosageForm] ?? DOSAGE_UNITS;
    if (!unitsForForm.includes(dosageUnit)) {
      throw new AppError(
        status.BAD_REQUEST,
        `${medicine.medicineName} is a ${medicine.dosageForm} — dose it in ${unitsForForm.join(", ")}, not ${dosageUnit}.`,
      );
    }
    const route = String(line.administrationRoute ?? medicine.administrationRoute ?? "");
    if (!ROUTES.includes(route)) {
      throw new AppError(status.BAD_REQUEST, `${label}.administrationRoute must be one of: ${ROUTES.join(", ")}!`);
    }
    const routesForForm = MEDICINE_ROUTE_COMPATIBILITY[medicine.dosageForm] ?? ROUTES;
    if (!routesForForm.includes(route)) {
      throw new AppError(
        status.BAD_REQUEST,
        `${medicine.medicineName} (${medicine.dosageForm}) cannot be given ${MedicineAdministrationRouteLabels[route] ?? route} — allowed: ${routesForForm.join(", ")}.`,
      );
    }
    const frequency = parseText(`${label}.frequency`, line.frequency, MAX_SHORT_TEXT);
    if (!frequency) throw new AppError(status.BAD_REQUEST, `${label}.frequency is required (e.g. "Twice daily")!`);
    const duration = parseText(`${label}.duration`, line.duration, MAX_SHORT_TEXT);
    if (!duration) throw new AppError(status.BAD_REQUEST, `${label}.duration is required (e.g. "5 days")!`);
    const instructions = parseText(`${label}.instructions`, line.instructions);

    //keep the line _id when the same medicine stays on the episode (stable references)
    const previous = options.previous?.find((p) => String(p.medicineId) === id);
    lines.push({
      ...(previous?._id ? { _id: previous._id } : {}),
      medicineId: medicine._id,
      dosage,
      dosageUnit: dosageUnit as TTreatmentMedicine["dosageUnit"],
      frequency,
      duration,
      administrationRoute: route as TTreatmentMedicine["administrationRoute"],
      ...(instructions ? { instructions } : {}),
    });
  }
  return {
    lines,
    medicines: byId,
    prescriptionMedicines: [...byId.values()].filter((m) => m.prescriptionRequired),
  };
};

/**
 * Prescription rule (spec §77/§108): a prescription-only medicine needs an authorized
 * prescriber (Owner / Manager / Veterinarian) as either the person recording or the
 * person treating. A warning is added when no Veterinarian is involved at all.
 */
const enforcePrescriptionRule = (
  access: TAccess,
  treatedBy: TMemberRef,
  prescriptionMedicines: TMedicineRef[],
  warnings: string[],
) => {
  if (!prescriptionMedicines.length) return;
  const names = prescriptionMedicines.map((m) => m.medicineName).join(", ");
  if (!PRESCRIBER_ROLES.includes(access.role) && !PRESCRIBER_ROLES.includes(treatedBy.role)) {
    throw new AppError(
      status.FORBIDDEN,
      `${names} ${prescriptionMedicines.length > 1 ? "are" : "is"} prescription-only — the treatment must be recorded or handled by an Owner, Manager or Veterinarian.`,
    );
  }
  if (access.role !== "Veterinarian" && treatedBy.role !== "Veterinarian") {
    warnings.push(`${names}: prescription-only medicine recorded without a Veterinarian — make sure a vet authorized this plan.`);
  }
};

/* -------------------------------------------------------------------------- */
/*                         Animal health-status sync                          */
/* -------------------------------------------------------------------------- */

type THealthChange = { from: string; to: string } | null;

/**
 * Keeps Animal.healthStatus consistent with ALL of the animal's episodes (spec §69–71, §96–98):
 *  - any Ongoing treatment            → Under Treatment (Quarantine is never overwritten)
 *  - none Ongoing, one still Referred → unchanged (the case is with an external vet)
 *  - none open after Recovered        → Healthy (from Under Treatment / Sick)
 *  - none open after Cancel / Delete  → Healthy only if WE had set Under Treatment
 */
const syncAnimalHealth = async (
  access: TAccess,
  animalId: Types.ObjectId,
  trigger: "Created" | "Recovered" | "Referred" | "Cancelled" | "Reopened" | "Deleted",
  session: ClientSession | null,
  undo: TUndo,
): Promise<THealthChange> => {
  const animal = await AnimalModel.findOne({ _id: animalId, farmId: access.farmObjectId })
    .select("healthStatus")
    .session(session)
    .lean();
  if (!animal) return null;
  const current = animal.healthStatus as string;
  if (current === AnimalHealthStatuses.QUARANTINE) return null;

  const [ongoing, referred] = await Promise.all([
    TreatmentModel.countDocuments({ farmId: access.farmObjectId, animalId, status: TreatmentStatuses.ONGOING }).session(session),
    TreatmentModel.countDocuments({ farmId: access.farmObjectId, animalId, status: TreatmentStatuses.REFERRED }).session(session),
  ]);

  let target = current;
  if (ongoing > 0) target = AnimalHealthStatuses.UNDER_TREATMENT;
  else if (referred > 0) target = current;
  else if (trigger === "Recovered") {
    if (current === AnimalHealthStatuses.UNDER_TREATMENT || current === AnimalHealthStatuses.SICK) target = AnimalHealthStatuses.HEALTHY;
  } else if (trigger === "Cancelled" || trigger === "Deleted") {
    if (current === AnimalHealthStatuses.UNDER_TREATMENT) target = AnimalHealthStatuses.HEALTHY;
  }
  if (target === current) return null;

  await AnimalModel.updateOne({ _id: animalId }, { $set: { healthStatus: target } }, sessionOpts(session));
  undo.push(() => AnimalModel.updateOne({ _id: animalId }, { $set: { healthStatus: current } }));
  return { from: current, to: target };
};

/* -------------------------------------------------------------------------- */
/*                             Inventory integration                          */
/* -------------------------------------------------------------------------- */

//inventory "piece" rows hold countable forms (tablet, bolus, sachet, single dose)
const unitsMatch = (inventoryUnit: string | null | undefined, dosageUnit: string) =>
  !!inventoryUnit &&
  (inventoryUnit === dosageUnit ||
    (inventoryUnit === "piece" && ["tablet", "bolus", "sachet", "dose"].includes(dosageUnit)));

type TConsumePlan = {
  lineId: Types.ObjectId | null;
  medicineId: Types.ObjectId;
  medicineName: string;
  inventoryId: Types.ObjectId;
  inventoryCode: string | null;
  itemName: string;
  unit: string | null;
  quantity: number;
  stockBefore: number;
  expiryDate: Date | null;
};

type TMovement = {
  transactionNo: string;
  transactionType: string;
  inventoryCode: string | null;
  itemName: string;
  quantity: number;
  unit: string | null;
  stockBefore: number;
  stockAfter: number;
};

type TLedgerNet = {
  inventoryId: Types.ObjectId;
  medicineId: string | null;
  inventoryCode: string | null;
  itemName: string;
  unit: string | null;
  net: number;
};

/** Net stock drawn by an episode: Treatment Usage minus Return, per inventory row. */
const loadLedgerNet = async (access: TAccess, recordId: Types.ObjectId, session: ClientSession | null = null) => {
  const rows = await InventoryTransactionModel.find({
    farmId: access.farmObjectId,
    referenceType: InventoryReferenceTypes.TREATMENT,
    referenceId: recordId,
  })
    .select("inventoryId transactionType quantity unit")
    .populate("inventoryId", "inventoryCode itemName unit referenceId")
    .session(session)
    .lean();
  const net = new Map<string, TLedgerNet>();
  for (const row of rows) {
    const inv = row.inventoryId as unknown as {
      _id: Types.ObjectId;
      inventoryCode?: string;
      itemName?: string;
      unit?: string;
      referenceId?: Types.ObjectId | null;
    } | null;
    if (!inv?._id) continue;
    const key = String(inv._id);
    const entry = net.get(key) ?? {
      inventoryId: inv._id,
      medicineId: inv.referenceId ? String(inv.referenceId) : null,
      inventoryCode: inv.inventoryCode ?? null,
      itemName: inv.itemName ?? "Medicine stock",
      unit: inv.unit ?? row.unit ?? null,
      net: 0,
    };
    const sign = row.transactionType === InventoryTransactionTypes.RETURN ? -1 : 1;
    entry.net = round4(entry.net + sign * row.quantity);
    net.set(key, entry);
  }
  return { hasLedger: rows.length > 0, lines: [...net.values()].filter((l) => l.net > 0) };
};

/** Returns everything an episode still holds to stock ("Return" ledger rows). */
const restoreStock = async (
  access: TAccess,
  recordId: Types.ObjectId,
  lines: TLedgerNet[],
  options: { session: ClientSession | null; undo: TUndo; memberId: Types.ObjectId; remarks: string },
): Promise<TMovement[]> => {
  const movements: TMovement[] = [];
  for (const line of lines) {
    const change = await applyStockChange(line.inventoryId, line.net, {
      session: options.session,
      updatedBy: options.memberId,
    });
    if (!change || change.applied === 0) continue;
    const inventoryId = line.inventoryId;
    const applied = change.applied;
    options.undo.push(() => applyStockChange(inventoryId, -applied, { session: null, capAtZero: true }));
    const transactionNo = await generateTransactionNo();
    const [trx] = await InventoryTransactionModel.create(
      [
        {
          transactionNo,
          farmId: access.farmObjectId,
          inventoryId,
          transactionType: InventoryTransactionTypes.RETURN,
          transactionDate: new Date(),
          quantity: applied,
          ...(line.unit ? { unit: line.unit as TInventoryUnit } : {}),
          referenceType: InventoryReferenceTypes.TREATMENT,
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
      transactionType: InventoryTransactionTypes.RETURN,
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
    .populate(
      "animalId",
      detail ? "animalCode name gender lifeStatus healthStatus birthDate profilePhoto purpose" : "animalCode name lifeStatus healthStatus",
    )
    .populate("diseaseId", detail ? `${DISEASE_FIELDS} prevention description` : "diseaseCode diseaseName severity contagious")
    .populate(
      "medicines.medicineId",
      detail ? `${MEDICINE_FIELDS} brandName manufacturer category storageCondition` : "medicineCode medicineName dosageForm withdrawalPeriodDays",
    )
    .populate({ path: "treatedBy", ...MEMBER_POPULATE })
    .populate({ path: "createdBy", ...MEMBER_POPULATE }) as unknown as T;
};

//record reference: Mongo _id or TRT-YYYY-NNNNNN, always farm-scoped
const findRecord = async (access: TAccess, ref: string): Promise<TTreatmentDoc> => {
  const value = String(ref ?? "").trim();
  let filter: Record<string, unknown>;
  if (isValidObjectId(value)) filter = { _id: new Types.ObjectId(value) };
  else if (TREATMENT_NO_PATTERN.test(value)) filter = { treatmentNo: value.toUpperCase() };
  else throw new AppError(status.BAD_REQUEST, "Use a treatment id or a TRT-YYYY-NNNNNN number!");
  const doc = await TreatmentModel.findOne({ ...filter, farmId: access.farmObjectId }).lean();
  if (!doc) throw new AppError(status.NOT_FOUND, "Treatment not found in this farm!");
  return doc as unknown as TTreatmentDoc;
};

const ledgerRows = (farmObjectId: Types.ObjectId, recordId: Types.ObjectId) =>
  InventoryTransactionModel.find({
    farmId: farmObjectId,
    referenceType: InventoryReferenceTypes.TREATMENT,
    referenceId: recordId,
  })
    .sort({ createdAt: 1 })
    .select("transactionNo transactionType transactionDate quantity unit remarks inventoryId performedBy createdAt")
    .populate("inventoryId", "inventoryCode itemName unit currentStock status expiryDate referenceId")
    .populate({ path: "performedBy", ...MEMBER_POPULATE })
    .lean();

/** Derived follow-up / duration flags (never stored). */
const derive = (record: {
  status: string;
  diagnosisDate: Date;
  followUpDate?: Date | null;
  completedDate?: Date | null;
}) => {
  const today = startOfTodayUtc();
  const isOpen = OPEN_STATUSES.includes(record.status);
  const followUpDueInDays = record.followUpDate ? daysBetween(today, new Date(record.followUpDate)) : null;
  let followUpState: "Overdue" | "Today" | "Upcoming" | null = null;
  if (isOpen && followUpDueInDays !== null) {
    followUpState = followUpDueInDays < 0 ? "Overdue" : followUpDueInDays === 0 ? "Today" : "Upcoming";
  }
  const end = record.completedDate ? new Date(record.completedDate) : isOpen ? today : null;
  return {
    isOpen,
    followUpDueInDays,
    followUpState,
    isFollowUpOverdue: followUpState === "Overdue",
    //episode length in days (diagnosis → completion, or → today while open)
    treatmentDays: end ? Math.max(0, daysBetween(new Date(record.diagnosisDate), end)) : null,
  };
};

const medicineMapFor = async (ids: unknown[]) => {
  const unique = [...new Set(ids.map(String))].filter((id) => isValidObjectId(id)).map((id) => new Types.ObjectId(id));
  const rows = unique.length
    ? await MedicineModel.find({ _id: { $in: unique } }).select("medicineCode medicineName withdrawalPeriodDays").lean()
    : [];
  return new Map(rows.map((m) => [String(m._id), m as unknown as TWithdrawalMedicine]));
};

//line.medicineId may be populated or a raw id
const medicineIdOf = (value: unknown) =>
  String((value as { _id?: unknown } | null)?._id ?? value ?? "");

const loadDetail = async (access: TAccess, id: Types.ObjectId) => {
  const [record, inventoryTransactions, ledger] = await Promise.all([
    populateRecord(TreatmentModel.findById(id).select("-__v"), true).lean(),
    ledgerRows(access.farmObjectId, id),
    loadLedgerNet(access, id),
  ]);
  const r = record as unknown as TTreatmentDoc;
  const medicineOf = await medicineMapFor(r.medicines.map((m) => medicineIdOf(m.medicineId)));
  const withdrawal = computeWithdrawals(
    [{ ...(r as unknown as TWithdrawalTreatment), medicines: r.medicines.map((m) => ({ ...m, medicineId: medicineIdOf(m.medicineId) })) }],
    medicineOf,
  );
  //stock drawn per medicine (net of returns)
  const consumed = ledger.lines.map((l) => ({
    medicineId: l.medicineId,
    inventoryId: l.inventoryId,
    inventoryCode: l.inventoryCode,
    itemName: l.itemName,
    unit: l.unit,
    quantity: l.net,
  }));
  return {
    ...(record as Record<string, unknown>),
    ...derive(r),
    withdrawal,
    stockConsumed: consumed,
    hasStockMovements: ledger.hasLedger,
    inventoryTransactions,
  };
};

const auditSnapshot = (record: Partial<TTreatment>) => ({
  treatmentNo: record.treatmentNo,
  animalId: record.animalId,
  diseaseId: record.diseaseId,
  diagnosisDate: record.diagnosisDate,
  symptoms: record.symptoms ?? [],
  treatedBy: record.treatedBy,
  medicines: (record.medicines ?? []).map((m) => ({
    medicineId: m.medicineId,
    dosage: m.dosage,
    dosageUnit: m.dosageUnit,
    frequency: m.frequency,
    duration: m.duration,
    administrationRoute: m.administrationRoute,
    instructions: m.instructions ?? null,
  })),
  estimatedCost: record.estimatedCost ?? null,
  status: record.status,
  followUpDate: record.followUpDate ?? null,
  completedDate: record.completedDate ?? null,
  remarks: record.remarks ?? null,
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
    entityType: AuditEntityTypes.TREATMENT,
    entityId,
    action,
    module: AuditModules.HEALTH,
    event,
    oldData,
    newData,
    changedFields,
  });

/** Audit trace of an attempt, for the Rolled Back row. */
const traceOf = (
  context: TAuditContext | undefined,
  farmId: Types.ObjectId,
  entityId: Types.ObjectId | null,
  action: TAuditAction,
  event: string,
) => ({ context, farmId, entityType: AuditEntityTypes.TREATMENT, entityId, action, module: AuditModules.HEALTH, event });

//keeps a short outcome trail in remarks without exceeding the field limit
const appendRemark = (existing: string | undefined, tag: string, note: string | undefined) => {
  if (!note) return existing;
  const entry = `[${tag}] ${note}`;
  const combined = existing ? `${existing}\n${entry}` : entry;
  return combined.length > MAX_TEXT_LENGTH ? entry.slice(0, MAX_TEXT_LENGTH) : combined;
};

/* -------------------------------------------------------------------------- */
/*                                   Create                                   */
/* -------------------------------------------------------------------------- */

/**
 * Possible accidental duplicate (spec §99/§135): same animal + disease with an open
 * episode, or a non-cancelled one diagnosed within ±DUPLICATE_WINDOW_DAYS. Repeated
 * episodes are legitimate, so this only blocks until the caller confirms.
 */
const findPossibleDuplicate = (
  access: TAccess,
  animalId: Types.ObjectId,
  diseaseId: Types.ObjectId,
  diagnosisDate: Date,
  excludeId: Types.ObjectId | null = null,
) =>
  TreatmentModel.findOne({
    farmId: access.farmObjectId,
    animalId,
    diseaseId,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    $or: [
      { status: { $in: OPEN_STATUSES as TTreatmentStatus[] } },
      {
        status: { $ne: TreatmentStatuses.CANCELLED },
        diagnosisDate: {
          $gte: addDays(diagnosisDate, -DUPLICATE_WINDOW_DAYS),
          $lte: addDays(diagnosisDate, DUPLICATE_WINDOW_DAYS),
        },
      },
    ],
  })
    .select("treatmentNo status diagnosisDate")
    .lean();

/**
 * POST / — opens a new clinical episode (always Ongoing). Validates the animal (Active,
 * this farm), the disease and every medicine (active, route + unit compatible), the
 * prescription rule and timeline, then in ONE atomic unit saves the record and sets
 * Animal.healthStatus to "Under Treatment" (Quarantine is kept). No stock is touched —
 * medicine is drawn separately through POST /:id/consume-inventory (spec §73).
 */
const createTreatment = async (farmId: string, requesterUserId: string, payload: TPayload, context: TAuditContext) => {
  const body = payload ?? {};
  rejectServerFields(body);
  if ("status" in body) throw new AppError(status.BAD_REQUEST, "A new treatment always starts as Ongoing — do not send status.");
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, TreatmentPermissions.CREATE, "start treatments");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);

  const animal = await findAnimal(access, body.animalId);
  requireTreatableAnimal(animal);
  const disease = await findDisease(body.diseaseId);
  requireActiveDisease(disease);
  const diagnosisDate = parseDiagnosisDate(body.diagnosisDate, animal.birthDate);
  const followUpDate = parseFollowUpDate(body.followUpDate, diagnosisDate);
  const symptoms = parseSymptoms(body.symptoms);
  const treatedBy = await resolveTreatedBy(access, body.treatedBy);
  const { lines, prescriptionMedicines } = await parseMedicineLines(body.medicines);
  const estimatedCost = parseCost(body.estimatedCost);
  const remarks = parseText("remarks", body.remarks);

  const warnings: string[] = [];
  enforcePrescriptionRule(access, treatedBy, prescriptionMedicines, warnings);

  const duplicate = await findPossibleDuplicate(access, animal._id, disease._id, diagnosisDate);
  if (duplicate && body.confirmDuplicate !== true) {
    throw new AppError(
      status.CONFLICT,
      `Possible duplicate: ${animal.animalCode} already has ${disease.diseaseName} episode ${duplicate.treatmentNo} (${duplicate.status}, diagnosed ${dayKey(duplicate.diagnosisDate)}). Send confirmDuplicate: true if this is a new episode.`,
    );
  }
  if (duplicate) warnings.push(`Saved alongside ${duplicate.treatmentNo} (${duplicate.status}) — confirmed as a separate episode.`);
  if (disease.contagious && animal.healthStatus !== AnimalHealthStatuses.QUARANTINE) {
    warnings.push(`${disease.diseaseName} is contagious — consider moving ${animal.animalCode} to Quarantine.`);
  }
  if (followUpDate && followUpDate < startOfTodayUtc()) {
    warnings.push(`The follow-up date ${dayKey(followUpDate)} has already passed — it shows as overdue.`);
  }
  if (!symptoms.length) warnings.push("No observed symptoms were recorded for this episode.");

  const treatmentNo = await generateTreatmentNo();
  const data: TTreatment = {
    treatmentNo,
    farmId: access.farmObjectId,
    animalId: animal._id,
    diseaseId: disease._id,
    diagnosisDate,
    symptoms,
    treatedBy: treatedBy._id,
    medicines: lines,
    estimatedCost,
    status: TreatmentStatuses.ONGOING,
    followUpDate,
    completedDate: null,
    ...(remarks ? { remarks } : {}),
    createdBy: memberId,
  };

  const { record, health } = await executeAtomically(async (session, undo) => {
    const [doc] = await TreatmentModel.create([data], sessionOpts(session));
    if (!doc) throw new AppError(status.INTERNAL_SERVER_ERROR, "Failed to save the treatment!");
    undo.push(() => TreatmentModel.deleteOne({ _id: doc._id }));
    const change = await syncAnimalHealth(access, animal._id, "Created", session, undo);
    return { record: doc, health: change };
  }, {
    trace: traceOf(context, access.farmObjectId, null, AuditActions.CREATE, "Treatment Created"),
    log: async ({ record, health }) => {
      await audit(context, access.farmObjectId, record._id, AuditActions.CREATE, "Treatment Created", null, {
        ...auditSnapshot(data),
        animalHealthStatus: health,
      });
    },
  });

  const today = startOfTodayUtc();
  return {
    treatment: await loadDetail(access, record._id),
    animalHealthStatus: health ?? { from: animal.healthStatus, to: animal.healthStatus },
    //no Notification module yet: the reminder is derived and surfaced on /follow-ups
    followUpReminder: followUpDate ? { followUpDate, dueInDays: daysBetween(today, followUpDate) } : null,
    warnings,
  };
};

/* -------------------------------------------------------------------------- */
/*                              Status transitions                            */
/* -------------------------------------------------------------------------- */

/**
 * PATCH /:id/status — controlled lifecycle (spec §52–53, §66–68):
 *  Ongoing → Recovered (completedDate, default today) | Referred (referral note) | Cancelled (reason)
 *  Referred → Recovered | Cancelled | Ongoing (reopen)
 *  Recovered → Ongoing (reopen — Owner / Manager + reason)
 * Cancelling an episode that already drew stock requires `restoreStock` (true returns
 * it, false keeps it as used). Animal.healthStatus is recalculated across ALL of the
 * animal's episodes in the same atomic unit.
 */
const changeStatus = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, TreatmentPermissions.CHANGE_STATUS, "change treatment status");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);

  const target = String(body.status ?? "");
  if (!STATUSES.includes(target)) throw new AppError(status.BAD_REQUEST, `status must be one of: ${STATUSES.join(", ")}!`);
  const doc = await findRecord(access, id);
  if (doc.status === target) throw new AppError(status.CONFLICT, `This treatment is already ${target}!`);
  const allowed = TREATMENT_TRANSITIONS[doc.status] ?? [];
  if (!allowed.includes(target)) {
    throw new AppError(
      status.CONFLICT,
      doc.status === TreatmentStatuses.CANCELLED
        ? "A Cancelled treatment is closed — start a new treatment instead."
        : `A ${doc.status} treatment cannot be moved to ${target}.`,
    );
  }
  if (!isBlank(body.completedDate) && target !== TreatmentStatuses.RECOVERED) {
    throw new AppError(status.BAD_REQUEST, "completedDate is only set when marking a treatment Recovered.");
  }
  if (body.restoreStock !== undefined && target !== TreatmentStatuses.CANCELLED) {
    throw new AppError(status.BAD_REQUEST, "restoreStock only applies when cancelling a treatment.");
  }

  const reopening = target === TreatmentStatuses.ONGOING && REOPEN_FROM.includes(doc.status);
  const set: Record<string, unknown> = { status: target };
  let note: string | undefined;
  if (target === TreatmentStatuses.RECOVERED) {
    set.completedDate = parseCompletedDate(body.completedDate, new Date(doc.diagnosisDate));
    note = parseText("remarks", body.remarks);
  } else if (target === TreatmentStatuses.REFERRED) {
    note = requireReason("remarks", body.remarks, "refer a treatment (where / why it was referred)");
    set.completedDate = null;
  } else if (target === TreatmentStatuses.CANCELLED) {
    note = requireReason("remarks", body.remarks, "cancel a treatment (the reason)");
    set.completedDate = null;
  } else if (reopening) {
    requireRole(access, TreatmentPermissions.REOPEN, "reopen a closed treatment");
    note = requireReason("remarks", body.remarks, "reopen a treatment (the reason)");
    const animal = await findAnimal(access, String(doc.animalId));
    requireTreatableAnimal(animal);
    set.completedDate = null;
  }
  const tag = reopening ? "Reopened" : target;
  set.remarks = appendRemark(doc.remarks, tag, note) ?? doc.remarks ?? "";

  //stock reconciliation decision for a cancelled episode (spec §68/§98)
  const ledger = target === TreatmentStatuses.CANCELLED ? await loadLedgerNet(access, doc._id) : null;
  const holdsStock = !!ledger && ledger.lines.length > 0;
  if (holdsStock && typeof body.restoreStock !== "boolean") {
    throw new AppError(
      status.CONFLICT,
      `This treatment already drew medicine from stock (${ledger!.lines.map((l) => `${l.net} ${l.unit ?? ""} ${l.itemName}`).join(", ")}). Send restoreStock: true to return unused stock, or false if it was actually administered.`,
    );
  }

  const event = reopening ? "Treatment Reopened" : `Treatment ${target}`;
  const changed = Object.keys(set);
  const { health, movements } = await executeAtomically(async (session, undo) => {
    const updated = await TreatmentModel.findOneAndUpdate(
      { _id: doc._id, status: doc.status, updatedAt: doc.updatedAt },
      { $set: set },
      { returnDocument: "after", ...sessionOpts(session) },
    );
    if (!updated) throw new AppError(status.CONFLICT, "This treatment was changed by someone else. Reload and try again.");
    undo.push(() =>
      TreatmentModel.updateOne(
        { _id: doc._id },
        { $set: { status: doc.status, completedDate: doc.completedDate ?? null, remarks: doc.remarks ?? "" } },
      ),
    );
    let moved: TMovement[] = [];
    if (holdsStock && body.restoreStock === true) {
      moved = await restoreStock(access, doc._id, ledger!.lines, {
        session,
        undo,
        memberId,
        remarks: `${doc.treatmentNo} cancelled — unused medicine returned`,
      });
    }
    const change = await syncAnimalHealth(
      access,
      doc.animalId,
      reopening ? "Reopened" : (target as "Recovered" | "Referred" | "Cancelled"),
      session,
      undo,
    );
    return { health: change, movements: moved };
  }, {
    trace: traceOf(context, access.farmObjectId, doc._id, AuditActions.UPDATE, event),
    log: async ({ health, movements }) => {
      await audit(
        context,
        access.farmObjectId,
        doc._id,
        AuditActions.UPDATE,
        event,
        Object.fromEntries(changed.map((k) => [k, (doc as unknown as Record<string, unknown>)[k] ?? null])),
        {
          ...set,
          ...(movements.length ? { inventory: movements } : {}),
          ...(holdsStock ? { restoreStock: body.restoreStock } : {}),
          animalHealthStatus: health,
        },
        [...changed, ...(movements.length ? ["inventory"] : [])],
      );
    },
  });

  return {
    treatment: await loadDetail(access, doc._id),
    animalHealthStatus: health,
    stockMovements: movements,
  };
};

/* -------------------------------------------------------------------------- */
/*                          Medicine stock consumption                        */
/* -------------------------------------------------------------------------- */

/**
 * POST /:id/consume-inventory — records medicine physically drawn from farm stock
 * (spec §72–76, §109). Per item: the farm's Medicine stock row (FEFO among usable,
 * non-expired rows, or the chosen `inventoryId`), quantity in the row's unit (defaults
 * to the line dosage when the units match). Every item is checked first; then ONE
 * atomic unit deducts stock and writes "Treatment Usage" ledger rows — any failure
 * rolls everything back. Can be called again for later doses.
 */
const consumeInventory = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, TreatmentPermissions.CONSUME_INVENTORY, "record medicine usage");
  requireWritableFarm(access);
  const memberId = requireMemberRow(access);

  const doc = await findRecord(access, id);
  if (!CONSUMABLE_STATUSES.includes(doc.status)) {
    throw new AppError(status.CONFLICT, `A ${doc.status} treatment cannot draw medicine from stock!`);
  }
  if (!doc.medicines.length) throw new AppError(status.CONFLICT, "This treatment has no prescribed medicines.");
  const remarks = parseText("remarks", body.remarks);

  //which lines to draw: all prescribed lines by default
  type TRequest = { line: TTreatmentMedicine; quantity: number | null; inventoryId: Types.ObjectId | null };
  const requests: TRequest[] = [];
  if (isBlank(body.items)) {
    for (const line of doc.medicines) requests.push({ line, quantity: null, inventoryId: null });
  } else {
    if (!Array.isArray(body.items) || !body.items.length) throw new AppError(status.BAD_REQUEST, "items must be a non-empty list!");
    for (const [i, rawItem] of (body.items as TPayload[]).entries()) {
      const item = rawItem ?? {};
      const lineRef = String(item.lineId ?? "").trim();
      const medRef = String(item.medicineId ?? "").trim();
      let line: TTreatmentMedicine | undefined;
      if (lineRef) line = doc.medicines.find((m) => String(m._id) === lineRef);
      else if (medRef) {
        const medicines = await findMedicines([medRef]);
        const med = medicines.get(isValidObjectId(medRef) ? medRef : medRef.toUpperCase());
        line = med ? doc.medicines.find((m) => String(m.medicineId) === String(med._id)) : undefined;
      } else throw new AppError(status.BAD_REQUEST, `items[${i}] needs a lineId or medicineId!`);
      if (!line) throw new AppError(status.BAD_REQUEST, `items[${i}] is not a medicine prescribed on this treatment!`);
      const quantity = isBlank(item.quantity)
        ? null
        : round4(parseNumber(`items[${i}].quantity`, item.quantity, { min: 0, max: MAX_CONSUME_QUANTITY, exclusiveMin: true }));
      let inventoryId: Types.ObjectId | null = null;
      if (!isBlank(item.inventoryId)) {
        if (!isValidObjectId(String(item.inventoryId))) throw new AppError(status.BAD_REQUEST, `items[${i}].inventoryId is invalid!`);
        inventoryId = new Types.ObjectId(String(item.inventoryId));
      }
      requests.push({ line, quantity, inventoryId });
    }
  }

  const medicineOf = await findMedicines(requests.map((r) => String(r.line.medicineId)));
  const blockers: string[] = [];
  const plans: TConsumePlan[] = [];
  //stock already planned in this call, per inventory row
  const reserved = new Map<string, number>();
  for (const req of requests) {
    const medicine = medicineOf.get(String(req.line.medicineId));
    const name = medicine?.medicineName ?? "Medicine";
    const rows = await InventoryModel.find({
      farmId: access.farmObjectId,
      itemType: InventoryItemTypes.MEDICINE,
      referenceId: req.line.medicineId,
    })
      .select("inventoryCode itemName currentStock unit status expiryDate")
      .lean();
    if (!rows.length) {
      blockers.push(`${name} is not stocked in this farm's inventory.`);
      continue;
    }
    let candidates = rows.filter((row) => !isUnusableInventory(row));
    if (req.inventoryId) {
      const chosen = rows.find((row) => String(row._id) === String(req.inventoryId));
      if (!chosen) {
        blockers.push(`The chosen stock row is not ${name} stock of this farm.`);
        continue;
      }
      if (isUnusableInventory(chosen)) {
        blockers.push(`${chosen.inventoryCode} (${name}) is expired or inactive and cannot be used.`);
        continue;
      }
      candidates = [chosen];
    }
    if (!candidates.length) {
      blockers.push(`All ${name} stock is expired or inactive.`);
      continue;
    }
    //FEFO: the usable row expiring first
    candidates.sort((a, b) => {
      const ae = a.expiryDate ? new Date(a.expiryDate).getTime() : Number.MAX_SAFE_INTEGER;
      const be = b.expiryDate ? new Date(b.expiryDate).getTime() : Number.MAX_SAFE_INTEGER;
      return ae - be;
    });
    const quantityFor = (row: (typeof candidates)[number]) =>
      req.quantity ?? (unitsMatch(row.unit, req.line.dosageUnit) ? req.line.dosage : null);
    const available = (row: (typeof candidates)[number]) => round4(row.currentStock - (reserved.get(String(row._id)) ?? 0));
    const pick =
      candidates.find((row) => {
        const q = quantityFor(row);
        return q !== null && available(row) >= q;
      }) ?? candidates[0]!;
    const quantity = quantityFor(pick);
    if (quantity === null) {
      blockers.push(
        `${name}: the dose is in ${req.line.dosageUnit} but stock is counted in ${pick.unit} — send the quantity used in ${pick.unit}.`,
      );
      continue;
    }
    if (available(pick) < quantity) {
      blockers.push(`Insufficient ${name} stock: ${available(pick)} ${pick.unit} on hand, ${quantity} ${pick.unit} needed.`);
      continue;
    }
    reserved.set(String(pick._id), round4((reserved.get(String(pick._id)) ?? 0) + quantity));
    plans.push({
      lineId: req.line._id ?? null,
      medicineId: req.line.medicineId,
      medicineName: name,
      inventoryId: pick._id as Types.ObjectId,
      inventoryCode: pick.inventoryCode,
      itemName: pick.itemName,
      unit: pick.unit,
      quantity,
      stockBefore: pick.currentStock,
      expiryDate: pick.expiryDate ?? null,
    });
  }
  if (blockers.length) {
    throw new AppError(status.UNPROCESSABLE_ENTITY, `Medicine usage was not recorded: ${blockers.join(" ")}`);
  }

  const movements = await executeAtomically(async (session, undo) => {
    //the record must still be consumable when the stock moves
    const still = await TreatmentModel.findOne({ _id: doc._id, status: { $in: CONSUMABLE_STATUSES as TTreatmentStatus[] } })
      .select("_id")
      .session(session)
      .lean();
    if (!still) throw new AppError(status.CONFLICT, "This treatment was closed by someone else. Reload and try again.");
    const moved: TMovement[] = [];
    for (const plan of plans) {
      const change = await applyStockChange(plan.inventoryId, -plan.quantity, { session, updatedBy: memberId });
      if (!change) {
        throw new AppError(
          status.CONFLICT,
          `Stock of ${plan.itemName} changed while saving and is no longer sufficient (or it expired). Reload and try again.`,
        );
      }
      const inventoryId = plan.inventoryId;
      undo.push(() => applyStockChange(inventoryId, change.applied, { session: null, capAtZero: true }));
      const transactionNo = await generateTransactionNo();
      const [trx] = await InventoryTransactionModel.create(
        [
          {
            transactionNo,
            farmId: access.farmObjectId,
            inventoryId,
            transactionType: InventoryTransactionTypes.TREATMENT_USAGE,
            transactionDate: new Date(),
            quantity: change.applied,
            ...(plan.unit ? { unit: plan.unit as TInventoryUnit } : {}),
            referenceType: InventoryReferenceTypes.TREATMENT,
            referenceId: doc._id,
            remarks: `${doc.treatmentNo} — ${plan.medicineName}${remarks ? ` — ${remarks}` : ""}`,
            performedBy: memberId,
          },
        ],
        sessionOpts(session),
      );
      if (trx) undo.push(() => InventoryTransactionModel.deleteOne({ _id: trx._id }));
      moved.push({
        transactionNo,
        transactionType: InventoryTransactionTypes.TREATMENT_USAGE,
        inventoryCode: plan.inventoryCode,
        itemName: plan.itemName,
        quantity: change.applied,
        unit: plan.unit,
        stockBefore: change.before,
        stockAfter: change.after,
      });
    }
    return moved;
  }, {
    trace: traceOf(context, access.farmObjectId, doc._id, AuditActions.UPDATE, "Treatment Medicine Consumed"),
    log: async (movements) => {
      await audit(
        context,
        access.farmObjectId,
        doc._id,
        AuditActions.UPDATE,
        "Treatment Medicine Consumed",
        null,
        { treatmentNo: doc.treatmentNo, inventory: movements, ...(remarks ? { remarks } : {}) },
        ["inventory"],
      );
    },
  });

  return { treatment: await loadDetail(access, doc._id), stockMovements: movements };
};

/* -------------------------------------------------------------------------- */
/*                           Controlled correction                            */
/* -------------------------------------------------------------------------- */

const UPDATABLE_BY_STATUS: Record<string, string[]> = {
  Ongoing: ["diseaseId", "diagnosisDate", "symptoms", "treatedBy", "medicines", "estimatedCost", "followUpDate", "remarks", "reason"],
  Referred: ["followUpDate", "estimatedCost", "remarks", "reason"],
  Recovered: ["remarks", "reason"],
  Cancelled: ["remarks", "reason"],
};
//clinical changes that need a written reason (spec §93–95)
const MATERIAL_FIELDS = ["diseaseId", "diagnosisDate", "medicines"];

const sameMedicines = (a: TTreatmentMedicine[], b: TTreatmentMedicine[]) =>
  JSON.stringify(auditSnapshot({ medicines: a }).medicines) === JSON.stringify(auditSnapshot({ medicines: b }).medicines);

/**
 * PUT /:id — controlled update (Owner / Manager / Vet) with a full AuditLog diff.
 *  - Ongoing: disease, diagnosisDate, symptoms, treatedBy, medicines, estimatedCost,
 *    followUpDate, remarks (disease / date / medicine changes need `reason`)
 *  - Referred: followUpDate, estimatedCost, remarks
 *  - Recovered / Cancelled: remarks only
 * The animal and status never change here. A medicine that already drew stock cannot be
 * removed (cancel with restoreStock, or keep the line). estimatedCost stays an estimate
 * and never creates an Expense.
 */
const updateTreatment = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const body = payload ?? {};
  rejectServerFields(body);
  if ("animalId" in body) {
    throw new AppError(status.BAD_REQUEST, "animalId cannot be changed — cancel this treatment and record it for the right animal.");
  }
  if ("status" in body) throw new AppError(status.BAD_REQUEST, "status changes go through PATCH /:id/status.");
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, TreatmentPermissions.UPDATE, "correct treatments");
  requireWritableFarm(access);

  const doc = await findRecord(access, id);
  const allowed = UPDATABLE_BY_STATUS[doc.status] ?? ["remarks", "reason"];
  const refused = Object.keys(body).filter((key) => !allowed.includes(key));
  if (refused.length) {
    throw new AppError(status.BAD_REQUEST, `${refused.join(", ")} cannot be changed on a ${doc.status} treatment!`);
  }

  const animal = await findAnimal(access, String(doc.animalId));
  const set: Record<string, unknown> = {};
  const warnings: string[] = [];

  //disease
  let diseaseId = doc.diseaseId;
  if (!isBlank(body.diseaseId)) {
    const disease = await findDisease(body.diseaseId);
    if (String(disease._id) !== String(doc.diseaseId)) {
      requireActiveDisease(disease);
      set.diseaseId = disease._id;
      diseaseId = disease._id;
    }
  }

  //dates
  let diagnosisDate = new Date(doc.diagnosisDate);
  if (!isBlank(body.diagnosisDate)) {
    const date = parseDiagnosisDate(body.diagnosisDate, animal.birthDate);
    if (date.getTime() !== diagnosisDate.getTime()) {
      set.diagnosisDate = date;
      diagnosisDate = date;
    }
  }
  if ("followUpDate" in body) {
    const due = parseFollowUpDate(body.followUpDate, diagnosisDate);
    if ((due?.getTime() ?? null) !== (doc.followUpDate ? new Date(doc.followUpDate).getTime() : null)) set.followUpDate = due;
  } else if (set.diagnosisDate && doc.followUpDate && new Date(doc.followUpDate) < diagnosisDate) {
    throw new AppError(status.BAD_REQUEST, "The current follow-up date would fall before the new diagnosis date — send a new followUpDate too.");
  }

  if ("symptoms" in body) {
    const symptoms = parseSymptoms(body.symptoms);
    if (JSON.stringify(symptoms) !== JSON.stringify(doc.symptoms ?? [])) set.symptoms = symptoms;
  }
  if ("estimatedCost" in body) {
    const cost = parseCost(body.estimatedCost);
    if (cost !== (doc.estimatedCost ?? null)) set.estimatedCost = cost;
  }
  if ("remarks" in body) {
    const remarks = parseText("remarks", body.remarks) ?? "";
    if (remarks !== (doc.remarks ?? "")) set.remarks = remarks;
  }

  //treatedBy + medicines (with the prescription rule re-checked against the result)
  let treatedBy: TMemberRef | null = null;
  if (!isBlank(body.treatedBy) && String(body.treatedBy) !== String(doc.treatedBy)) {
    treatedBy = await resolveTreatedBy(access, body.treatedBy);
    set.treatedBy = treatedBy._id;
  }
  if ("medicines" in body) {
    const keepInactive = new Set(doc.medicines.map((m) => String(m.medicineId)));
    const parsed = await parseMedicineLines(body.medicines, { keepInactive, previous: doc.medicines });
    if (!sameMedicines(parsed.lines, doc.medicines)) {
      //a medicine that already drew stock must stay on the episode
      const ledger = await loadLedgerNet(access, doc._id);
      const kept = new Set(parsed.lines.map((l) => String(l.medicineId)));
      const dropped = ledger.lines.filter((l) => l.medicineId && !kept.has(l.medicineId));
      if (dropped.length) {
        throw new AppError(
          status.CONFLICT,
          `${dropped.map((d) => d.itemName).join(", ")} was already drawn from stock for this treatment and cannot be removed.`,
        );
      }
      set.medicines = parsed.lines;
    }
    if (set.medicines || set.treatedBy) {
      let who: TMemberRef = treatedBy ?? { _id: doc.treatedBy, role: "" };
      if (!treatedBy) {
        const current = await FarmMemberModel.findById(doc.treatedBy).select("_id role").lean();
        if (current) who = { _id: current._id as Types.ObjectId, role: current.role };
      }
      enforcePrescriptionRule(access, who, parsed.prescriptionMedicines, warnings);
    }
  } else if (set.treatedBy) {
    const meds = await findMedicines(doc.medicines.map((m) => String(m.medicineId)));
    const rx = [...new Map([...meds.values()].map((m) => [String(m._id), m])).values()].filter((m) => m.prescriptionRequired);
    enforcePrescriptionRule(access, treatedBy as TMemberRef, rx, warnings);
  }

  const changedFields = Object.keys(set);
  if (!changedFields.length) {
    return { mode: "unchanged" as const, treatment: await loadDetail(access, doc._id), warnings };
  }
  const material = changedFields.filter((f) => MATERIAL_FIELDS.includes(f));
  const reason = material.length
    ? requireReason("reason", body.reason, `change ${material.join(", ")}`)
    : parseText("reason", body.reason);

  if (set.diseaseId || set.diagnosisDate) {
    const dup = await findPossibleDuplicate(access, animal._id, diseaseId, diagnosisDate, doc._id);
    if (dup) warnings.push(`Note: ${dup.treatmentNo} (${dup.status}) covers the same disease for this animal around that date.`);
  }

  await executeAtomically(async (session, undo) => {
    const updated = await TreatmentModel.findOneAndUpdate(
      { _id: doc._id, status: doc.status, updatedAt: doc.updatedAt },
      { $set: set },
      { returnDocument: "after", runValidators: true, ...sessionOpts(session) },
    );
    if (!updated) throw new AppError(status.CONFLICT, "This treatment was changed by someone else. Reload and try again.");
    const previous = Object.fromEntries(
      Object.keys(set).map((key) => [key, (doc as unknown as Record<string, unknown>)[key] ?? null]),
    );
    undo.push(() => TreatmentModel.updateOne({ _id: doc._id }, { $set: previous }));
  }, {
    trace: traceOf(context, access.farmObjectId, doc._id, AuditActions.UPDATE, "Treatment Updated"),
    log: async () => {
      const oldData: Record<string, unknown> = {};
      const newData: Record<string, unknown> = {};
      const before = auditSnapshot(doc) as Record<string, unknown>;
      const after = auditSnapshot({ ...doc, ...(set as Partial<TTreatment>) }) as Record<string, unknown>;
      for (const key of changedFields) {
        oldData[key] = before[key] ?? (doc as unknown as Record<string, unknown>)[key] ?? null;
        newData[key] = after[key] ?? set[key];
      }
      if (reason) newData.reason = reason;
      let event = "Treatment Updated";
      if (changedFields.length === 1) {
        event =
          {
            medicines: "Medicines Changed",
            followUpDate: "Follow-up Changed",
            diseaseId: "Disease Changed",
            diagnosisDate: "Diagnosis Date Changed",
            treatedBy: "Treated By Changed",
            estimatedCost: "Estimated Cost Changed",
            symptoms: "Symptoms Changed",
          }[changedFields[0] as string] ?? event;
      }
      await audit(context, access.farmObjectId, doc._id, AuditActions.UPDATE, event, oldData, newData, changedFields);
    },
  });

  return { mode: "updated" as const, treatment: await loadDetail(access, doc._id), changedFields, warnings };
};

/* -------------------------------------------------------------------------- */
/*                                   Delete                                   */
/* -------------------------------------------------------------------------- */

/**
 * DELETE /:id — Owner only, for unexecuted erroneous entries (spec §94–95):
 * Recovered / Referred episodes are medical history and any episode with stock
 * movements keeps its ledger trail — those are refused (cancel instead). The animal's
 * health status is recalculated in the same atomic unit.
 */
const deleteTreatment = async (
  farmId: string,
  id: string,
  requesterUserId: string,
  payload: TPayload,
  context: TAuditContext,
) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, TreatmentPermissions.DELETE, "delete treatments");
  requireWritableFarm(access);
  const reason = parseText("reason", (payload ?? {}).reason);

  const doc = await findRecord(access, id);
  if (!DELETABLE_STATUSES.includes(doc.status)) {
    throw new AppError(
      status.CONFLICT,
      `A ${doc.status} treatment is part of the animal's medical history and cannot be deleted.`,
    );
  }
  const ledger = await loadLedgerNet(access, doc._id);
  if (ledger.hasLedger) {
    throw new AppError(
      status.CONFLICT,
      "This treatment has medicine stock movements and is kept for traceability — cancel it (with restoreStock) instead.",
    );
  }

  const health = await executeAtomically(async (session, undo) => {
    const removed = await TreatmentModel.deleteOne({ _id: doc._id, status: doc.status, updatedAt: doc.updatedAt }, sessionOpts(session));
    if (!removed.deletedCount) throw new AppError(status.CONFLICT, "This treatment was changed by someone else. Reload and try again.");
    undo.push(() => TreatmentModel.create([doc]));
    return syncAnimalHealth(access, doc.animalId, "Deleted", session, undo);
  }, {
    trace: traceOf(context, access.farmObjectId, doc._id, AuditActions.DELETE, "Treatment Deleted"),
    log: async (health) => {
      await audit(context, access.farmObjectId, doc._id, AuditActions.DELETE, "Treatment Deleted", auditSnapshot(doc), {
        ...(reason ? { reason } : {}),
        animalHealthStatus: health,
      });
    },
  });
  return { _id: doc._id, treatmentNo: doc.treatmentNo, deleted: true, animalHealthStatus: health };
};

/* -------------------------------------------------------------------------- */
/*                                   Reads                                    */
/* -------------------------------------------------------------------------- */

const LIST_SORT_FIELDS = new Set(["diagnosisDate", "followUpDate", "completedDate", "createdAt", "updatedAt", "status", "treatmentNo", "estimatedCost"]);

const parseSort = (value: unknown): Record<string, 1 | -1> => {
  const raw = isBlank(value) ? "-diagnosisDate" : String(value);
  const sort: Record<string, 1 | -1> = {};
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const desc = part.startsWith("-");
    const field = desc ? part.slice(1) : part;
    if (!LIST_SORT_FIELDS.has(field)) throw new AppError(status.BAD_REQUEST, `sort must use: ${[...LIST_SORT_FIELDS].join(", ")}!`);
    sort[field] = desc ? -1 : 1;
  }
  sort._id = -1;
  return sort;
};

const parseWindowDays = (value: unknown) =>
  isBlank(value) ? DEFAULT_FOLLOW_UP_DAYS : Math.floor(parseNumber("days", value, { min: 0, max: MAX_FOLLOW_UP_DAYS }));

/**
 * GET / — farm-wide treatments, paginated. Filters: animalId, diseaseId, medicineId,
 * status (comma list), treatedBy, followUp=overdue|today|upcoming (+ followUpDays),
 * open=true (Ongoing + Referred), from/to (diagnosisDate), searchTerm, sort.
 */
const getFarmTreatments = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const filter: Record<string, unknown> = { farmId: access.farmObjectId };
  const and: Record<string, unknown>[] = [];

  if (!isBlank(query.animalId)) filter.animalId = (await findAnimal(access, query.animalId))._id;
  if (!isBlank(query.diseaseId)) filter.diseaseId = (await findDisease(query.diseaseId))._id;
  if (!isBlank(query.medicineId)) {
    const ref = String(query.medicineId).trim();
    const med = (await findMedicines([ref])).get(isValidObjectId(ref) ? ref : ref.toUpperCase());
    if (!med) throw new AppError(status.NOT_FOUND, "Medicine not found!");
    filter["medicines.medicineId"] = med._id;
  }
  if (!isBlank(query.status)) filter.status = { $in: parseEnumList("status", query.status, STATUSES) };
  if (query.open === "true") and.push({ status: { $in: OPEN_STATUSES as TTreatmentStatus[] } });
  if (!isBlank(query.treatedBy)) {
    if (!isValidObjectId(String(query.treatedBy))) throw new AppError(status.BAD_REQUEST, "treatedBy must be a member id!");
    filter.treatedBy = new Types.ObjectId(String(query.treatedBy));
  }
  Object.assign(filter, parseDateRange(query, "diagnosisDate"));

  const today = startOfTodayUtc();
  const followUp = isBlank(query.followUp) ? null : String(query.followUp);
  //backwards-compatible alias: overdue=true
  const mode = followUp ?? (query.overdue === "true" ? "overdue" : null);
  if (mode) {
    const open = { status: { $in: OPEN_STATUSES as TTreatmentStatus[] } };
    if (mode === "overdue") and.push({ ...open, followUpDate: { $lt: today } });
    else if (mode === "today") and.push({ ...open, followUpDate: { $gte: today, $lt: addDays(today, 1) } });
    else if (mode === "upcoming") {
      and.push({ ...open, followUpDate: { $gte: today, $lt: addDays(today, parseWindowDays(query.followUpDays) + 1) } });
    } else throw new AppError(status.BAD_REQUEST, "followUp must be overdue, today or upcoming!");
  }
  if (!isBlank(query.searchTerm)) {
    const rx = { $regex: escapeRegex(String(query.searchTerm).trim()), $options: "i" };
    and.push({ $or: [{ treatmentNo: rx }, { remarks: rx }, { symptoms: rx }] });
  }
  if (and.length) filter.$and = and;

  const { page, limit, skip } = parsePaging(query, MAX_LIST_LIMIT);
  const [total, rows] = await Promise.all([
    TreatmentModel.countDocuments(filter),
    populateRecord(TreatmentModel.find(filter).sort(parseSort(query.sort)).skip(skip).limit(limit).select("-__v")).lean(),
  ]);
  const data = (rows as unknown as TTreatmentDoc[]).map((row) => ({ ...row, ...derive(row) }));
  return { meta: pageMeta(page, limit, total), data };
};

/**
 * GET /animals/:animalId/treatments — chronological history (latest first), open care
 * plans, active withdrawal restrictions (conservative maximum) and summary numbers.
 */
const getAnimalTreatments = async (farmId: string, animalRef: string, requesterUserId: string) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const animal = await findAnimal(access, animalRef);
  const rows = await populateRecord(
    TreatmentModel.find({ farmId: access.farmObjectId, animalId: animal._id })
      .sort({ diagnosisDate: -1, createdAt: -1 })
      .limit(MAX_ANIMAL_HISTORY)
      .select("-__v"),
  ).lean();
  const history = (rows as unknown as TTreatmentDoc[]).map((row) => ({ ...row, ...derive(row) }));

  const lookBack = addDays(startOfTodayUtc(), -WITHDRAWAL_LOOKBACK_DAYS);
  const recent = history.filter((h) => new Date(h.diagnosisDate) >= lookBack);
  const plain = recent.map((h) => ({
    ...(h as unknown as TWithdrawalTreatment),
    medicines: h.medicines.map((m) => ({ ...m, medicineId: medicineIdOf(m.medicineId) })),
  }));
  const withdrawal = computeWithdrawals(plain, await medicineMapFor(plain.flatMap((t) => t.medicines.map((m) => m.medicineId))));

  const counts = Object.fromEntries(STATUSES.map((s) => [s, history.filter((h) => h.status === s).length]));
  const recovered = history.filter((h) => h.status === TreatmentStatuses.RECOVERED && h.completedDate);
  const avgRecoveryDays = recovered.length
    ? round2(recovered.reduce((sum, h) => sum + daysBetween(new Date(h.diagnosisDate), new Date(h.completedDate as Date)), 0) / recovered.length)
    : null;
  const estimatedCostTotal = round2(
    history.filter((h) => h.status !== TreatmentStatuses.CANCELLED).reduce((sum, h) => sum + (h.estimatedCost ?? 0), 0),
  );

  return {
    animal,
    counts,
    summary: {
      totalTreatments: history.length,
      openTreatments: history.filter((h) => h.isOpen).length,
      avgRecoveryDays,
      estimatedCostTotal,
      lastDiagnosisDate: history[0]?.diagnosisDate ?? null,
    },
    //Ongoing / Referred episodes with their medicines and follow-up (care plans)
    activeTreatments: history.filter((h) => h.isOpen),
    withdrawal,
    history,
  };
};

/** GET /withdrawals — Active animals still inside a medicine withdrawal window (milk / sale safety). */
const getWithdrawals = async (farmId: string, requesterUserId: string) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const lookBack = addDays(startOfTodayUtc(), -WITHDRAWAL_LOOKBACK_DAYS);
  const rows = await TreatmentModel.find({
    farmId: access.farmObjectId,
    status: { $ne: TreatmentStatuses.CANCELLED },
    diagnosisDate: { $gte: lookBack },
    "medicines.0": { $exists: true },
  })
    .select("treatmentNo status diagnosisDate completedDate followUpDate medicines animalId")
    .lean();
  if (!rows.length) return { asOf: startOfTodayUtc(), animals: [] };
  const medicineOf = await medicineMapFor(rows.flatMap((r) => r.medicines.map((m) => m.medicineId)));
  const byAnimal = new Map<string, TWithdrawalTreatment[]>();
  for (const r of rows) {
    const key = String(r.animalId);
    byAnimal.set(key, [...(byAnimal.get(key) ?? []), r as unknown as TWithdrawalTreatment]);
  }
  const animals = await AnimalModel.find({
    farmId: access.farmObjectId,
    lifeStatus: AnimalLifeStatuses.ACTIVE,
    _id: { $in: [...byAnimal.keys()].map((k) => new Types.ObjectId(k)) },
  })
    .select("animalCode name healthStatus purpose")
    .lean();
  const result = animals
    .map((a) => ({ animal: a, ...computeWithdrawals(byAnimal.get(String(a._id)) ?? [], medicineOf) }))
    .filter((r) => r.underWithdrawal)
    .sort((a, b) => (b.withdrawalEndDate?.getTime() ?? 0) - (a.withdrawalEndDate?.getTime() ?? 0));
  return { asOf: startOfTodayUtc(), animals: result };
};

/** GET /follow-ups — open episodes grouped as overdue / today / upcoming (dashboard reminder). */
const getFollowUps = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const days = parseWindowDays(query.days);
  const today = startOfTodayUtc();
  const rows = await populateRecord(
    TreatmentModel.find({
      farmId: access.farmObjectId,
      status: { $in: OPEN_STATUSES as TTreatmentStatus[] },
      followUpDate: { $ne: null, $lt: addDays(today, days + 1) },
    })
      .sort({ followUpDate: 1 })
      .limit(200)
      .select("treatmentNo animalId diseaseId status diagnosisDate followUpDate treatedBy medicines"),
  ).lean();
  const items = (rows as unknown as TTreatmentDoc[]).map((r) => ({ ...r, ...derive(r) }));
  return {
    asOf: today,
    windowDays: days,
    overdue: items.filter((i) => i.followUpState === "Overdue"),
    today: items.filter((i) => i.followUpState === "Today"),
    upcoming: items.filter((i) => i.followUpState === "Upcoming"),
  };
};

/** GET /stats — health dashboard numbers (counts, follow-ups, common diseases / medicines, cost). */
const getStats = async (farmId: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const today = startOfTodayUtc();
  const match: Record<string, unknown> = { farmId: access.farmObjectId, ...parseDateRange(query, "diagnosisDate") };

  const [byStatus, overdue, dueToday, upcoming, topDiseases, topMedicines, recovery, cost, underTreatment] = await Promise.all([
    TreatmentModel.aggregate<{ _id: string; count: number }>([{ $match: match }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    TreatmentModel.countDocuments({ farmId: access.farmObjectId, status: { $in: OPEN_STATUSES as TTreatmentStatus[] }, followUpDate: { $lt: today } }),
    TreatmentModel.countDocuments({
      farmId: access.farmObjectId,
      status: { $in: OPEN_STATUSES as TTreatmentStatus[] },
      followUpDate: { $gte: today, $lt: addDays(today, 1) },
    }),
    TreatmentModel.countDocuments({
      farmId: access.farmObjectId,
      status: { $in: OPEN_STATUSES as TTreatmentStatus[] },
      followUpDate: { $gte: addDays(today, 1), $lt: addDays(today, DEFAULT_FOLLOW_UP_DAYS + 1) },
    }),
    TreatmentModel.aggregate([
      { $match: match },
      { $group: { _id: "$diseaseId", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
      { $lookup: { from: "diseases", localField: "_id", foreignField: "_id", as: "disease" } },
      { $project: { _id: 0, count: 1, disease: { $arrayElemAt: [{ $map: { input: "$disease", in: { _id: "$$this._id", diseaseCode: "$$this.diseaseCode", diseaseName: "$$this.diseaseName" } } }, 0] } } },
    ]),
    TreatmentModel.aggregate([
      { $match: match },
      { $unwind: "$medicines" },
      { $group: { _id: "$medicines.medicineId", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
      { $lookup: { from: "medicines", localField: "_id", foreignField: "_id", as: "medicine" } },
      { $project: { _id: 0, count: 1, medicine: { $arrayElemAt: [{ $map: { input: "$medicine", in: { _id: "$$this._id", medicineCode: "$$this.medicineCode", medicineName: "$$this.medicineName" } } }, 0] } } },
    ]),
    TreatmentModel.aggregate<{ avg: number | null }>([
      { $match: { ...match, status: TreatmentStatuses.RECOVERED, completedDate: { $ne: null } } },
      { $group: { _id: null, avg: { $avg: { $divide: [{ $subtract: ["$completedDate", "$diagnosisDate"] }, DAY_MS] } } } },
    ]),
    TreatmentModel.aggregate<{ total: number; avg: number | null }>([
      { $match: { ...match, status: { $ne: TreatmentStatuses.CANCELLED } } },
      { $group: { _id: null, total: { $sum: { $ifNull: ["$estimatedCost", 0] } }, avg: { $avg: "$estimatedCost" } } },
    ]),
    AnimalModel.countDocuments({
      farmId: access.farmObjectId,
      lifeStatus: AnimalLifeStatuses.ACTIVE,
      healthStatus: AnimalHealthStatuses.UNDER_TREATMENT,
    }),
  ]);

  const counts = Object.fromEntries(STATUSES.map((s) => [s, byStatus.find((c) => c._id === s)?.count ?? 0]));
  const closed = counts[TreatmentStatuses.RECOVERED]! + counts[TreatmentStatuses.REFERRED]!;
  return {
    asOf: today,
    totals: {
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      byStatus: counts,
      animalsUnderTreatment: underTreatment,
      followUpsOverdue: overdue,
      followUpsToday: dueToday,
      followUpsUpcoming: upcoming,
      recoveryRatePercent: closed ? round2((counts[TreatmentStatuses.RECOVERED]! / closed) * 100) : null,
      avgRecoveryDays: recovery[0]?.avg !== undefined && recovery[0]?.avg !== null ? round2(recovery[0].avg) : null,
      //estimates only — actual spending lives in Expense / Inventory_Transaction
      estimatedCostTotal: round2(cost[0]?.total ?? 0),
      estimatedCostAverage: cost[0]?.avg ? round2(cost[0].avg) : null,
    },
    topDiseases,
    topMedicines,
  };
};

/** GET /:id — one treatment (by _id or TRT number), populated, with withdrawal + stock trail. */
const getTreatment = async (farmId: string, id: string, requesterUserId: string) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const doc = await findRecord(access, id);
  return loadDetail(access, doc._id);
};

/** GET /:id/stock-options — the farm's usable stock rows for each prescribed medicine. */
const getStockOptions = async (farmId: string, id: string, requesterUserId: string) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const doc = await findRecord(access, id);
  const ids = doc.medicines.map((m) => m.medicineId);
  const [rows, medicines] = await Promise.all([
    InventoryModel.find({ farmId: access.farmObjectId, itemType: InventoryItemTypes.MEDICINE, referenceId: { $in: ids } })
      .select("inventoryCode itemName currentStock unit status expiryDate referenceId")
      .sort({ expiryDate: 1 })
      .lean(),
    findMedicines(ids.map(String)),
  ]);
  return doc.medicines.map((line) => {
    const med = medicines.get(String(line.medicineId));
    const stock = rows
      .filter((r) => String(r.referenceId) === String(line.medicineId))
      .map((r) => ({
        ...r,
        usable: !isUnusableInventory(r),
        unitMatchesDose: unitsMatch(r.unit, line.dosageUnit),
        defaultQuantity: unitsMatch(r.unit, line.dosageUnit) ? line.dosage : null,
      }));
    return {
      lineId: line._id ?? null,
      medicineId: line.medicineId,
      medicineName: med?.medicineName ?? null,
      medicineCode: med?.medicineCode ?? null,
      dosage: line.dosage,
      dosageUnit: line.dosageUnit,
      stock,
    };
  });
};

/** GET /meta — enums, compatibility matrices, permissions and limits for forms and filters. */
const getMeta = () => ({
  statuses: STATUSES,
  transitions: TREATMENT_TRANSITIONS,
  openStatuses: OPEN_STATUSES,
  dosageUnits: DOSAGE_UNITS,
  dosageUnitCompatibility: DOSAGE_UNIT_COMPATIBILITY,
  administrationRoutes: ROUTES,
  administrationRouteLabels: MedicineAdministrationRouteLabels,
  routeCompatibility: MEDICINE_ROUTE_COMPATIBILITY,
  frequencySuggestions: FREQUENCY_SUGGESTIONS,
  durationSuggestions: DURATION_SUGGESTIONS,
  permissions: TreatmentPermissions,
  treatedByRoles: TREATED_BY_ROLES,
  prescriberRoles: PRESCRIBER_ROLES,
  sortFields: [...LIST_SORT_FIELDS],
  limits: {
    maxTextLength: MAX_TEXT_LENGTH,
    maxShortText: MAX_SHORT_TEXT,
    maxSymptoms: MAX_SYMPTOMS,
    maxSymptomLength: MAX_SYMPTOM_LENGTH,
    maxMedicines: MAX_MEDICINES,
    maxDosage: MAX_DOSAGE,
    maxEstimatedCost: MAX_ESTIMATED_COST,
    maxBackdateDays: MAX_BACKDATE_DAYS,
    maxFollowUpAheadDays: MAX_FOLLOW_UP_AHEAD_DAYS,
    defaultFollowUpDays: DEFAULT_FOLLOW_UP_DAYS,
    maxFollowUpDays: MAX_FOLLOW_UP_DAYS,
    duplicateWindowDays: DUPLICATE_WINDOW_DAYS,
  },
});

/**
 * GET /staff — active members selectable as treatedBy. Only name, code and farm role
 * are returned (no phone / NID / salary), so every member may call it.
 */
const getStaff = async (farmId: string, requesterUserId: string) => {
  const access = await resolveAccess(farmId, requesterUserId);
  const rows = await FarmMemberModel.find({ farmId: access.farmObjectId, isActive: true, role: { $in: TREATED_BY_ROLES as TFarmMemberRole[] } })
    .select("role userId")
    .populate("userId", "userId fullName")
    .sort({ role: 1 })
    .lean();
  return {
    me: access.memberObjectId,
    myRole: access.role,
    members: rows.map((row) => {
      const user = row.userId as unknown as { userId?: string; fullName?: string } | null;
      return {
        _id: row._id,
        role: row.role,
        userId: user?.userId ?? null,
        fullName: user?.fullName ?? null,
        canPrescribe: PRESCRIBER_ROLES.includes(row.role),
      };
    }),
  };
};

/** GET /:id/audit-logs — Owner / Manager / Vet: who created, changed and closed the episode. */
const getAuditLogs = async (farmId: string, id: string, requesterUserId: string, query: TPayload) => {
  const access = await resolveAccess(farmId, requesterUserId);
  requireRole(access, TreatmentPermissions.AUDIT, "view treatment history");
  const doc = await findRecord(access, id);
  const { page, limit, skip } = parsePaging(query, MAX_LIST_LIMIT);
  const filter = { entityType: AuditEntityTypes.TREATMENT, entityId: doc._id, farmId: access.farmObjectId };
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

export const TreatmentServices = {
  createTreatment,
  changeStatus,
  consumeInventory,
  updateTreatment,
  deleteTreatment,
  getFarmTreatments,
  getAnimalTreatments,
  getWithdrawals,
  getFollowUps,
  getStats,
  getTreatment,
  getStockOptions,
  getMeta,
  getStaff,
  getAuditLogs,
};

export type { TTreatmentStatus };
