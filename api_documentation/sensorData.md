# Sensor Data (Model 27, plan 7 phase A)

Readings from collars, boluses, ear tags and meters: one row per device and moment. Mounted at
`/api/v1/farms/:farmId/sensor-data` (`:farmId` is the `_id` or the `FARM-…` code). Every route needs a signed-in user;
farm rules come from the `FarmMember` role (platform superAdmin acts as Owner, admin gets no bypass).

**Readings are evidence.** There is no PUT, PATCH or DELETE. They leave only with a permanent farm delete
(`FARM_DATA_SOURCES`).

**Alerts are observations, not a diagnosis.** They never change `Animal.healthStatus` and never create a Treatment.

Phase B (`DeviceCredential` and the machine ingest route for API / MQTT / Bluetooth) is **not built**. The pipeline
already takes a `source`, so that route only has to call it.

## Model (`sensordatas`)

| Field | Notes |
|---|---|
| `farmId`, `deviceId`, `assignmentId`, `animalId` | Set by the server. The farm is the device's farm; the assignment is the one valid at `recordedAt`. |
| `recordedAt` | When the device measured, not when it was uploaded. |
| `metrics` | See below. A missing metric is **absent, never 0**. |
| `alerts[]` | `{ type, severity, message }`, worked out by the server. |
| `rawPayload` | Optional object, at most 8 kB. The CSV import stores `{ csvLine, …columns }`. Only the Owner can read it. |
| `source` | `API` \| `MQTT` \| `Bluetooth` \| `Manual Import`. Manual entry and CSV are always `Manual Import`. |
| `createdAt` | When it was stored. There is no `updatedAt`. Every field is immutable. |

It is a normal collection, not a time-series one. Indexes:

| Index | Name / role |
|---|---|
| `{deviceId:1, recordedAt:1}` | Unique, `one_reading_per_device_and_moment`. This is the duplicate guard. |
| `{farmId:1, recordedAt:-1}` | — |
| `{animalId:1, recordedAt:-1}` | — |
| `{assignmentId:1, recordedAt:-1}` | — |
| `{farmId:1, recordedAt:-1, "alerts.type":1}` | Partial index `alerts_by_farm`, only on rows that carry an alert. |

Reads pass these indexes as hints.

### Metrics and units (fixed by the app)

| Key | Unit | Rule |
|---|---|---|
| `bodyTemperature` | °C | −50 … 100 |
| `ruminationMinutes` | min / 24 h | 0 … 1440 |
| `activityScore` | score | ≥ 0 |
| `steps` | steps | whole number ≥ 0 |
| `waterIntake` | L | ≥ 0 |
| `feedIntake` | kg | ≥ 0 |
| `milkYield` | L | ≥ 0 |
| `heartRate` | beats/min | ≥ 0 |
| `respirationRate` | breaths/min | ≥ 0 |
| `batteryLevel` | % | 0 … 100 |

Unknown keys are refused. At least one metric is required. Values must be finite numbers. An empty CSV cell or a
missing key leaves the metric out.

## The single ingestion pipeline (`sensorData.pipeline.ts`)

Manual entry, CSV preview, CSV import and the future machine route all call
`ingestReadings(rows, { source, farmId, maxAgeDays, allowInactiveDevice?, dryRun? })`. Each row runs these steps:

1. **Device.** By `deviceId`, `deviceCode` or `serialNumber`, inside this farm only. A serial shared by two devices is
   refused ("use deviceCode"). A deactivated device is refused, except in CSV import, which may bring late data.
2. **recordedAt.** ISO 8601. A value without an offset is wall-clock time in `APP_TIMEZONE` (Asia/Dhaka by default),
   and a date alone means midnight. At most 5 minutes in the future. At most 2 years old for manual entry and import,
   30 days for machine sources.
3. **Metrics.** Checked as in the table above.
4. **rawPayload.** Must be an object of at most 8 kB.
5. **Assignment valid at `recordedAt`.** The period with `assignedDate <= t < removedDate` (or no `removedDate`) that
   is **not Cancelled**. The animal comes from that period, not from today's assignment, so a reading taken before a
   reassignment and uploaded after it goes to the old animal. No period means the row is refused: "The device was not
   assigned to an animal at that time!".
6. **Alerts.** The battery rules, plus vendor alerts mapped by word when a machine source sends them.
7. **Duplicates.** A repeat of the same device and moment, earlier in the upload or already stored, is **counted, not
   an error**. Importing the same file twice inserts 0.
8. **Insert.** Unordered `insertMany` in chunks of 1000. A duplicate-key error (11000) becomes a duplicate. If an
   assignment was cancelled while the upload ran, its rows are taken out again.
9. **After commit:**
   - **Device state.** `batteryLevel` comes from the device's newest reading that carries a battery value, so an
     out-of-order upload never overwrites a newer value. `recordDeviceSync()` (in `device.links.ts`) runs. Only
     `API` / `MQTT` / `Bluetooth` set `lastSyncAt`, Online (Maintenance is kept) and firmware. **Manual entry and
     import never set Online.**
   - **Notifications.** See Alerts below.
   - **Live event.** `sensor.alert`, only for readings under 24 h old.

The result has one entry per row: `ready` | `inserted` | `duplicate` | `rejected`, with a `reason`. It also returns a
summary `{ total, ready, inserted, duplicate, rejected }` and `notified`.

## Alerts and notifications

| Rule | Threshold | Severity | State |
|---|---|---|---|
| `battery-critical` | `batteryLevel <= 10` | High | **on** |
| `battery-low` | `batteryLevel <= 20` | Medium | **on** |
| Temperature, rumination, activity, … | `threshold: null` | — | off |

Only the battery rules are on. The medical rules exist but have no threshold, so they stay off until a vet sets the
values. Each type keeps only its most severe hit.

Notifications use the reference type `SensorData`, and `referenceId` is the reading. The UI links it to
`/farms/:farmId/sensor-data/:id`.

| Title | When | Type / priority | Roles |
|---|---|---|---|
| Sensor Battery Low | battery Medium | Warning / Medium | Owner, Manager |
| Sensor Battery Critical | battery High | Warning / High | Owner, Manager |
| Sensor Alert | any High alert (non-battery) | Alert / High | Owner, Manager, Vet |
| Sensor Alert Critical | any Critical alert | Alert / Critical | Owner, Manager, Vet |

Limits (plan 7 §7.3):
- At most one notification per animal and title in 6 hours.
- Only readings under 24 hours old notify, so a 3-month CSV sends nothing for its old rows.
- Only the newest reading per animal and title in one upload counts.

Message: `AN-000001: <alert messages> at 2026-11-26 07:49 UTC (Rani). Observation, not a diagnosis.` Rows expire after
3 days. Producers never throw.

**Live event `sensor.alert`.** Sent to the **user rooms** of the farm's readers (Owner, Manager, Vet, Worker), never to
a farm-wide room. It is a hint only:
`{ farmId, total, readings: [{ readingId, animalId, deviceId, recordedAt, alerts }] }` (at most 20). Fetch the details
through the API.

## Roles

| Action | Owner | Manager | Veterinarian | Worker | Accountant |
|---|---|---|---|---|---|
| Read (list, latest, trends, dashboard, alerts, meta, detail) | ✓ | ✓ | ✓ | ✓ | — |
| Manual entry | ✓ | ✓ | ✓ | — | — |
| CSV preview / import / template | ✓ | ✓ | — | — | — |
| See `rawPayload` | ✓ | — | — | — | — |

Writes need an Active farm.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/` | Raw readings, newest first. |
| GET | `/latest` | Newest reading per monitored animal. |
| GET | `/trends` | Buckets for one animal or one device. |
| GET | `/dashboard` | Counts for the overview page. |
| GET | `/alerts` | Readings that carry an alert. |
| GET | `/meta` | Units, rules, CSV columns, limits and the caller's permissions. |
| GET | `/import/template` | CSV with the header and one sample row (`text/csv`, attachment). |
| POST | `/` | Manual entry. |
| POST | `/import/preview` | Multipart field `file`. Every check runs; nothing is stored. |
| POST | `/import` | The same, and stores the ready rows. |
| GET | `/:id` | One reading. |

The literal paths are mounted before `/:id`.

### `GET /` and `GET /alerts`

Query parameters:
- `device`, `animal`, `assignment`: `_id` or code. An unknown value matches nothing.
- `source`.
- `alert=any|none`, `alertType`, `severity`.
- `from`, `to`: a date or a date-time. A date-only `to` means the whole day.
- `sort=-recordedAt|recordedAt`.
- `page`, `limit`: default 50, max 100.

The default range is the last 24 h for `/` and 7 days for `/alerts`. The maximum is 31 days (+1 h tolerance); a longer
range is a 400. Device, animal and assignment are populated. `rawPayload` is never in a list.

### `GET /:id`

The reading, populated. The Owner gets `rawPayload`; everyone else gets `rawPayloadHidden: true` when one exists. Every
answer includes `observationNote`. A reading of another farm is a 404.

### `GET /trends`

Query parameters:
- Exactly one of `animal` or `device` (`_id` or code).
- `bucket=hour|day`.
- `from`, `to`: the default is 7 days; hour allows at most 31 days, day at most 366.
- `metrics`: a comma list, default all.

Answer:
`{ bucket, from, to, timezone, animal | device, metrics: [{key, unit}], points: [{ t, count, values: { <key>: { avg, min, max } | null } }] }`.

- Buckets are aligned to `APP_TIMEZONE`.
- A bucket without a value for a metric has `null`, which is a **gap, never 0**. Buckets with no reading at all are
  absent, so the client draws a gap there.
- When the zone's offset is fixed over the range (Asia/Dhaka always), the bucket start is plain arithmetic. Otherwise
  it uses `$dateTrunc` with the zone.

### `GET /latest`

Lists animals that wear a device now, or only `?animal=` (that one even without a current device).

Each row: `{ animal, devices: [{ _id, deviceCode, deviceType, batteryLevel, assignmentNo }], reading | null, stale }`.
`stale` means there was no reading in 24 h. Sorted newest first.

### `GET /dashboard`

- `monitoredAnimals`, `assignedDevices`, `reportingAnimals24h`.
- `silentAnimals { count, animals (first 10) }`.
- `readings24h`, `readings7d`, `bySource7d`.
- `alerts24h { total, bySeverity, byType }`.
- `lowBatteryDevices` (assigned, active, ≤ 20 %).
- `recentAlerts` (10, last 7 days).

### `POST /` (manual entry)

Body:
- `deviceId` or `deviceCode` or `serialNumber`.
- `recordedAt`.
- `metrics`.
- A `farmId` is **accepted and ignored**: the farm comes from the device, so another farm's id changes nothing.

Any other key is a 400.

Answers:
- 201 with the stored reading (as `GET /:id`).
- 409 "This device already has a reading at this moment!".
- 404 when the device is unknown.
- 400 for any other refusal, with the pipeline reason.

Audited as "Sensor Reading Entered" (`entityType: Device`, action Create).

### CSV import

Columns, in any order:
- `recordedAt` (required).
- `deviceCode` or `serialNumber` (at least one).
- Then any metric keys (at least one).

Limits and parsing:
- Unknown or repeated columns are a 400.
- At most 2 MB and 5000 rows. A NUL byte is refused, a UTF-8 BOM is accepted.
- `row` in the result is the line number in the file (the header is line 1).

The answer is the pipeline result `{ summary, notified, rows[] }`. Each row has `row`, `status`, `reason`,
`readingId`, `recordedAt`, `deviceCode`, `animal`, `assignmentNo`, `metrics` and `alerts`.

An import is audited **once** ("Sensor Data Imported", action Import, `entityType: Device`, `entityId` = the device
when the file holds one device). It is written only when something was inserted.

## Effect on devices and assignments (plan 6 rules that now bite)

`device.links.ts` reads `SensorDataModel`:

| Hook | Effect |
|---|---|
| `readingsOfAssignment()` | Cancelling a period with readings is refused (409). A removal or reassignment dated before the period's last reading is refused (400). |
| `countReadingsOfDevice()` | A device with readings has a locked identity and cannot be deleted (409). |
| `latestReadingOf()` | `GET /devices/:id` → `latestReading { _id, recordedAt, metrics, alerts, source, animalId, assignmentId }`. |

## Performance (local replica set, 500 000 rows)

The 500k test is `scratchpad/trends-500k.mjs`.

| Data / query | Answer time |
|---|---|
| 50 animals, 10 000 readings each: day buckets, 366 days | 113–152 ms (explain: `IXSCAN animalId_1_recordedAt_-1`, docs examined = that animal's rows, no COLLSCAN) |
| Same data: hour buckets, 31 days | ≈ 45 ms |
| Same data: list | ≈ 15 ms |
| Same data: dashboard | ≈ 35 ms |
| Same data: latest | ≈ 90 ms |
| One animal with all 500 000 rows: day trends, 366 days, all 10 metrics | ≈ 4.1 s (**over the 2 s target**) |
| Same: 31-day hour trends | ≈ 0.4 s |

The one-animal worst case still uses the index, but it has to read every row. A pre-aggregated daily rollup would be
the fix if that ever becomes real (one reading per minute for a year).
