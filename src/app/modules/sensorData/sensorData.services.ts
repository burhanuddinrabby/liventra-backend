import status from "http-status";
import { isValidObjectId, Types } from "mongoose";
import type { PipelineStage } from "mongoose";
import config from "../../config/index.js";
import AppError from "../../errors/AppError.js";
import { requireRole, requireWritableFarm, resolveFarm } from "../../utils/farmAccess.js";
import type { TFarmContext } from "../../utils/farmAccess.js";
import { AnimalModel } from "../animal/animal.model.js";
import { AuditActions, AuditEntityTypes, AuditModules } from "../auditLog/auditLog.constants.js";
import { recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext } from "../auditLog/auditLog.utils.js";
import { BATTERY_LOW, DEVICE_CODE_PATTERN } from "../device/device.constants.js";
import { DeviceModel } from "../device/device.model.js";
import { ASSIGNMENT_NO_PATTERN, AssignmentStatuses } from "../deviceAssignment/deviceAssignment.constants.js";
import { DeviceAssignmentModel } from "../deviceAssignment/deviceAssignment.model.js";
import { escapeRegex, isBlank, pageMeta, parseEnum, parseEnumList, parsePaging } from "../feedRecord/feedRecord.utils.js";
import type { TPayload } from "../feedRecord/feedRecord.utils.js";
import { SENSOR_ALERT_RULES } from "./sensorAlert.rules.js";
import {
  ALERTS_DEFAULT_DAYS,
  CSV_DEVICE_COLUMNS,
  CSV_MAX_BYTES,
  CSV_MAX_ROWS,
  DASHBOARD_LIST_LIMIT,
  FUTURE_SKEW_MS,
  IMPORT_MAX_AGE_DAYS,
  LIST_DEFAULT_HOURS,
  LIST_MAX_DAYS,
  MACHINE_MAX_AGE_DAYS,
  METRIC_KEYS,
  NOTIFY_EVERY_HOURS,
  NOTIFY_MAX_AGE_HOURS,
  RAW_PAYLOAD_MAX_BYTES,
  SENSOR_MAX_LIMIT,
  SENSOR_METRICS,
  SensorAlertSeverities,
  SensorAlertTypes,
  SensorPermissions,
  SensorSources,
  STALE_AFTER_HOURS,
  TREND_DEFAULT_DAYS,
  TREND_MAX_DAYS,
  TrendBuckets,
} from "./sensorData.constants.js";
import type { TMetricKey } from "./sensorData.constants.js";
import { parseSensorCsv, SENSOR_CSV_TEMPLATE } from "./sensorData.csv.js";
import { SENSOR_INDEX_HINTS, SensorDataModel } from "./sensorData.model.js";
import { ingestReadings } from "./sensorData.pipeline.js";
import type { TIngestResult } from "./sensorData.pipeline.js";
import { parseMoment, zoneOffset } from "./sensorData.utils.js";

type TId = Types.ObjectId;
type TFilter = Record<string, unknown>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const bad = (message: string) => new AppError(status.BAD_REQUEST, message);

/* ---------- access ---------- */

const readAccess = async (farmId: string, requester: string): Promise<TFarmContext> => {
  const access = await resolveFarm(farmId, requester);
  requireRole(access, SensorPermissions.READ, "Your farm role cannot see sensor data!");
  return access;
};

const writeAccess = async (
  farmId: string,
  requester: string,
  roles: readonly string[],
  message: string,
): Promise<TFarmContext> => {
  const access = await resolveFarm(farmId, requester);
  requireRole(access, roles as typeof SensorPermissions.READ, message);
  requireWritableFarm(access);
  return access;
};

/* ---------- query parsing ---------- */

const parseRange = (query: TPayload, defaultMs: number, maxDays: number) => {
  const now = new Date();
  const toRaw = isBlank(query.to) ? null : parseMoment(query.to);
  if (!isBlank(query.to) && !toRaw) throw bad("to must be a date or date-time!");
  //a date-only `to` means the whole day
  const to = toRaw && /^\d{4}-\d{2}-\d{2}$/.test(String(query.to).trim()) ? new Date(toRaw.getTime() + DAY_MS) : (toRaw ?? new Date(now.getTime() + FUTURE_SKEW_MS));
  const from = isBlank(query.from) ? new Date(to.getTime() - defaultMs) : parseMoment(query.from);
  if (!from) throw bad("from must be a date or date-time!");
  if (from >= to) throw bad("from must be before to!");
  if (to.getTime() - from.getTime() > maxDays * DAY_MS + HOUR_MS) throw bad(`The range cannot exceed ${maxDays} days!`);
  return { from, to };
};

/** `_id` or the public code inside this farm; an unknown one matches nothing. */
const refId = async (access: TFarmContext, kind: "device" | "animal" | "assignment", value: unknown): Promise<TId> => {
  const ref = typeof value === "string" ? value.trim() : "";
  const nothing = new Types.ObjectId("000000000000000000000000");
  if (!ref) return nothing;
  const farmId = access.farm._id;
  if (isValidObjectId(ref) && ref.length === 24) return new Types.ObjectId(ref);
  if (kind === "device" && DEVICE_CODE_PATTERN.test(ref)) {
    return (await DeviceModel.findOne({ farmId, deviceCode: ref.toUpperCase() }).select("_id").lean())?._id ?? nothing;
  }
  if (kind === "assignment" && ASSIGNMENT_NO_PATTERN.test(ref)) {
    return (await DeviceAssignmentModel.findOne({ farmId, assignmentNo: ref.toUpperCase() }).select("_id").lean())?._id ?? nothing;
  }
  if (kind === "animal") {
    const animal = await AnimalModel.findOne({ farmId, animalCode: new RegExp(`^${escapeRegex(ref)}$`, "i") }).select("_id").lean();
    return animal?._id ?? nothing;
  }
  return nothing;
};

const ALERT_TYPES = Object.values(SensorAlertTypes);
const SEVERITIES = Object.values(SensorAlertSeverities);

const alertFilter = (query: TPayload): TFilter | null => {
  const types = isBlank(query.alertType) ? null : parseEnumList("alertType", query.alertType, ALERT_TYPES);
  const severities = isBlank(query.severity) ? null : parseEnumList("severity", query.severity, SEVERITIES);
  if (types || severities) {
    return {
      alerts: {
        $elemMatch: { ...(types ? { type: { $in: types } } : {}), ...(severities ? { severity: { $in: severities } } : {}) },
      },
    };
  }
  if (isBlank(query.alert)) return null;
  const wanted = parseEnum("alert", query.alert, ["any", "none"]);
  return wanted === "any" ? { "alerts.type": { $exists: true } } : { "alerts.type": { $exists: false } };
};

/* ---------- shaping ---------- */

const POPULATE = [
  { path: "deviceId", select: "deviceCode deviceType company model serialNumber batteryLevel isActive" },
  { path: "animalId", select: "animalCode name tagNumber lifeStatus" },
  { path: "assignmentId", select: "assignmentNo status assignedDate removedDate" },
];

const listFields = "-rawPayload";

/* ---------- reads ---------- */

const getReadings = async (farmId: string, requester: string, query: TPayload) => {
  const access = await readAccess(farmId, requester);
  const { page, limit, skip } = parsePaging(query, SENSOR_MAX_LIMIT, 50);
  const { from, to } = parseRange(query, LIST_DEFAULT_HOURS * HOUR_MS, LIST_MAX_DAYS);
  const where: TFilter = { farmId: access.farm._id, recordedAt: { $gte: from, $lt: to } };
  let hint: object = SENSOR_INDEX_HINTS.farm;
  if (!isBlank(query.device)) {
    where.deviceId = await refId(access, "device", query.device);
    hint = { deviceId: 1, recordedAt: 1 };
  }
  if (!isBlank(query.assignment)) {
    where.assignmentId = await refId(access, "assignment", query.assignment);
    hint = SENSOR_INDEX_HINTS.assignment;
  }
  if (!isBlank(query.animal)) {
    where.animalId = await refId(access, "animal", query.animal);
    hint = SENSOR_INDEX_HINTS.animal;
  }
  if (!isBlank(query.source)) where.source = { $in: parseEnumList("source", query.source, Object.values(SensorSources)) };
  const alerts = alertFilter(query);
  if (alerts) Object.assign(where, alerts);
  const order = isBlank(query.sort) ? "-recordedAt" : parseEnum("sort", query.sort, ["recordedAt", "-recordedAt"]);

  const [total, readings] = await Promise.all([
    SensorDataModel.countDocuments(where).hint(hint),
    SensorDataModel.find(where)
      .select(listFields)
      .sort({ recordedAt: order === "recordedAt" ? 1 : -1, _id: 1 })
      .skip(skip)
      .limit(limit)
      .hint(hint)
      .populate(POPULATE)
      .lean(),
  ]);
  return { meta: { ...pageMeta(page, limit, total), from, to }, readings };
};

const getReading = async (farmId: string, requester: string, id: string) => {
  const access = await readAccess(farmId, requester);
  if (!isValidObjectId(id)) throw new AppError(status.NOT_FOUND, "Reading not found!");
  const reading = await SensorDataModel.findOne({ _id: new Types.ObjectId(id), farmId: access.farm._id }).populate(POPULATE).lean();
  if (!reading) throw new AppError(status.NOT_FOUND, "Reading not found!");
  const canRaw = SensorPermissions.RAW.includes(access.role);
  const hasRaw = reading.rawPayload !== undefined && reading.rawPayload !== null;
  const { rawPayload, ...rest } = reading;
  return {
    ...rest,
    ...(canRaw && hasRaw ? { rawPayload } : {}),
    rawPayloadHidden: hasRaw && !canRaw,
    observationNote: "Sensor alerts are observations, not a diagnosis.",
  };
};

/**
 * The zone's offset when it is the same across the whole range (checked every 15 days and at
 * both ends), else null. Asia/Dhaka never changes, so its buckets need no time-zone lookups.
 */
const fixedOffset = (from: Date, to: Date, timezone: string): number | null => {
  const first = zoneOffset(from.getTime(), timezone);
  for (let t = from.getTime(); t < to.getTime(); t += 15 * DAY_MS) if (zoneOffset(t, timezone) !== first) return null;
  return zoneOffset(to.getTime(), timezone) === first ? first : null;
};

/**
 * Per bucket and metric: avg / min / max. A bucket without a value for a metric has a null
 * average (a gap, never 0). With a fixed offset the bucket start is plain arithmetic, which is
 * several times cheaper than $dateTrunc with a time zone on large ranges (500 k rows test).
 */
export const trendPipeline = (
  match: TFilter,
  unit: "hour" | "day",
  timezone: string,
  metrics: readonly TMetricKey[],
  offset: number | null,
): PipelineStage[] => {
  const size = unit === "hour" ? HOUR_MS : DAY_MS;
  const group: Record<string, unknown> = {
    _id:
      offset === null
        ? { $dateTrunc: { date: "$recordedAt", unit, timezone } }
        : { $subtract: ["$recordedAt", { $mod: [{ $add: [{ $toLong: "$recordedAt" }, offset] }, size] }] },
    count: { $sum: 1 },
  };
  for (const key of metrics) {
    const field = `$metrics.${key}`;
    group[`${key}__avg`] = { $avg: field };
    group[`${key}__min`] = { $min: field };
    group[`${key}__max`] = { $max: field };
  }
  return [{ $match: match }, { $group: group } as PipelineStage, { $sort: { _id: 1 } }];
};

const getTrends = async (farmId: string, requester: string, query: TPayload) => {
  const access = await readAccess(farmId, requester);
  const hasAnimal = !isBlank(query.animal);
  const hasDevice = !isBlank(query.device);
  if (hasAnimal === hasDevice) throw bad("Choose one animal or one device!");
  const bucket = (isBlank(query.bucket) ? TrendBuckets.DAY : parseEnum("bucket", query.bucket, Object.values(TrendBuckets))) as
    | "hour"
    | "day";
  const { from, to } = parseRange(query, TREND_DEFAULT_DAYS * DAY_MS, TREND_MAX_DAYS[bucket]);
  const metrics = isBlank(query.metrics) ? METRIC_KEYS : (parseEnumList("metrics", query.metrics, METRIC_KEYS) as TMetricKey[]);

  const match: TFilter = { recordedAt: { $gte: from, $lt: to } };
  let hint: object | string;
  let scope: TPayload;
  if (hasAnimal) {
    match.animalId = await refId(access, "animal", query.animal);
    hint = SENSOR_INDEX_HINTS.animal;
    scope = { animal: await AnimalModel.findOne({ _id: match.animalId, farmId: access.farm._id }).select("animalCode name").lean() };
  } else {
    match.deviceId = await refId(access, "device", query.device);
    hint = SENSOR_INDEX_HINTS.device;
    scope = {
      device: await DeviceModel.findOne({ _id: match.deviceId, farmId: access.farm._id }).select("deviceCode deviceType").lean(),
    };
  }
  //an id of another farm finds nothing
  match.farmId = access.farm._id;
  const rows = await SensorDataModel.aggregate<Record<string, unknown> & { _id: Date; count: number }>(
    trendPipeline(match, bucket, config.app_timezone, metrics, fixedOffset(from, to, config.app_timezone)),
  ).option({ hint });
  const points = rows.map((row) => ({
    t: row._id,
    count: row.count,
    values: Object.fromEntries(
      metrics.map((key) => [
        key,
        row[`${key}__avg`] === null || row[`${key}__avg`] === undefined
          ? null
          : { avg: row[`${key}__avg`] as number, min: row[`${key}__min`] as number, max: row[`${key}__max`] as number },
      ]),
    ),
  }));
  return {
    bucket,
    from,
    to,
    timezone: config.app_timezone,
    ...scope,
    metrics: metrics.map((key) => ({ key, unit: SENSOR_METRICS[key].unit })),
    points,
  };
};

type TLatestRow = {
  animal: { _id: TId; animalCode: string; name: string | null; lifeStatus: string } | null;
  devices: { _id: TId; deviceCode: string; deviceType: string; batteryLevel: number | null; assignmentNo: string }[];
  reading: Record<string, unknown> | null;
  stale: boolean;
};

/** Newest reading per monitored animal (animals wearing a device now, or the one asked for). */
const getLatest = async (farmId: string, requester: string, query: TPayload) => {
  const access = await readAccess(farmId, requester);
  const farm = access.farm._id;
  const oneAnimal = isBlank(query.animal) ? null : await refId(access, "animal", query.animal);
  const assignments = await DeviceAssignmentModel.find({
    farmId: farm,
    status: AssignmentStatuses.ACTIVE,
    ...(oneAnimal ? { animalId: oneAnimal } : {}),
  })
    .select("assignmentNo deviceId animalId")
    .populate<{ deviceId: { _id: TId; deviceCode: string; deviceType: string; batteryLevel: number | null } | null }>(
      "deviceId",
      "deviceCode deviceType batteryLevel",
    )
    .lean();
  const animalIds = oneAnimal ? [oneAnimal] : [...new Map(assignments.map((a) => [String(a.animalId), a.animalId])).values()];
  const animals = await AnimalModel.find({ farmId: farm, _id: { $in: animalIds } }).select("animalCode name lifeStatus").lean();
  const animalOf = new Map(animals.map((a) => [String(a._id), a]));
  const staleBefore = Date.now() - STALE_AFTER_HOURS * HOUR_MS;

  const rows: TLatestRow[] = [];
  for (const animalId of animalIds) {
    const animal = animalOf.get(String(animalId));
    if (!animal) continue;
    const reading = await SensorDataModel.findOne({ animalId, farmId: farm })
      .sort({ recordedAt: -1 })
      .hint(SENSOR_INDEX_HINTS.animal)
      .select(listFields)
      .populate({ path: "deviceId", select: "deviceCode deviceType" })
      .lean();
    rows.push({
      animal: { _id: animal._id, animalCode: animal.animalCode, name: animal.name ?? null, lifeStatus: animal.lifeStatus },
      devices: assignments
        .filter((a) => a.animalId.equals(animalId) && a.deviceId)
        .map((a) => ({ ...a.deviceId!, assignmentNo: a.assignmentNo })),
      reading: reading as Record<string, unknown> | null,
      stale: !reading || reading.recordedAt.getTime() < staleBefore,
    });
  }
  rows.sort((a, b) => {
    const at = (row: TLatestRow) => (row.reading?.recordedAt as Date | undefined)?.getTime() ?? 0;
    return at(b) - at(a) || String(a.animal?.animalCode).localeCompare(String(b.animal?.animalCode));
  });
  return rows;
};

const getAlerts = async (farmId: string, requester: string, query: TPayload) => {
  const access = await readAccess(farmId, requester);
  const { page, limit, skip } = parsePaging(query, SENSOR_MAX_LIMIT, 20);
  const { from, to } = parseRange(query, ALERTS_DEFAULT_DAYS * DAY_MS, LIST_MAX_DAYS);
  const where: TFilter = { farmId: access.farm._id, recordedAt: { $gte: from, $lt: to }, "alerts.type": { $exists: true } };
  let hint: object | string = SENSOR_INDEX_HINTS.alerts;
  if (!isBlank(query.animal)) {
    where.animalId = await refId(access, "animal", query.animal);
    hint = SENSOR_INDEX_HINTS.animal;
  }
  if (!isBlank(query.device)) {
    where.deviceId = await refId(access, "device", query.device);
    hint = SENSOR_INDEX_HINTS.device;
  }
  const alerts = alertFilter(query);
  if (alerts && "alerts" in alerts) Object.assign(where, alerts);
  const [total, readings] = await Promise.all([
    SensorDataModel.countDocuments(where).hint(hint),
    SensorDataModel.find(where)
      .select(listFields)
      .sort({ recordedAt: -1, _id: 1 })
      .skip(skip)
      .limit(limit)
      .hint(hint)
      .populate(POPULATE)
      .lean(),
  ]);
  return { meta: { ...pageMeta(page, limit, total), from, to }, readings };
};

const getDashboard = async (farmId: string, requester: string) => {
  const access = await readAccess(farmId, requester);
  const farm = access.farm._id;
  const now = Date.now();
  const day = new Date(now - DAY_MS);
  const week = new Date(now - 7 * DAY_MS);

  const active = await DeviceAssignmentModel.find({ farmId: farm, status: AssignmentStatuses.ACTIVE })
    .select("animalId deviceId")
    .lean();
  const monitoredIds = [...new Map(active.map((a) => [String(a.animalId), a.animalId])).values()];

  const [readings24h, readings7d, bySource, alertGroups, recentAlerts, reportingAnimals, lowBattery] = await Promise.all([
    SensorDataModel.countDocuments({ farmId: farm, recordedAt: { $gte: day } }).hint(SENSOR_INDEX_HINTS.farm),
    SensorDataModel.countDocuments({ farmId: farm, recordedAt: { $gte: week } }).hint(SENSOR_INDEX_HINTS.farm),
    SensorDataModel.aggregate<{ _id: string; count: number }>([
      { $match: { farmId: farm, recordedAt: { $gte: week } } },
      { $group: { _id: "$source", count: { $sum: 1 } } },
    ]).option({ hint: SENSOR_INDEX_HINTS.farm }),
    SensorDataModel.aggregate<{ _id: { type: string; severity: string }; count: number }>([
      { $match: { farmId: farm, recordedAt: { $gte: day }, "alerts.type": { $exists: true } } },
      { $unwind: "$alerts" },
      { $group: { _id: { type: "$alerts.type", severity: "$alerts.severity" }, count: { $sum: 1 } } },
    ]).option({ hint: SENSOR_INDEX_HINTS.alerts }),
    SensorDataModel.find({ farmId: farm, recordedAt: { $gte: week }, "alerts.type": { $exists: true } })
      .select(listFields)
      .sort({ recordedAt: -1 })
      .limit(DASHBOARD_LIST_LIMIT)
      .hint(SENSOR_INDEX_HINTS.alerts)
      .populate(POPULATE)
      .lean(),
    monitoredIds.length
      ? SensorDataModel.distinct("animalId", { animalId: { $in: monitoredIds }, recordedAt: { $gte: day } })
      : Promise.resolve([] as TId[]),
    DeviceModel.countDocuments({
      farmId: farm,
      isActive: true,
      _id: { $in: active.map((a) => a.deviceId) },
      batteryLevel: { $ne: null, $lte: BATTERY_LOW },
    }),
  ]);

  const reporting = new Set(reportingAnimals.map(String));
  const silentIds = monitoredIds.filter((id) => !reporting.has(String(id)));
  const silent = await AnimalModel.find({ _id: { $in: silentIds.slice(0, DASHBOARD_LIST_LIMIT) } })
    .select("animalCode name")
    .lean();
  const alerts24h = { total: 0, bySeverity: {} as Record<string, number>, byType: {} as Record<string, number> };
  for (const group of alertGroups) {
    alerts24h.total += group.count;
    alerts24h.bySeverity[group._id.severity] = (alerts24h.bySeverity[group._id.severity] ?? 0) + group.count;
    alerts24h.byType[group._id.type] = (alerts24h.byType[group._id.type] ?? 0) + group.count;
  }
  return {
    monitoredAnimals: monitoredIds.length,
    assignedDevices: active.length,
    reportingAnimals24h: reporting.size,
    silentAnimals: { count: silentIds.length, animals: silent },
    readings24h,
    readings7d,
    bySource7d: Object.fromEntries(bySource.map((row) => [row._id, row.count])),
    alerts24h,
    lowBatteryDevices: lowBattery,
    recentAlerts,
  };
};

const getMeta = async (farmId: string, requester: string) => {
  const access = await readAccess(farmId, requester);
  const role = access.role;
  return {
    metrics: METRIC_KEYS.map((key) => ({ key, ...SENSOR_METRICS[key] })),
    sources: Object.values(SensorSources),
    alertTypes: ALERT_TYPES,
    severities: SEVERITIES,
    rules: SENSOR_ALERT_RULES,
    csv: { requiredColumns: ["recordedAt"], deviceColumns: CSV_DEVICE_COLUMNS, metricColumns: METRIC_KEYS, maxRows: CSV_MAX_ROWS, maxBytes: CSV_MAX_BYTES, timezone: config.app_timezone },
    limits: {
      futureMinutes: FUTURE_SKEW_MS / 60000,
      importMaxAgeDays: IMPORT_MAX_AGE_DAYS,
      machineMaxAgeDays: MACHINE_MAX_AGE_DAYS,
      rawPayloadBytes: RAW_PAYLOAD_MAX_BYTES,
      listDefaultHours: LIST_DEFAULT_HOURS,
      listMaxDays: LIST_MAX_DAYS,
      trendMaxDays: TREND_MAX_DAYS,
      staleAfterHours: STALE_AFTER_HOURS,
      notifyEveryHours: NOTIFY_EVERY_HOURS,
      notifyMaxAgeHours: NOTIFY_MAX_AGE_HOURS,
    },
    permissions: {
      read: true,
      manual: SensorPermissions.MANUAL.includes(role),
      import: SensorPermissions.IMPORT.includes(role),
      rawPayload: SensorPermissions.RAW.includes(role),
    },
  };
};

/* ---------- writes ---------- */

//a farmId in the body is accepted and ignored: the farm comes from the device
const MANUAL_KEYS = ["deviceId", "deviceCode", "serialNumber", "recordedAt", "metrics", "farmId"];

const createReading = async (farmId: string, requester: string, body: TPayload, context: TAuditContext) => {
  const access = await writeAccess(farmId, requester, SensorPermissions.MANUAL, "Only the owner, a manager or a veterinarian can enter readings!");
  const unknown = Object.keys(body).filter((key) => !MANUAL_KEYS.includes(key));
  if (unknown.length) throw bad(`Unknown field: ${unknown.join(", ")}!`);
  if (isBlank(body.recordedAt)) throw bad("recordedAt is required!");
  if (body.metrics === undefined) throw bad("metrics is required!");

  const { results } = await ingestReadings(
    [
      {
        row: 1,
        device: { deviceId: body.deviceId, deviceCode: body.deviceCode, serialNumber: body.serialNumber },
        recordedAt: body.recordedAt,
        metrics: body.metrics,
      },
    ],
    { source: SensorSources.MANUAL_IMPORT, farmId: access.farm._id, maxAgeDays: IMPORT_MAX_AGE_DAYS },
  );
  const [result] = results;
  if (!result) throw bad("Nothing to save!");
  if (result.status === "duplicate") throw new AppError(status.CONFLICT, "This device already has a reading at this moment!");
  if (result.status !== "inserted" || !result.readingId) {
    const notFound = /not found|No device/i.test(result.reason ?? "");
    throw new AppError(notFound ? status.NOT_FOUND : status.BAD_REQUEST, result.reason ?? "The reading was refused!");
  }
  await recordAuditLog({
    context,
    farmId: access.farm._id,
    entityType: AuditEntityTypes.DEVICE,
    entityId: result.device?._id ?? null,
    action: AuditActions.CREATE,
    module: AuditModules.FARM,
    event: "Sensor Reading Entered",
    newData: {
      readingId: result.readingId,
      deviceCode: result.device?.deviceCode ?? null,
      animalCode: result.animal?.animalCode ?? null,
      assignmentNo: result.assignmentNo ?? null,
      recordedAt: result.recordedAt ?? null,
      metrics: result.metrics ?? {},
      source: SensorSources.MANUAL_IMPORT,
    },
  });
  return getReading(farmId, requester, String(result.readingId));
};

const shapeImport = (outcome: TIngestResult) => ({
  summary: outcome.summary,
  notified: outcome.notified,
  rows: outcome.results.map((row) => ({
    row: row.row,
    status: row.status,
    reason: row.reason ?? null,
    readingId: row.readingId ?? null,
    recordedAt: row.recordedAt ?? null,
    deviceCode: row.device?.deviceCode ?? null,
    animal: row.animal ?? null,
    assignmentNo: row.assignmentNo ?? null,
    metrics: row.metrics ?? null,
    alerts: row.alerts ?? [],
  })),
});

const importAccess = (farmId: string, requester: string) =>
  writeAccess(farmId, requester, SensorPermissions.IMPORT, "Only the farm owner or a manager can import sensor data!");

const runImport = async (access: TFarmContext, file: Express.Multer.File | undefined, dryRun: boolean) => {
  const { rows } = parseSensorCsv(file);
  return ingestReadings(rows, {
    source: SensorSources.MANUAL_IMPORT,
    farmId: access.farm._id,
    maxAgeDays: IMPORT_MAX_AGE_DAYS,
    allowInactiveDevice: true,
    dryRun,
  });
};

/** Every check of the import, nothing stored. */
const previewImport = async (farmId: string, requester: string, file: Express.Multer.File | undefined) => {
  const access = await importAccess(farmId, requester);
  return shapeImport(await runImport(access, file, true));
};

/** Audited once per file (action Import, entity Device), never per row. */
const importReadings = async (farmId: string, requester: string, file: Express.Multer.File | undefined, context: TAuditContext) => {
  const access = await importAccess(farmId, requester);
  const outcome = await runImport(access, file, false);
  const devices = [...new Map(outcome.results.filter((r) => r.device).map((r) => [String(r.device!._id), r.device!])).values()];
  if (outcome.summary.inserted > 0) {
    await recordAuditLog({
      context,
      farmId: access.farm._id,
      entityType: AuditEntityTypes.DEVICE,
      entityId: devices.length === 1 ? devices[0]!._id : null,
      action: AuditActions.IMPORT,
      module: AuditModules.FARM,
      event: "Sensor Data Imported",
      newData: {
        fileName: file?.originalname?.slice(0, 200) ?? null,
        rows: outcome.summary.total,
        inserted: outcome.summary.inserted,
        duplicate: outcome.summary.duplicate,
        rejected: outcome.summary.rejected,
        devices: devices.map((d) => d.deviceCode),
      },
    });
  }
  return shapeImport(outcome);
};

const getTemplate = async (farmId: string, requester: string) => {
  await importAccess(farmId, requester);
  return SENSOR_CSV_TEMPLATE();
};

export const SensorDataServices = {
  createReading,
  previewImport,
  importReadings,
  getTemplate,
  getReadings,
  getReading,
  getTrends,
  getLatest,
  getAlerts,
  getDashboard,
  getMeta,
};
