# Liventra Backend — Weight Records API (Model 11)

Base URL: `http://localhost:5000`

All endpoints require `Authorization: Bearer <accessToken>`. Response envelope and error shape are the
same as every other module (`{ success, message, data, meta? }` / `{ success: false, message, errorSources }`).

A WeightRecord answers **"what did this animal weigh on this date, how was it measured, and who measured it?"**.
It is the historical growth curve of an animal; `Animal.currentWeight` is only a fast snapshot of the latest
valid measurement and is kept in sync by the server.

All routes are farm-scoped: `/api/v1/farms/:farmId/...` where `:farmId` is the farm `_id` or `FARM-00001`.
`animalId` (body, query or path) accepts the animal `_id` or its farm code `AN-000001`.

## Model (final schema, "Business Logics.md")

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | the record id used in every `:id` route |
| `farmId` / `animalId` | ObjectId | immutable — a measurement attached to the wrong animal is voided and logged again |
| `recordedDate` | Date | the day the animal was **actually weighed**, stored as `YYYY-MM-DDT00:00:00Z`; `createdAt` = when it was entered. Backdating ≤ 3650 days, never future, never before birth |
| `weight` | Number | exactly what the user entered, `> 0` |
| `weightUnit` | `kg \| lb` | default `kg` |
| `weightInKg` | Number | **server-calculated** normalization (1 lb = 0.453592 kg) used by every ADG / growth / recommendation calculation |
| `measurementMethod` | `Digital Scale \| Manual Scale \| Estimated \| Smart Device` | required; preserved as provenance |
| `averageDailyGain` | Number \| null | **server-derived** kg/day against the immediately preceding measurement; `null` for the first record and for same-day pairs |
| `measuredBy` | ObjectId (FarmMember) | who physically weighed the animal; defaults to the caller. Whoever **entered** it is in AuditLog |
| `remarks` | String | optional, ≤ 1000 chars |
| `isVoided`, `voidedAt`, `voidedBy`, `voidReason` | | set by `DELETE` (default mode) |
| `isEstimated` / `measurementReliability` | derived on read | `true` / `"Estimated"` when `measurementMethod = Estimated` |
| `createdAt` / `updatedAt` | Date | |

Clients may **never** send `farmId`, `weightInKg`, `averageDailyGain` or the void fields — bodies are strict and
such keys answer **400**.

## Roles (farm role from the active FarmMember row)

| Action | Owner | Manager | Worker | Veterinarian | Accountant |
|---|---|---|---|---|---|
| List / get / animal trajectory / growth summary / meta / check / recorders | ✅ | ✅ | ✅ | ✅ | ✅ |
| Log weight (`POST /`) | ✅ | ✅ | ✅ | ❌ | ❌ |
| Correct (`PUT /:id`) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Delete / void (`DELETE /:id`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Change history, voided records (`voided=include\|only`) | ✅ | ✅ | ❌ | ❌ | ❌ |

- Platform `superAdmin` and the farm's owner account are treated as **Owner**; platform `admin` is not.
- Writes need an **Active** farm (`Setup` / `Inactive` / `Suspended` → 403) and a FarmMember row
  (a super admin without one can read, but not write).
- An animal or record of another farm is reported as **404** (farm isolation).
- The final schema lists Worker read access as "Assigned"; there is no animal-assignment model yet, so Workers
  currently read farm-wide like other members.

## Business rules on create / correct

1. **Eligibility** (new logs are blocked with 422, corrections only warn): animals whose `lifeStatus` is
   `Sold / Dead / Transferred / Archived` (or inactive) cannot get new measurements. A non-Healthy
   `healthStatus` adds a warning. Sex, age and reproductive status never block a weight.
2. **Units**: `weight` + `weightUnit` are stored as entered; `weightInKg` is derived. Cap: 2000 kg
   (4409.24 lb) per measurement — a typo guard, not a species limit.
3. **ADG chain**: ADG = `(currentKg − previousKg) ÷ whole days between the two measurements`.
   The first record, and any pair on the same day, store `null` (never computed against an imaginary value).
   Zero is valid; **negative ADG is stored** (weight loss is real data) and raises a warning.
   After every create / correction / delete the **whole timeline of that animal is re-derived**, so a
   backdated insert or a corrected date also fixes the neighbours.
4. **Animal.currentWeight**: re-synced to the **latest valid** measurement after every write. A backdated
   record is inserted into the timeline but never overwrites a newer current weight. If every measurement is
   removed, the existing snapshot is left untouched.
5. **Warnings** (never block; returned as `data.warnings: string[]`):
   `Estimated` method, large single-interval change (≥ 25%), weight loss, a second measurement on the same
   day (allowed), same-day interval without ADG, and non-Healthy animal.
6. **Audit**: create / correction / void / hard delete write a `WeightRecord` AuditLog row with
   `oldData`, `newData`, `changedFields` and the acting user.

## Endpoints

### POST `/api/v1/farms/:farmId/weight-records` — log one measurement (Owner / Manager / Worker)

```json
{
  "animalId": "AN-000002",
  "recordedDate": "2026-11-22",
  "weight": 420,
  "weightUnit": "kg",
  "measurementMethod": "Digital Scale",
  "measuredBy": "<FarmMember _id, optional>",
  "remarks": "optional"
}
```

**201** → `data: { weightRecord, previousRecord, adg: { averageDailyGain, intervalDays, previousWeightKg }, currentWeight: { animalId, currentWeight, recordedDate }, warnings[] }`.
Errors: 400 bad field / future date / bad unit, 404 animal, 422 ineligible animal.

### GET `/api/v1/farms/:farmId/weight-records` — farm list (Farm Member)

Query: `page`, `limit` (≤ 100), `animalId`, `measurementMethod` (comma list), `measuredBy`, `from`, `to`
(YYYY-MM-DD, inclusive), `stale=true` (+ `staleDays`, default 30) to return only the latest measurement of
animals whose weight is older than the threshold, `searchTerm` (remarks), `sort` (`recordedDate`, `createdAt`,
`weight`, `weightInKg`, `averageDailyGain`, `measurementMethod`; prefix `-` for desc; default `-recordedDate`),
`voided=exclude|include|only` (Owner/Manager only).

**200** → `meta` + `data: { records[], summary }` where `summary` covers the **whole filtered set**:
`{ records, animalsMeasured, avgWeightKg, minWeightKg, maxWeightKg, avgDailyGain, estimatedRecords,
byMeasurementMethod }`. Records are populated with `animalId { animalCode, name, gender, reproductiveStatus,
currentWeight }` and `measuredBy { role, userId { userId, fullName } }`.

### GET `/api/v1/farms/:farmId/animals/:animalId/weight-records` — growth trajectory (Farm Member)

Query: `from`, `to` (optional; default the whole history), `staleDays`.

**200** → `data: { animal, window, summary, records[] }`.
- `records` is **ascending** (chart-ready): `{ _id, recordedDate, weight, weightUnit, weightInKg,
  measurementMethod, isEstimated, averageDailyGain, remarks, createdAt }`.
- `summary`: `{ records, firstWeightKg, lastWeightKg, totalGainKg, spanDays, observedAdg, averageIntervalAdg,
  latestMeasurement { recordedDate, weightInKg, ageDays }, isStale, staleDays, animalCurrentWeightKg }`.

### GET `/api/v1/farms/:farmId/weight-records/growth-summary` — growth analytics (Farm Member)

Query: `from`, `to` (default last 90 days, max 730), `animalId`, `breedId`, `staleDays` (default 30),
`targetADG` (explicit target override, kg/day).

**200** → `data`:
- `window { from, to, staleDays, calendarDays }`, `target { adg, source }`, `basis`
- `summary { animalsInScope, animalsMeasured, animalsWithTrend, avgObservedAdg, avgIntervalAdg, avgWeightKg,
  totalGainKg, onTarget, slightlyBelowTarget, belowTarget, noTarget, insufficientData, animalsOverdue }`
- `animals[] { animalId, animalCode, name, breedId, breedName, currentWeightKg, measurements, firstWeightKg,
  lastWeightKg, totalGainKg, spanDays, observedAdg, averageIntervalAdg, targetAdg, performanceGap,
  performanceStatus, latestMeasurement, isOverdue }` — worst ADG first
- `byBreed[] { breedId, breedName, animals, animalsMeasured, avgObservedAdg, onTarget, belowTarget }`
- `overdue { count, animals[] { animalId, animalCode, name, latestWeightKg, latestRecordedDate,
  daysSinceLastMeasurement } }` (first 20)

`targetAdg` comes from the animal's latest **Confirmed / Expert Approved** FeedRecommendation
(`inputSnapshot.targetADG`); the farm target is the average of those, or the explicit `targetADG` query value.
`performanceStatus` = `On Target` / `Slightly Below Target` (within 10% of target) / `Below Target` /
`No Target` / `Insufficient Data`.

### GET `/api/v1/farms/:farmId/weight-records/:id` — one record (Farm Member)

**200** → `data`: the record with populated animal profile, `measuredBy` / `voidedBy` attribution, plus
`previousRecord` and `nextRecord` (raw neighbouring measurements). Voided rows are 404 for non-Owner/Manager.

### GET `/api/v1/farms/:farmId/weight-records/:id/audit-logs` — change history (Owner / Manager)

**200** → `meta` + `data[]` AuditLog rows (`logNo`, `action`, `event`, `oldData`, `newData`, `changedFields`,
`status`, `createdAt`, `userId { userId, fullName }`). IP / user agent are never exposed.

### PUT `/api/v1/farms/:farmId/weight-records/:id` — controlled correction (Owner / Manager)

Send only the fields to change plus an optional `reason` (stored in the audit row):

```json
{ "weight": 425, "reason": "245 kg was entered instead of 425 kg" }
```

`animalId` is immutable. The server recalculates `weightInKg`, the **whole ADG chain**, re-syncs
`Animal.currentWeight` and writes an AuditLog row with `oldData`, `newData`, `changedFields`.
**200** → `data: { mode: "updated" | "unchanged", changedFields[], weightRecord, adgChainUpdates, currentWeight, warnings[] }`.
Errors: 404, 409 when someone else changed it or it was voided.

### DELETE `/api/v1/farms/:farmId/weight-records/:id` — void / delete (Owner)

Body (optional): `{ "mode": "void" | "hard", "reason": "..." }`.

- `void` (default): the row stays as history (`isVoided: true`) and leaves every growth calculation;
  the next record's ADG is recalculated and `currentWeight` is re-synced. A reason is recommended.
- `hard`: permanent removal, **only for duplicate / accidental entries**; a `reason` is required and the full
  old data is kept in the AuditLog.

**200** → `data: { _id, mode, isVoided? / deleted?, adgChainUpdates, currentWeight, hint }`.

### GET `/api/v1/farms/:farmId/weight-records/check` — dry-run entry check (Farm Member)

Query: `animalId` (required), `recordedDate`, `weight`, `weightUnit`, `measurementMethod`.

**200** → `data: { animal, recordedDate, previousRecord, intervalDays, predicted { weightInKg,
averageDailyGain, changePercent }, currentWeight { storedKg, latestRecord, willUpdate }, duplicateSameDay,
warnings[], blockers[], canLog }`. Nothing is written.

### GET `/api/v1/farms/:farmId/weight-records/meta` — form metadata (Farm Member)

**200** → `data: { weightUnits, measurementMethods, deleteModes, permissions, unitFactors,
limits { maxWeightKg, maxWeightLb, maxBackdateDays, maxTextLength, maxSummaryDays, maxStaleDays },
defaults { weightUnit, staleDays }, abnormalChangePercent, totalsUnit }`.

### GET `/api/v1/farms/:farmId/weight-records/recorders` — selectable measurers (Farm Member)

**200** → `data: { me, myRole, members[] { _id, role, userId, fullName } }`. No phone / NID / salary.
