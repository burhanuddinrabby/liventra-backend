# Liventra Backend — Milk Records API (Model 10)

Base URL: `http://localhost:5000`

All endpoints require `Authorization: Bearer <accessToken>`. Response envelope and error shape are the
same as every other module (`{ success, message, data, meta? }` / `{ success: false, message, errorSources }`).

A MilkRecord answers **"how much milk did this animal produce in this milking session, and what was its quality?"**.
It is the production history of an animal — produced milk is **not** sold milk (sales belong to Income).

All routes are farm-scoped: `/api/v1/farms/:farmId/...` where `:farmId` is the farm `_id` or `FARM-00001`.
`animalId` (body, query or path) accepts the animal `_id` or its farm code `AN-000001`.

## Model (final schema, "Business Logics.md")

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | the record id used in every `:id` route |
| `farmId` / `animalId` | ObjectId | immutable — milk logged for the wrong animal is voided and logged again |
| `recordDate` | Date | calendar day of production, stored as `YYYY-MM-DDT00:00:00Z`; `createdAt` = when it was entered (backdating ≤ 365 days, never future) |
| `milkingSession` | `Morning \| Afternoon \| Evening \| Night` | **one active record per animal + day + session** (unique index; 409 on duplicates) |
| `quantity` | Number | exactly what the user entered, `≥ 0` (0 = "produced nothing", with a warning) |
| `unit` | `liter \| ml` | default `liter` |
| `quantityInLiters` | Number | **server-calculated** normalization used by every total/average |
| `fatPercentage` / `proteinPercentage` / `snfPercentage` | Number \| null | `null` = **not measured** (never defaulted to 0). Caps: fat 0–15, protein 0–10, SNF 0–15 |
| `quality` | `Excellent \| Good \| Average \| Poor \| Rejected` \| null | `null` = not graded. `qualityStatus` is accepted as an alias in bodies and queries |
| `milkingMethod` | `Manual \| Milking Machine \| Automatic` \| null | |
| `recordedBy` | ObjectId (FarmMember) | who milked/measured; defaults to the caller. Whoever **entered** it is in AuditLog |
| `remarks` | String | optional, ≤ 1000 chars |
| `withdrawalFlag` | Boolean | **server-set**: the animal was inside a medicine milk-withdrawal window on `recordDate` |
| `withdrawalDetails[]` | Array | `{ treatmentId, treatmentNo, medicineName, withdrawalPeriodDays, withdrawalUntil }` snapshot |
| `isVoided`, `voidedAt`, `voidedBy`, `voidReason` | | set by `DELETE` (default mode) |
| `isSaleEligible` | Boolean | **derived on read** (not stored): not voided, quality ≠ Rejected, no withdrawal |
| `createdAt` / `updatedAt` | Date | |

Clients may **never** send `farmId`, `quantityInLiters`, `withdrawalFlag`, `withdrawalDetails` or the void
fields — bodies are strict and such keys answer **400**.

## Roles (farm role from the active FarmMember row)

| Action | Owner | Manager | Worker | Veterinarian | Accountant |
|---|---|---|---|---|---|
| List / get / animal history / summary / meta / check / recorders | ✅ | ✅ | ✅ | ✅ | ✅ |
| Log milk (`POST /`, `POST /bulk`) | ✅ | ✅ | ✅ | ❌ | ❌ |
| Correct (`PUT /:id`) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Re-grade (`PATCH /:id/quality`) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Delete / void (`DELETE /:id`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Change history, voided records (`voided=include\|only`) | ✅ | ✅ | ❌ | ❌ | ❌ |

- Platform `superAdmin` and the farm's owner account are treated as **Owner**; platform `admin` is not.
- Writes need an **Active** farm (`Setup` / `Inactive` / `Suspended` → 403) and a FarmMember row
  (a super admin without one can read and dry-run, but not write).
- An animal or record of another farm is reported as **404** (farm isolation).
- The final schema lists Worker read access as "Assigned"; there is no animal-assignment model yet, so Workers
  currently read farm-wide like other members.

## Business rules on create / correct

1. **Eligibility** (new logs are blocked with 422, corrections only warn):
   Male animals, `Calf`, and animals whose `lifeStatus` is `Sold / Dead / Transferred / Archived` (or inactive).
   Females that are not `Lactating` (Dry, Pregnant, Heifer, Open) are **allowed with a warning**. A non-Healthy
   `healthStatus` adds a warning.
2. **Medicine withdrawal**: the animal's Treatments are cross-checked with `Medicine.withdrawalPeriodDays`.
   Window = last dose day (`completedDate`, else `diagnosisDate + duration`; an `Ongoing` treatment is still dosing)
   + withdrawal days. Inside it the record is saved with `withdrawalFlag: true`, the response carries a
   `MILK WITHDRAWAL` warning, and it is excluded from `saleableLiters`. A recommendation to set
   `quality: "Rejected"` is added. *Treatment/Medicine modules are not built yet — the check reads their
   collections when they exist and otherwise finds nothing.*
3. **Units**: `quantity` + `unit` are stored as entered; `quantityInLiters` is derived (ml ÷ 1000). Max 80 L per session.
4. **Duplicate session**: a second active record for the same animal/day/session → **409** "edit that record instead".
5. **Composition**: missing = `null`; SNF lower than protein raises a "re-check lab values" warning.
6. **Sudden drop**: if the yield is ≥ 30% below the animal's last-14-days average for the same session (≥ 3 records),
   a warning is returned. Nothing is blocked.

Warnings never block; they are returned as `data.warnings: string[]`.

## Endpoints

### POST `/api/v1/farms/:farmId/milk-records` — log one session (Owner / Manager / Worker)

```json
{
  "animalId": "AN-000002",
  "recordDate": "2026-11-22",
  "milkingSession": "Morning",
  "quantity": 8.5,
  "unit": "liter",
  "fatPercentage": 3.9,
  "proteinPercentage": 3.3,
  "snfPercentage": 8.6,
  "quality": "Good",
  "milkingMethod": "Milking Machine",
  "recordedBy": "<FarmMember _id, optional>",
  "remarks": "optional"
}
```

**201** → `data: { milkRecord, withdrawal: { active, details[] }, warnings[] }`. When `withdrawal.active` the message
starts with "WARNING". Errors: 400 bad field / future date, 404 animal, 409 duplicate session, 422 ineligible animal.

### POST `/api/v1/farms/:farmId/milk-records/bulk` — one session for many animals

```json
{
  "recordDate": "2026-11-22",
  "milkingSession": "Evening",
  "milkingMethod": "Manual",
  "unit": "liter",
  "recordedBy": "<optional>",
  "dryRun": false,
  "entries": [
    { "animalId": "AN-000002", "quantity": 7.2, "quality": "Good" },
    { "animalId": "AN-000005", "quantity": 4800, "unit": "ml", "fatPercentage": 4.1 }
  ]
}
```

Up to 200 entries. Each entry is validated on its own (same rules as `POST /`); valid ones are saved, invalid ones
are reported. `dryRun: true` validates without saving.
**201** (or 200 for a dry run / nothing saved) → `data: { dryRun, saved, failedCount, totalLiters, created[], failed[{ index, animalId, error }] }`.

### GET `/api/v1/farms/:farmId/milk-records` — farm list (Farm Member)

Query: `page`, `limit` (≤ 100), `animalId`, `milkingSession` (comma list), `milkingMethod` (comma list),
`quality` / `qualityStatus` (comma list; `none` = not graded), `recordedBy`, `withdrawal=true|false`,
`from`, `to` (YYYY-MM-DD, inclusive), `searchTerm` (remarks), `sort` (`recordDate`, `createdAt`,
`quantityInLiters`, `milkingSession`, `fatPercentage`; prefix `-` for desc; default `-recordDate`),
`voided=exclude|include|only` (Owner/Manager only).

**200** → `meta` + `data: { records[], summary }` where `summary` covers the **whole filtered set**:
`{ records, animalsMilked, productionDays, totalLiters, saleableLiters, rejectedLiters, withdrawalLiters,
avgDailyLiters, avgSessionYield, composition: { avgFatPercentage, avgProteinPercentage, avgSnfPercentage } }`.
Records are populated with `animalId { animalCode, name, reproductiveStatus }` and `recordedBy { role, userId { userId, fullName } }`.

### GET `/api/v1/farms/:farmId/milk-records/summary` — production dashboard (Farm Member)

Query: `period=daily|weekly|monthly` (default `daily`; weekly buckets are ISO weeks `2026-W47`),
`from`, `to` (default last 30 days, 180 for monthly, max 366 days), `animalId` (animal dashboard).

**200** → `data`:
- `window { from, to, period, calendarDays }`, `basis` (how each average is defined)
- `totals` (same shape as the list summary + `avgPerCalendarDay`), `today`
- `trend[] { period, records, liters, productionDays, avgDailyLiters, rejectedLiters, avgFat/Protein/SnfPercentage }`
- `bySession`, `byMethod`, `qualityBreakdown` → `{ [key]: { records, liters, avgYield, percent } }`
  (extra keys `Unknown`, `Not recorded`, `Not graded`)
- `topProducers[] { animalId, animalCode, name, liters, records, avgDailyLiters }` (farm view only)
- `feedPlanningInput { milkYield, basis, days }` (animal view only) — the L/day input for FeedRecommendation

### GET `/api/v1/farms/:farmId/animals/:animalId/milk-records` — animal history (Farm Member)

Query: `from`, `to` (default last 30 days), `milkingSession`, `quality`, `page`, `limit` (default 20), `sort`.

**200** → `meta` + `data: { animal, window, summary (+ lastRecord), withdrawal { active, details[] } (as of today),
dailyTotals[] { date, records, sessions[], liters, rejectedLiters, avgFat/Protein/SnfPercentage },
sessionAverages[] { milkingSession, records, liters, avgYield, avgFatPercentage }, records[] }`.

### GET `/api/v1/farms/:farmId/milk-records/check` — form pre-check (Farm Member)

Query: `animalId` (required), `recordDate` (default today), `milkingSession` (optional).
**200** → `data: { animal, recordDate, withdrawal, existingRecord, warnings[], blockers[], canLog }`. Writes nothing.

### GET `/api/v1/farms/:farmId/milk-records/meta`

Enums (`milkingSessions`, `units`, `qualities`, `milkingMethods`, `summaryPeriods`, `deleteModes`), `permissions`,
`compositionLimits`, `limits`, `productionDropPercent`, `totalsUnit`.

### GET `/api/v1/farms/:farmId/milk-records/recorders`

Active members selectable as `recordedBy`: `data: { me, myRole, members[{ _id, role, userId, fullName }] }`
(no phone / NID / salary).

### GET `/api/v1/farms/:farmId/milk-records/:id` — one record (Farm Member)

Populated `animalId { animalCode, name, gender, lifeStatus, healthStatus, reproductiveStatus, profilePhoto, breedId }`,
`recordedBy`, `voidedBy`, plus `isSaleEligible`. Voided records are 404 for roles other than Owner/Manager.

### PUT `/api/v1/farms/:farmId/milk-records/:id` — controlled correction (Owner / Manager)

Any of `recordDate`, `milkingSession`, `quantity`, `unit`, `fatPercentage`, `proteinPercentage`, `snfPercentage`
(`null` clears), `quality` (`null` clears), `milkingMethod`, `recordedBy`, `remarks`, plus optional `reason`.
`animalId` may only be repeated unchanged. Liters, withdrawal flag and duplicate-session rules are recalculated.
Optimistic concurrency: if someone changed the record meanwhile → 409.
**200** → `data: { mode: "updated" | "unchanged", changedFields[], milkRecord, warnings[] }`.
AuditLog: `action Update`, event `MilkRecord Corrected`, `oldData`, `newData` (+ `reason`), `changedFields`.

### PATCH `/api/v1/farms/:farmId/milk-records/:id/quality` — re-grade (Owner / Manager)

`{ "quality": "Rejected", "reason": "Mastitis — clots seen" }` (`null` = not graded). The preferred way to handle
spoiled / contaminated milk: the production stays recorded but leaves `saleableLiters`.
Audit event `MilkRecord Rejected` or `MilkRecord Quality Changed`.

### DELETE `/api/v1/farms/:farmId/milk-records/:id` — Owner

Body (optional): `{ "mode": "void" | "hard", "reason": "..." }`.
- `void` (default): `isVoided: true`, removed from all lists and totals, kept as history. Audit `MilkRecord Voided`.
- `hard`: permanent removal for **duplicate / accidental** entries only. `reason` is required; refused (409) if an
  Income references the record. Audit `MilkRecord Deleted (duplicate / accidental)` keeps the full `oldData`.

Response includes a `hint` recommending `quality: "Rejected"` instead when the milk was really produced.

### GET `/api/v1/farms/:farmId/milk-records/:id/audit-logs` — history (Owner / Manager)

Paginated AuditLog rows `{ logNo, action, event, oldData, newData, changedFields, status, createdAt, userId }`.
Works for hard-deleted records too (their audit trail remains).
