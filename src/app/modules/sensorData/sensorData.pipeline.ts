/*
 * The one ingestion pipeline (plan 7 §7.2), shared by manual entry, CSV import and (phase B) the
 * machine route / MQTT worker. Callers authenticate the source and name the farm whose devices
 * may be used; everything else — the device, its farm, the assignment, the animal — is looked up
 * here. A farmId in a body is never read.
 *
 *  1. source authenticated (caller)   2. device found in the farm   3. device active (import: any)
 *  4. recordedAt ≤ now + 5 min and not older than the source's window
 *  5. the assignment valid AT recordedAt (assignedDate ≤ t < removedDate, not Cancelled)
 *  6. metrics normalized, rawPayload ≤ 8 kB   7. alerts   8. insert (duplicate = counted)
 *  9. after the insert: device state, notifications, live event
 */
import { mongo, Types } from "mongoose";
import { emitToUser } from "../../realtime/realtime.js";
import { recordDeviceSync } from "../device/device.links.js";
import { DeviceModel } from "../device/device.model.js";
import { AnimalModel } from "../animal/animal.model.js";
import { AssignmentStatuses } from "../deviceAssignment/deviceAssignment.constants.js";
import { DeviceAssignmentModel } from "../deviceAssignment/deviceAssignment.model.js";
import { escapeRegex } from "../feedRecord/feedRecord.utils.js";
import { loadAudience, recipientsOf } from "../notification/notification.delivery.js";
import { NotificationProducers } from "../notification/notification.producers.js";
import { evaluateRules, mapVendorAlerts, mergeAlerts } from "./sensorAlert.rules.js";
import {
  FUTURE_SKEW_MS,
  INSERT_CHUNK,
  LIVE_EVENT_MAX_READINGS,
  MACHINE_SOURCES,
  NOTIFY_MAX_AGE_HOURS,
  RAW_PAYLOAD_MAX_BYTES,
  SensorPermissions,
} from "./sensorData.constants.js";
import type { TSensorAlert, TSensorData, TSensorMetrics, TSensorSource } from "./sensorData.interface.js";
import { SensorDataModel } from "./sensorData.model.js";
import { byteLength, normalizeMetrics, parseMoment, RowError } from "./sensorData.utils.js";

type TId = Types.ObjectId;
const DAY_MS = 24 * 60 * 60 * 1000;

export type TIncomingReading = {
  //1-based position in the upload (CSV: the line number), echoed in the report
  row: number;
  device: { deviceId?: unknown; deviceCode?: unknown; serialNumber?: unknown };
  recordedAt: unknown;
  metrics: unknown;
  rawPayload?: unknown;
  vendorAlerts?: unknown;
};

export type TIngestOptions = {
  source: TSensorSource;
  //only devices of this farm are found; the reading's farm is the device's
  farmId: TId;
  maxAgeDays: number;
  //late data for a deactivated device: import only
  allowInactiveDevice?: boolean;
  //preview: everything but the insert
  dryRun?: boolean;
};

export type TRowStatus = "ready" | "inserted" | "duplicate" | "rejected";

export type TRowResult = {
  row: number;
  status: TRowStatus;
  reason?: string;
  readingId?: TId;
  recordedAt?: Date;
  device?: { _id: TId; deviceCode: string };
  animal?: { _id: TId; animalCode: string; name: string | null };
  assignmentNo?: string;
  metrics?: TSensorMetrics;
  alerts?: TSensorAlert[];
};

export type TIngestResult = {
  results: TRowResult[];
  summary: Record<TRowStatus, number> & { total: number };
  notified: number;
};

type TDeviceRow = { _id: TId; farmId: TId; deviceCode: string; serialNumber: string; isActive: boolean };
type TPeriod = { _id: TId; assignmentNo: string; animalId: TId; assignedDate: Date; removedDate: Date | null };

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/* ---------- 2. devices of the farm ---------- */

const loadDevices = async (farmId: TId, rows: TIncomingReading[]) => {
  const ids = new Set<string>();
  const codes = new Set<string>();
  const serials = new Set<string>();
  for (const { device } of rows) {
    if (device.deviceId instanceof Types.ObjectId) ids.add(String(device.deviceId));
    else if (Types.ObjectId.isValid(text(device.deviceId)) && text(device.deviceId).length === 24) ids.add(text(device.deviceId));
    if (text(device.deviceCode)) codes.add(text(device.deviceCode).toUpperCase());
    if (text(device.serialNumber)) serials.add(text(device.serialNumber).replace(/\s+/g, " ").toUpperCase());
  }
  const or: Record<string, unknown>[] = [];
  if (ids.size) or.push({ _id: { $in: [...ids].map((id) => new Types.ObjectId(id)) } });
  if (codes.size) or.push({ deviceCode: { $in: [...codes] } });
  if (serials.size) {
    //the serial index is case-insensitive per company; stored serials are upper-case anyway
    or.push({ serialNumber: { $in: [...serials].map((serial) => new RegExp(`^${escapeRegex(serial)}$`, "i")) } });
  }
  const devices = or.length
    ? await DeviceModel.find({ farmId, $or: or }).select("farmId deviceCode serialNumber isActive").lean<TDeviceRow[]>()
    : [];
  const byId = new Map(devices.map((d) => [String(d._id), d]));
  const byCode = new Map(devices.map((d) => [d.deviceCode, d]));
  const bySerial = new Map<string, TDeviceRow[]>();
  for (const d of devices) {
    const key = d.serialNumber.toUpperCase();
    bySerial.set(key, [...(bySerial.get(key) ?? []), d]);
  }
  return (ref: TIncomingReading["device"]): TDeviceRow => {
    const id = ref.deviceId instanceof Types.ObjectId ? String(ref.deviceId) : text(ref.deviceId);
    if (id) {
      const found = byId.get(id);
      if (!found) throw new RowError("Device not found in this farm!");
      return found;
    }
    const code = text(ref.deviceCode).toUpperCase();
    if (code) {
      const found = byCode.get(code);
      if (!found) throw new RowError(`Device ${code} not found in this farm!`);
      return found;
    }
    const serial = text(ref.serialNumber).replace(/\s+/g, " ").toUpperCase();
    if (serial) {
      const found = bySerial.get(serial) ?? [];
      if (found.length > 1) throw new RowError(`Serial number ${serial} belongs to more than one device: use deviceCode!`);
      if (!found[0]) throw new RowError(`No device with serial number ${serial} in this farm!`);
      return found[0];
    }
    throw new RowError("deviceCode or serialNumber is required!");
  };
};

/* ---------- 5. assignment valid at recordedAt ---------- */

const loadPeriods = async (deviceIds: TId[]) => {
  const rows = deviceIds.length
    ? await DeviceAssignmentModel.find({ deviceId: { $in: deviceIds }, status: { $ne: AssignmentStatuses.CANCELLED } })
        .select("assignmentNo deviceId animalId assignedDate removedDate")
        .sort({ assignedDate: 1 })
        .lean()
    : [];
  const byDevice = new Map<string, TPeriod[]>();
  for (const row of rows) {
    const key = String(row.deviceId);
    byDevice.set(key, [...(byDevice.get(key) ?? []), row as TPeriod]);
  }
  const animals = await AnimalModel.find({ _id: { $in: [...new Set(rows.map((r) => String(r.animalId)))] } })
    .select("animalCode name")
    .lean();
  const animalOf = new Map(animals.map((a) => [String(a._id), { _id: a._id, animalCode: a.animalCode, name: a.name ?? null }]));
  const periodAt = (deviceId: TId, at: Date): TPeriod => {
    const time = at.getTime();
    const period = (byDevice.get(String(deviceId)) ?? []).find(
      (p) => p.assignedDate.getTime() <= time && (p.removedDate === null || time < p.removedDate.getTime()),
    );
    if (!period) throw new RowError("The device was not assigned to an animal at that time!");
    return period;
  };
  return { periodAt, animalOf };
};

/* ---------- after the insert ---------- */

/** Battery only from the device's newest reading, so an out-of-order upload never moves it back. */
const updateDevices = async (source: TSensorSource, stored: (TSensorData & { _id: TId })[]) => {
  const machine = MACHINE_SOURCES.includes(source);
  const ids = new Set(stored.map((r) => String(r._id)));
  const byDevice = new Map<string, TId>();
  for (const reading of stored) byDevice.set(String(reading.deviceId), reading.deviceId);
  for (const deviceId of byDevice.values()) {
    const carriesBattery = stored.some((r) => r.deviceId.equals(deviceId) && r.metrics.batteryLevel !== undefined);
    let batteryLevel: number | undefined;
    if (carriesBattery) {
      const newest = await SensorDataModel.findOne({ deviceId, "metrics.batteryLevel": { $exists: true } })
        .sort({ recordedAt: -1 })
        .select("metrics.batteryLevel")
        .lean();
      if (newest && ids.has(String(newest._id))) batteryLevel = newest.metrics.batteryLevel;
    }
    if (machine || batteryLevel !== undefined) {
      await recordDeviceSync(deviceId, { source, ...(batteryLevel === undefined ? {} : { batteryLevel }) });
    }
  }
};

/** `sensor.alert` to the user rooms of the farm's readers (never a farm-wide room). */
const emitAlerts = async (farmId: TId, stored: (TSensorData & { _id: TId })[]) => {
  const fresh = stored.filter((r) => r.alerts.length && r.recordedAt.getTime() >= Date.now() - NOTIFY_MAX_AGE_HOURS * 3600 * 1000);
  if (!fresh.length) return;
  const audience = await loadAudience(farmId);
  if (!audience) return;
  const payload = {
    farmId: String(farmId),
    total: fresh.length,
    readings: fresh
      .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())
      .slice(0, LIVE_EVENT_MAX_READINGS)
      .map((r) => ({
        readingId: String(r._id),
        animalId: String(r.animalId),
        deviceId: String(r.deviceId),
        recordedAt: r.recordedAt.toISOString(),
        alerts: r.alerts.map(({ type, severity }) => ({ type, severity })),
      })),
  };
  for (const userId of recipientsOf(audience, SensorPermissions.READ)) emitToUser(userId, "sensor.alert", payload);
};

const insertAll = async (docs: (TSensorData & { _id: TId })[]) => {
  const failed = new Map<string, { duplicate: boolean; message: string }>();
  for (let start = 0; start < docs.length; start += INSERT_CHUNK) {
    const chunk = docs.slice(start, start + INSERT_CHUNK);
    try {
      await SensorDataModel.collection.insertMany(chunk, { ordered: false });
    } catch (error) {
      if (!(error instanceof mongo.MongoBulkWriteError)) throw error;
      const writeErrors = Array.isArray(error.writeErrors) ? error.writeErrors : [error.writeErrors];
      for (const writeError of writeErrors) {
        const doc = chunk[writeError.index];
        if (!doc) continue;
        failed.set(String(doc._id), { duplicate: writeError.code === 11000, message: writeError.errmsg ?? "Insert failed" });
      }
    }
  }
  return failed;
};

/* ---------- the pipeline ---------- */

export const ingestReadings = async (rows: TIncomingReading[], options: TIngestOptions): Promise<TIngestResult> => {
  const now = Date.now();
  const resolve = await loadDevices(options.farmId, rows);
  const resolved = rows.map((row) => {
    try {
      return resolve(row.device);
    } catch {
      return null;
    }
  });
  const deviceIds = [...new Map(resolved.filter(Boolean).map((d) => [String(d!._id), d!._id])).values()];
  const { periodAt, animalOf } = await loadPeriods(deviceIds);

  const results: TRowResult[] = [];
  const docs: (TSensorData & { _id: TId })[] = [];
  const docRow = new Map<string, TRowResult>();
  const seen = new Set<string>();

  for (const row of rows) {
    const result: TRowResult = { row: row.row, status: "rejected" };
    results.push(result);
    try {
      const device = resolve(row.device);
      result.device = { _id: device._id, deviceCode: device.deviceCode };
      if (!device.isActive && !options.allowInactiveDevice) throw new RowError("The device is deactivated!");

      const recordedAt = parseMoment(row.recordedAt);
      if (!recordedAt) throw new RowError("recordedAt must be a date and time (ISO 8601, e.g. 2026-11-20T08:30:00+06:00)!");
      result.recordedAt = recordedAt;
      if (recordedAt.getTime() > now + FUTURE_SKEW_MS) throw new RowError("recordedAt is in the future!");
      if (recordedAt.getTime() < now - options.maxAgeDays * DAY_MS) {
        throw new RowError(`recordedAt is older than ${options.maxAgeDays} days!`);
      }

      const period = periodAt(device._id, recordedAt);
      result.assignmentNo = period.assignmentNo;
      const animal = animalOf.get(String(period.animalId));
      if (animal) result.animal = animal;

      const metrics = normalizeMetrics(row.metrics);
      result.metrics = metrics;
      let rawPayload: Record<string, unknown> | undefined;
      if (row.rawPayload !== undefined && row.rawPayload !== null) {
        if (typeof row.rawPayload !== "object" || Array.isArray(row.rawPayload)) throw new RowError("rawPayload must be an object!");
        if (byteLength(row.rawPayload) > RAW_PAYLOAD_MAX_BYTES) {
          throw new RowError(`rawPayload cannot exceed ${RAW_PAYLOAD_MAX_BYTES / 1024} kB!`);
        }
        rawPayload = row.rawPayload as Record<string, unknown>;
      }
      const alerts = mergeAlerts(evaluateRules(metrics), mapVendorAlerts(row.vendorAlerts));
      result.alerts = alerts;

      const key = `${device._id}|${recordedAt.getTime()}`;
      if (seen.has(key)) {
        result.status = "duplicate";
        result.reason = "The same device and moment appear earlier in this upload.";
        continue;
      }
      seen.add(key);

      const doc: TSensorData & { _id: TId } = {
        _id: new Types.ObjectId(),
        //the farm comes from the device, never from the body
        farmId: device.farmId,
        deviceId: device._id,
        assignmentId: period._id,
        animalId: period.animalId,
        recordedAt,
        metrics,
        alerts,
        ...(rawPayload ? { rawPayload } : {}),
        source: options.source,
        createdAt: new Date(),
      };
      //the schema is the last guard against a value the parser let through
      const invalid = new SensorDataModel(doc).validateSync();
      if (invalid) throw new RowError(invalid.message);
      docs.push(doc);
      docRow.set(String(doc._id), result);
      result.status = "ready";
    } catch (error) {
      if (!(error instanceof RowError)) throw error;
      result.status = "rejected";
      result.reason = error.message;
    }
  }

  //already stored (the unique index decides on insert; this only names them in a preview)
  if (options.dryRun && docs.length) {
    const existing = new Set<string>();
    for (let start = 0; start < docs.length; start += INSERT_CHUNK) {
      const chunk = docs.slice(start, start + INSERT_CHUNK);
      const found = await SensorDataModel.find({ $or: chunk.map((d) => ({ deviceId: d.deviceId, recordedAt: d.recordedAt })) })
        .select("deviceId recordedAt")
        .lean();
      for (const f of found) existing.add(`${f.deviceId}|${f.recordedAt.getTime()}`);
    }
    for (const doc of docs) {
      if (!existing.has(`${doc.deviceId}|${doc.recordedAt.getTime()}`)) continue;
      const result = docRow.get(String(doc._id))!;
      result.status = "duplicate";
      result.reason = "Already stored.";
    }
  }

  let notified = 0;
  if (!options.dryRun && docs.length) {
    const failed = await insertAll(docs);
    for (const [id, failure] of failed) {
      const result = docRow.get(id)!;
      result.status = failure.duplicate ? "duplicate" : "rejected";
      result.reason = failure.duplicate ? "Already stored." : failure.message;
    }
    let stored = docs.filter((d) => !failed.has(String(d._id)));

    //an assignment cancelled while this upload ran: its readings must not stay (cancel = "never happened")
    const periodIds = [...new Set(stored.map((d) => String(d.assignmentId)))].map((id) => new Types.ObjectId(id));
    const cancelled = await DeviceAssignmentModel.find({ _id: { $in: periodIds }, status: AssignmentStatuses.CANCELLED })
      .select("_id")
      .lean();
    if (cancelled.length) {
      const gone = new Set(cancelled.map((c) => String(c._id)));
      const dropped = stored.filter((d) => gone.has(String(d.assignmentId)));
      await SensorDataModel.deleteMany({ _id: { $in: dropped.map((d) => d._id) } });
      for (const doc of dropped) {
        const result = docRow.get(String(doc._id))!;
        result.status = "rejected";
        result.reason = "The assignment was cancelled while this upload ran.";
      }
      stored = stored.filter((d) => !gone.has(String(d.assignmentId)));
    }

    for (const doc of stored) {
      const result = docRow.get(String(doc._id))!;
      result.status = "inserted";
      result.readingId = doc._id;
    }
    if (stored.length) {
      await updateDevices(options.source, stored);
      notified = await NotificationProducers.sensorReadingsStored(options.farmId, stored.filter((d) => d.alerts.length));
      try {
        await emitAlerts(options.farmId, stored);
      } catch (error) {
        console.log("[sensor] live event failed:", error instanceof Error ? error.message : error);
      }
    }
  }

  const summary = { total: results.length, ready: 0, inserted: 0, duplicate: 0, rejected: 0 };
  for (const result of results) summary[result.status] += 1;
  return { results, summary, notified };
};
