import { Types } from "mongoose";
import { AnimalLifeStatuses } from "../animal/animal.constants.js";
import { AnimalModel } from "../animal/animal.model.js";
import { PregnancyResults } from "../breeding/breeding.constants.js";
import { BreedingModel } from "../breeding/breeding.model.js";
import { ConnectionStatuses } from "../device/device.constants.js";
import type { TDevice } from "../device/device.interface.js";
import { DeviceModel } from "../device/device.model.js";
import { DiseaseModel } from "../disease/disease.model.js";
import { ACTIVE_RECOMMENDATION_STATUSES } from "../feedRecommendation/feedRecommendation.constants.js";
import { FeedRecommendationModel } from "../feedRecommendation/feedRecommendation.model.js";
import { escapeRegex } from "../feedRecord/feedRecord.utils.js";
import { InventoryStatuses } from "../inventory/inventory.constants.js";
import { InventoryModel } from "../inventory/inventory.model.js";
import { daysUntilExpiry, deriveInventoryStatus } from "../inventory/inventory.utils.js";
import { MedicineModel } from "../medicine/medicine.model.js";
import { PregnancyStatuses } from "../pregnancy/pregnancy.constants.js";
import { PregnancyModel } from "../pregnancy/pregnancy.model.js";
import { OPEN_STATUSES } from "../treatment/treatment.constants.js";
import { TreatmentModel } from "../treatment/treatment.model.js";
import { addDays, computeWithdrawals, daysBetween, startOfTodayUtc } from "../treatment/treatment.utils.js";
import type { TWithdrawalTreatment } from "../treatment/treatment.utils.js";
import { VaccinationStatuses } from "../vaccination/vaccination.constants.js";
import { VaccinationModel } from "../vaccination/vaccination.model.js";
import { VaccineModel } from "../vaccine/vaccine.model.js";
import {
  DUE_KEEP_DAYS,
  LeadDays,
  NotificationEvents as Events,
  NotificationReferenceTypes as Refs,
  NotificationStatuses,
  OVERDUE_KEEP_DAYS,
} from "./notification.constants.js";
import type { TNotificationEvent } from "./notification.constants.js";
import { expireRows, factFilter, loadAudience, raise, raiseFact, resolveFor, syncTimed } from "./notification.delivery.js";
import type { TAudience, TDue } from "./notification.delivery.js";
import { NotificationModel } from "./notification.model.js";

/*
 * Producers look at the saved state of a record and bring its notifications in line with it.
 * Business modules call them after commit; the jobs call the same code for a whole farm.
 * The functions that modules call never throw: a notification must not fail the business operation.
 */

type TId = Types.ObjectId;

const safely = async (label: string, work: () => Promise<unknown>): Promise<void> => {
  try {
    await work();
  } catch (error) {
    console.log(`[notification] ${label}:`, error instanceof Error ? error.message : error);
  }
};

const day = (date: Date) => new Date(date).toISOString().slice(0, 10);
const calendarDay = (date: Date) => startOfTodayUtc(new Date(date));

/** Active animals only: a sold or dead animal needs no reminder. */
const loadAnimals = async (farmId: TId, ids: unknown[]): Promise<Map<string, string>> => {
  if (!ids.length) return new Map();
  const animals = await AnimalModel.find({
    farmId,
    lifeStatus: AnimalLifeStatuses.ACTIVE,
    _id: { $in: ids as TId[] },
  })
    .select("animalCode name")
    .lean();
  return new Map(animals.map((a) => [String(a._id), a.name ? `${a.animalCode} (${a.name})` : a.animalCode]));
};

/* ---------- vaccination ---------- */

const VACCINATION_EVENTS = [
  Events.VACCINATION_DUE_SOON,
  Events.VACCINATION_DUE_TOMORROW,
  Events.VACCINATION_OVERDUE,
] as const;

const syncVaccinations = async (farmId: TId, audience: TAudience | null, animalId?: TId) => {
  const today = startOfTodayUtc();
  const animalFilter = animalId ? { animalId } : {};
  const [scheduled, latest, inScope] = await Promise.all([
    VaccinationModel.find({ farmId, ...animalFilter, status: VaccinationStatuses.SCHEDULED })
      .select("animalId vaccineId vaccinationDate")
      .lean(),
    //next dose of the newest given dose, unless it is already scheduled (its own date counts then)
    VaccinationModel.aggregate<{ recordId: TId; nextDueDate: Date | null; _id: { animalId: TId; vaccineId: TId } }>([
      { $match: { farmId, ...animalFilter, status: VaccinationStatuses.COMPLETED } },
      { $sort: { vaccinationDate: -1, createdAt: -1 } },
      {
        $group: {
          _id: { animalId: "$animalId", vaccineId: "$vaccineId" },
          recordId: { $first: "$_id" },
          nextDueDate: { $first: "$nextDueDate" },
        },
      },
    ]),
    animalId ? VaccinationModel.find({ farmId, animalId }).select("_id").lean() : null,
  ]);

  const planned = new Set(scheduled.map((row) => `${row.animalId}:${row.vaccineId}`));
  const limit = addDays(today, LeadDays.VACCINATION_SOON);
  const pending = [
    ...scheduled.map((row) => ({
      id: row._id,
      animalId: row.animalId,
      vaccineId: row.vaccineId,
      due: calendarDay(row.vaccinationDate),
    })),
    ...latest
      .filter((row) => row.nextDueDate && !planned.has(`${row._id.animalId}:${row._id.vaccineId}`))
      .map((row) => ({
        id: row.recordId,
        animalId: row._id.animalId,
        vaccineId: row._id.vaccineId,
        due: calendarDay(row.nextDueDate as Date),
      })),
  ].filter((row) => row.due <= limit);

  const [animals, vaccines] = await Promise.all([
    loadAnimals(farmId, pending.map((row) => row.animalId)),
    VaccineModel.find({ _id: { $in: pending.map((row) => row.vaccineId) } }).select("vaccineName").lean(),
  ]);
  const vaccineName = new Map(vaccines.map((v) => [String(v._id), v.vaccineName]));

  const dues: TDue[] = [];
  for (const row of pending) {
    const animal = animals.get(String(row.animalId));
    if (!animal) continue;
    const left = daysBetween(today, row.due);
    const what = `${vaccineName.get(String(row.vaccineId)) ?? "Vaccine"} for ${animal}`;
    if (left < 0) {
      dues.push({
        referenceId: row.id,
        event: Events.VACCINATION_OVERDUE,
        expiresAt: addDays(row.due, OVERDUE_KEEP_DAYS),
        message: `${what} was due on ${day(row.due)}.`,
      });
      continue;
    }
    dues.push({
      referenceId: row.id,
      event: left === LeadDays.VACCINATION_TOMORROW ? Events.VACCINATION_DUE_TOMORROW : Events.VACCINATION_DUE_SOON,
      //on the day itself yesterday's reminder stays; a dose planned for today is announced as "soon"
      ...(left === 0 ? { coveredBy: Events.VACCINATION_DUE_TOMORROW } : {}),
      expiresAt: addDays(row.due, DUE_KEEP_DAYS),
      message: `${what} is due on ${day(row.due)}.`,
    });
  }
  await syncTimed(farmId, audience, VACCINATION_EVENTS, dues, inScope?.map((row) => row._id));
};

/** A dose of this animal was scheduled, given, missed, cancelled, corrected or deleted. */
const vaccinationChanged = (farmId: TId, animalId: unknown, deletedId?: TId) =>
  safely("vaccination", async () => {
    if (deletedId) await resolveFor(farmId, Refs.VACCINATION, deletedId);
    await syncVaccinations(farmId, await loadAudience(farmId), new Types.ObjectId(String(animalId)));
  });

/* ---------- treatment ---------- */

const syncFollowUps = async (farmId: TId, audience: TAudience | null, treatmentId?: TId) => {
  const today = startOfTodayUtc();
  const rows = await TreatmentModel.find({
    farmId,
    ...(treatmentId ? { _id: treatmentId } : {}),
    status: { $in: OPEN_STATUSES as never[] },
    followUpDate: { $gte: today, $lt: addDays(today, LeadDays.FOLLOW_UP + 1) },
  })
    .select("treatmentNo animalId followUpDate")
    .lean();
  const animals = await loadAnimals(farmId, rows.map((row) => row.animalId));
  const dues: TDue[] = [];
  for (const row of rows) {
    const animal = animals.get(String(row.animalId));
    if (!animal || !row.followUpDate) continue;
    const due = calendarDay(row.followUpDate);
    dues.push({
      referenceId: row._id,
      event: Events.FOLLOW_UP_DUE,
      expiresAt: addDays(due, DUE_KEEP_DAYS),
      message: `Follow-up of ${row.treatmentNo} for ${animal} is due on ${day(due)}.`,
    });
  }
  await syncTimed(farmId, audience, [Events.FOLLOW_UP_DUE], dues, treatmentId ? [treatmentId] : undefined);
};

/** An episode was saved, changed status, was corrected or deleted. */
const treatmentChanged = (farmId: TId, id: unknown) =>
  safely("treatment", async () => {
    const treatmentId = new Types.ObjectId(String(id));
    const audience = await loadAudience(farmId);
    await syncFollowUps(farmId, audience, treatmentId);

    const doc = await TreatmentModel.findOne({ _id: treatmentId, farmId }).lean();
    const animal = doc ? (await loadAnimals(farmId, [doc.animalId])).get(String(doc.animalId)) : undefined;
    const end = (event: TNotificationEvent) =>
      resolveFor(farmId, Refs.TREATMENT, treatmentId, { events: [event], withArchived: true });

    const disease = doc ? await DiseaseModel.findById(doc.diseaseId).select("diseaseName contagious").lean() : null;
    if (doc && animal && disease?.contagious && OPEN_STATUSES.includes(doc.status)) {
      if (audience) {
        await raise(audience, Events.CONTAGIOUS_DISEASE, treatmentId, {
          message: `${disease.diseaseName} (contagious) was recorded for ${animal} in ${doc.treatmentNo}.`,
        });
      }
    } else await end(Events.CONTAGIOUS_DISEASE);

    const medicines = doc?.medicines.length
      ? await MedicineModel.find({ _id: { $in: doc.medicines.map((line) => line.medicineId) } })
          .select("medicineCode medicineName withdrawalPeriodDays")
          .lean()
      : [];
    const withdrawal = computeWithdrawals(
      doc ? [doc as unknown as TWithdrawalTreatment] : [],
      new Map(medicines.map((m) => [String(m._id), m])),
    );
    const until = withdrawal.withdrawalEndDate;
    if (doc && animal && until) {
      if (audience) {
        await raise(audience, Events.WITHDRAWAL_ACTIVE, treatmentId, {
          message: `${animal} is under medicine withdrawal (${doc.treatmentNo}) until ${withdrawal.provisional ? "at least " : ""}${day(until)}. Do not sell its milk or meat.`,
          //a running course keeps moving the end date
          expiresAt: withdrawal.provisional ? null : addDays(until, DUE_KEEP_DAYS),
          refresh: true,
        });
      }
    } else await end(Events.WITHDRAWAL_ACTIVE);
  });

/* ---------- breeding / pregnancy ---------- */

const syncPregnancyChecks = async (farmId: TId, audience: TAudience | null, animalId?: TId) => {
  const today = startOfTodayUtc();
  const rows = await BreedingModel.find({
    farmId,
    ...(animalId ? { animalId } : {}),
    pregnancyResult: PregnancyResults.PENDING,
    expectedPregnancyCheckDate: { $gte: today, $lt: addDays(today, LeadDays.PREGNANCY_CHECK + 1) },
  })
    .sort({ expectedPregnancyCheckDate: -1 })
    .select("breedingNo animalId expectedPregnancyCheckDate")
    .lean();
  const animals = await loadAnimals(farmId, rows.map((row) => row.animalId));
  const dues: TDue[] = [];
  //latest first: syncTimed keeps the last entry per animal, i.e. the nearest check
  for (const row of rows) {
    const animal = animals.get(String(row.animalId));
    if (!animal) continue;
    const due = calendarDay(row.expectedPregnancyCheckDate);
    dues.push({
      referenceId: row.animalId,
      event: Events.PREGNANCY_CHECK_DUE,
      expiresAt: addDays(due, DUE_KEEP_DAYS),
      message: `Pregnancy check of ${animal} (${row.breedingNo}) is due on ${day(due)}.`,
    });
  }
  await syncTimed(farmId, audience, [Events.PREGNANCY_CHECK_DUE], dues, animalId ? [animalId] : undefined);
};

/** A breeding of this animal was logged, checked, corrected or deleted. */
const breedingChanged = (farmId: TId, animalId: unknown) =>
  safely("breeding", async () => {
    await syncPregnancyChecks(farmId, await loadAudience(farmId), new Types.ObjectId(String(animalId)));
  });

const CALVING_EVENTS = [Events.CALVING_SOON, Events.CALVING_IN_3_DAYS, Events.CALVING_OVERDUE] as const;

const syncCalvings = async (farmId: TId, audience: TAudience | null, pregnancyId?: TId) => {
  const today = startOfTodayUtc();
  const rows = await PregnancyModel.find({
    farmId,
    ...(pregnancyId ? { _id: pregnancyId } : {}),
    pregnancyStatus: PregnancyStatuses.PREGNANT,
    expectedCalvingDate: { $lt: addDays(today, LeadDays.CALVING_SOON + 1) },
  })
    .select("pregnancyNo animalId expectedCalvingDate")
    .lean();
  const animals = await loadAnimals(farmId, rows.map((row) => row.animalId));
  const dues: TDue[] = [];
  for (const row of rows) {
    const animal = animals.get(String(row.animalId));
    if (!animal) continue;
    const due = calendarDay(row.expectedCalvingDate);
    const left = daysBetween(today, due);
    const overdue = left < 0;
    dues.push({
      referenceId: row._id,
      event: overdue ? Events.CALVING_OVERDUE : left <= LeadDays.CALVING_NEAR ? Events.CALVING_IN_3_DAYS : Events.CALVING_SOON,
      expiresAt: addDays(due, overdue ? OVERDUE_KEEP_DAYS : DUE_KEEP_DAYS),
      message: `${animal} (${row.pregnancyNo}) ${overdue ? "was" : "is"} expected to calve on ${day(due)}.`,
    });
  }
  await syncTimed(farmId, audience, CALVING_EVENTS, dues, pregnancyId ? [pregnancyId] : undefined);
};

/** `news`: what just happened; corrections pass nothing. */
const pregnancyChanged = (farmId: TId, id: unknown, news?: "confirmed" | "delivered") =>
  safely("pregnancy", async () => {
    const pregnancyId = new Types.ObjectId(String(id));
    const audience = await loadAudience(farmId);
    await syncCalvings(farmId, audience, pregnancyId);
    const doc = await PregnancyModel.findOne({ _id: pregnancyId, farmId }).lean();
    if (doc?.pregnancyStatus !== PregnancyStatuses.PREGNANT) {
      await resolveFor(farmId, Refs.PREGNANCY, pregnancyId, { events: [Events.PREGNANCY_CONFIRMED], withArchived: true });
    }
    if (!doc || !audience || !news) return;
    const animal = (await loadAnimals(farmId, [doc.animalId])).get(String(doc.animalId)) ?? doc.pregnancyNo;
    if (news === "confirmed" && doc.pregnancyStatus === PregnancyStatuses.PREGNANT) {
      await raise(audience, Events.PREGNANCY_CONFIRMED, pregnancyId, {
        message: `${animal} is pregnant (${doc.pregnancyNo}). Expected calving: ${day(doc.expectedCalvingDate)}.`,
      });
    }
    if (news === "delivered" && doc.pregnancyStatus === PregnancyStatuses.DELIVERED) {
      await raise(audience, Events.BIRTH_RECORDED, pregnancyId, {
        message: `${animal} calved${doc.actualCalvingDate ? ` on ${day(doc.actualCalvingDate)}` : ""} (${doc.pregnancyNo}). Calves: ${doc.calfCount ?? "not recorded"}.`,
      });
    }
  });

/* ---------- feed plan ---------- */

/** Confirmed plans are announced; rejected, superseded or deleted ones are cleared. */
const feedPlansChanged = (farmId: TId, ids: unknown[]) =>
  safely("feed plan", async () => {
    const audience = await loadAudience(farmId);
    for (const id of ids) {
      const planId = new Types.ObjectId(String(id));
      const plan = await FeedRecommendationModel.findOne({ _id: planId, farmId })
        .select("recommendationNo animalId status")
        .lean();
      if (!plan || !ACTIVE_RECOMMENDATION_STATUSES.includes(plan.status)) {
        await resolveFor(farmId, Refs.FEED_RECOMMENDATION, planId, { withArchived: true });
      } else if (audience) {
        const animal = (await loadAnimals(farmId, [plan.animalId])).get(String(plan.animalId));
        if (animal) {
          await raise(audience, Events.FEED_PLAN_READY, planId, {
            message: `Feed plan ${plan.recommendationNo} for ${animal} is ready.`,
          });
        }
      }
    }
  });

/* ---------- inventory ---------- */

const EXPIRY_EVENTS = [Events.ITEM_EXPIRING_SOON, Events.ITEM_EXPIRING_THIS_WEEK, Events.ITEM_EXPIRED] as const;

type TItemFilter = { _id?: TId; inventoryCode?: { $in: string[] } };

const loadItems = (farmId: TId, filter: TItemFilter = {}) =>
  InventoryModel.find({ farmId, ...filter })
    .select("inventoryCode itemName currentStock unit minimumStock reorderLevel expiryDate status")
    .lean();
type TItems = Awaited<ReturnType<typeof loadItems>>;

const syncStock = async (farmId: TId, audience: TAudience | null, items: TItems) => {
  for (const item of items) {
    const state = deriveInventoryStatus(item);
    const out = state === InventoryStatuses.OUT_OF_STOCK;
    const low = state === InventoryStatuses.LOW_STOCK;
    //an item that ran out is still low: that alert ends only when stock recovers
    const over = [...(out ? [] : [Events.OUT_OF_STOCK]), ...(out || low ? [] : [Events.LOW_STOCK])];
    if (over.length) await resolveFor(farmId, Refs.INVENTORY, item._id, { events: over, withArchived: true });
    if (!audience || (!out && !low)) continue;
    const name = `${item.itemName} (${item.inventoryCode})`;
    await raise(audience, out ? Events.OUT_OF_STOCK : Events.LOW_STOCK, item._id, {
      message: out ? `${name} is out of stock.` : `${name} is low: ${item.currentStock} ${item.unit} left.`,
    });
  }
};

const syncExpiry = async (farmId: TId, audience: TAudience | null, items: TItems, scoped: boolean) => {
  const dues: TDue[] = [];
  for (const item of items) {
    const left = daysUntilExpiry(item.expiryDate);
    if (!item.expiryDate || left === null || left > LeadDays.EXPIRY_SOON) continue;
    //nothing on the shelf, nothing to warn about
    if (item.status === InventoryStatuses.INACTIVE || item.currentStock <= 0) continue;
    const date = calendarDay(item.expiryDate);
    const expired = new Date(item.expiryDate).getTime() < Date.now();
    dues.push({
      referenceId: item._id,
      event: expired
        ? Events.ITEM_EXPIRED
        : left <= LeadDays.EXPIRY_NEAR
          ? Events.ITEM_EXPIRING_THIS_WEEK
          : Events.ITEM_EXPIRING_SOON,
      expiresAt: addDays(date, expired ? OVERDUE_KEEP_DAYS : DUE_KEEP_DAYS),
      message: `${item.itemName} (${item.inventoryCode}) ${expired ? "expired" : "expires"} on ${day(date)}. Stock: ${item.currentStock} ${item.unit}.`,
    });
  }
  await syncTimed(farmId, audience, EXPIRY_EVENTS, dues, scoped ? items.map((item) => item._id) : undefined);
};

/** Stock, thresholds, expiry or status of these items changed. */
const stockChanged = (farmId: TId, filter: TItemFilter) =>
  safely("stock", async () => {
    const [audience, items] = await Promise.all([loadAudience(farmId), loadItems(farmId, filter)]);
    await syncStock(farmId, audience, items);
    await syncExpiry(farmId, audience, items, true);
  });

/** Stock used or returned by a feed record, treatment or vaccination. */
const stockMoved = async (
  farmId: TId,
  movements: readonly ({ inventoryCode?: string | null | undefined } | null | undefined)[],
): Promise<void> => {
  const codes = [...new Set(movements.flatMap((m) => (m?.inventoryCode ? [m.inventoryCode] : [])))];
  if (codes.length) await stockChanged(farmId, { inventoryCode: { $in: codes } });
};

/** A stock item was deleted: it can no longer be opened. */
const itemDeleted = (farmId: TId, id: TId) =>
  safely("stock", () => resolveFor(farmId, Refs.INVENTORY, id, { withArchived: true }));

/* ---------- devices ---------- */

const deviceDetails = (device: TDevice) => `${device.company} ${device.model}, serial ${device.serialNumber}.`;
const offlineFact = ({ deviceCode, lastSyncAt }: TDevice) =>
  lastSyncAt
    ? `${deviceCode} has not synced since ${lastSyncAt.toISOString().slice(0, 16).replace("T", " ")} UTC.`
    : `${deviceCode} has never synced.`;
const warrantyFact = (deviceCode: string, expiry: Date) => `${deviceCode} warranty ends on ${day(expiry)}.`;

/** Connectivity job: once per outage (= per last sync). Errors reach the job runner. */
const tellDeviceOffline = async (device: TDevice): Promise<void> => {
  const audience = await loadAudience(device.farmId);
  if (audience) await raiseFact(audience, Events.DEVICE_OFFLINE, offlineFact(device), { details: deviceDetails(device) });
};

/** Warranty job: once per expiry date. Errors reach the job runner. */
const tellWarrantyEnding = async (device: TDevice): Promise<void> => {
  const audience = await loadAudience(device.farmId);
  if (!audience || !device.warrantyExpiry) return;
  await raiseFact(audience, Events.WARRANTY_EXPIRING, warrantyFact(device.deviceCode, device.warrantyExpiry), {
    details: deviceDetails(device),
    expiresAt: addDays(device.warrantyExpiry, DUE_KEEP_DAYS),
  });
};

/** A device synced, changed, was deactivated or deleted: clears what no longer holds (only the jobs tell). */
const deviceChanged = (farmId: TId, deviceCode: string) =>
  safely("device", async () => {
    const device = await DeviceModel.findOne({ deviceCode, farmId, isActive: true }).lean();
    if (device?.connectionStatus !== ConnectionStatuses.OFFLINE) {
      await expireRows(factFilter(farmId, Events.DEVICE_OFFLINE, `${deviceCode} `), true);
    }
    const expiry = device?.warrantyExpiry;
    await expireRows({
      $and: [
        factFilter(farmId, Events.WARRANTY_EXPIRING, `${deviceCode} `),
        ...(expiry ? [{ message: { $not: new RegExp(`^${escapeRegex(warrantyFact(deviceCode, expiry))}`) } }] : []),
      ],
    });
  });

/* ---------- jobs (errors reach the job runner) ---------- */

/** Open treatment / pregnancy events of animals that were sold, died or left the farm. */
const expireForInactiveAnimals = async (farmId: TId) => {
  const rows = await NotificationModel.find({
    farmId,
    status: NotificationStatuses.ACTIVE,
    title: { $in: [Events.CONTAGIOUS_DISEASE.title, Events.WITHDRAWAL_ACTIVE.title, Events.PREGNANCY_CONFIRMED.title] },
  })
    .select("referenceId")
    .lean();
  if (!rows.length) return;
  const ids = rows.map((row) => row.referenceId as TId);
  const records = [
    ...(await TreatmentModel.find({ _id: { $in: ids } }).select("animalId").lean()),
    ...(await PregnancyModel.find({ _id: { $in: ids } }).select("animalId").lean()),
  ];
  const active = await loadAnimals(farmId, records.map((record) => record.animalId));
  const kept = new Set(records.filter((r) => active.has(String(r.animalId))).map((r) => String(r._id)));
  const gone = rows.filter((row) => !kept.has(String(row.referenceId))).map((row) => row._id);
  if (gone.length) await expireRows({ _id: { $in: gone } });
};

const remindFarm = async (farmId: TId): Promise<void> => {
  const audience = await loadAudience(farmId);
  if (!audience) return;
  const failures: unknown[] = [];
  //one broken module must not silence the others
  for (const work of [
    () => syncVaccinations(farmId, audience),
    () => syncFollowUps(farmId, audience),
    () => syncPregnancyChecks(farmId, audience),
    () => syncCalvings(farmId, audience),
    async () => syncExpiry(farmId, audience, await loadItems(farmId), false),
    () => expireForInactiveAnimals(farmId),
  ]) {
    try {
      await work();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw failures[0];
};

/** Daily: every item, so members who joined later are told too. */
const sweepFarmStock = async (farmId: TId): Promise<void> =>
  syncStock(farmId, await loadAudience(farmId), await loadItems(farmId));

const expireDue = (): Promise<void> => expireRows({ expiresAt: { $ne: null, $lte: new Date() } });

export const NotificationProducers = {
  vaccinationChanged,
  treatmentChanged,
  breedingChanged,
  pregnancyChanged,
  feedPlansChanged,
  stockChanged,
  stockMoved,
  itemDeleted,
  deviceChanged,
  tellDeviceOffline,
  tellWarrantyEnding,
  remindFarm,
  sweepFarmStock,
  expireDue,
};
