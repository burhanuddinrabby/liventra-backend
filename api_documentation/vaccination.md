# Liventra Backend — Vaccinations API (Model 13)

Base URL: `http://localhost:5000`

All endpoints require `Authorization: Bearer <accessToken>`. Response envelope and error shape are the
same as every other module (`{ success, message, data, meta? }` / `{ success: false, message, errorSources }`).

A Vaccination answers **"which vaccine was planned / given to which animal, when, from which batch, by whom?"**.
`Vaccine` (`/api/v1/vaccines`) is the global master definition; `Vaccination` is the farm- and animal-level event.

```text
Vaccine (rules) → Vaccination (event) → Inventory_Transaction (Vaccination Usage) → AuditLog
```

All routes are farm-scoped: `/api/v1/farms/:farmId/...` where `:farmId` is the farm `_id` or `FARM-00001`.
`:id` accepts the vaccination `_id` or its `vaccinationNo` (`VACLOG-2026-000001`).
`animalId` accepts an animal `_id` or `animalCode` (`AN-000001`); `vaccineId` accepts a vaccine `_id` or `vaccineCode` (`VAC-00001`).

## Model (final DB schema)

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `vaccinationNo` | String | `VACLOG-YYYY-NNNNNN`, server-generated (atomic per-year counter), immutable |
| `farmId` / `animalId` | ObjectId | immutable — a dose recorded for the wrong animal is reversed and recorded again |
| `vaccineId` | ObjectId → Vaccine | must be an **active** catalog vaccine for new doses; history keeps retired ones |
| `vaccinationDate` | Date (calendar day, `T00:00:00Z`) | `Scheduled` → planned date; `Completed` → actual administration date |
| `nextDueDate` | Date \| null | **server-derived** on completion (see below); `null` = no further dose |
| `administeredBy` | ObjectId → FarmMember \| null | who gave the dose — **required for Completed** |
| `batchNumber` | String \| null | vaccine lot (stored uppercase) — **required for Completed**; powers batch recall |
| `status` | `Scheduled \| Completed \| Missed \| Cancelled` | overdue is **derived**, never stored |
| `remarks` | String | ≤ 1000 chars; holds the reason for Missed / Cancelled |
| `createdBy` | ObjectId → FarmMember | who entered the record (may differ from `administeredBy`) |
| `createdAt` / `updatedAt` | Date | |

Clients may never send `vaccinationNo`, `farmId`, `createdBy` or timestamps (400). Bodies are strict.

### nextDueDate rule (stage-aware, uses the Vaccine master)

| Dose | Rule |
|---|---|
| 1st Completed dose and `boosterRequired` + `boosterAfterDays` | `vaccinationDate + boosterAfterDays` (booster due) |
| any other dose with `repeatIntervalDays > 0` | `vaccinationDate + repeatIntervalDays` (repeat due) |
| otherwise | `null` (one-time vaccine) |

The dose stage (`Primary` / `Booster` / `Repeat`) is decided from the animal's earlier Completed doses of the same vaccine.

### Derived "overdue"

- a `Scheduled` record whose `vaccinationDate` is before today, **or**
- the latest `Completed` dose of an animal + vaccine whose `nextDueDate` passed, with no open `Scheduled` follow-up (Active animals only).

## Roles (farm role from the active FarmMember row)

| Action | Owner | Manager | Veterinarian | Worker | Accountant |
|---|---|---|---|---|---|
| List / get / animal history / compliance / meta / administrators | ✅ | ✅ | ✅ | ✅ | ✅ |
| Preview + create (Scheduled or Completed) | ✅ | ✅ | ✅ | ✅ | ❌ |
| Complete a Scheduled dose | ✅ | ✅ | ✅ | ✅ | ❌ |
| Mark Missed / Cancelled, correct (`PUT`), change history | ✅ | ✅ | ✅ | ❌ | ❌ |
| Reverse a Completed dose (`Completed → Cancelled`, stock returned) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Delete an unexecuted draft | ✅ | ❌ | ❌ | ❌ | ❌ |

- Platform `superAdmin` and the farm's owner account are treated as **Owner**; platform `admin` is not.
- Writes need an **Active** farm (otherwise 403) and a FarmMember row.
- An animal or record of another farm is reported as **404** (farm isolation).
- The final DB schema's CRUD table lists Worker as read-only; DO.md's route table lets Workers schedule and
  complete doses, and that is what is implemented (`VaccinationPermissions` in `vaccination.constants.ts`).

## Eligibility & validation (create / complete)

| Check | Result |
|---|---|
| Animal not in this farm | 404 |
| Animal `lifeStatus` ≠ `Active` (Sold / Dead / Transferred / Archived) | 409 |
| Vaccine missing / retired (`isActive: false`) | 404 / 409 |
| Same animal + vaccine + calendar day already `Scheduled` or `Completed` | 409 (final schema rule; boosters on other days are fine) |
| `Completed` with a future date, or any date before the animal's birth | 400 |
| `Completed` without `administeredBy` (active member of this farm) or `batchNumber` | 400 |
| `Scheduled` in the past | 400 — record it as Completed instead |
| Animal younger than `Vaccine.minimumAge`, no birth date, `Sick` / `Under Treatment` / `Quarantine`, an open schedule already exists | **warning** only (`warnings[]`) |

## Inventory integration

Completing a dose (create as `Completed`, or `PATCH /:id/complete`) runs in **one transaction**
(compensation steps on a standalone mongod):

1. find the farm's `Inventory` rows with `itemType: "Vaccine"`, `referenceId: vaccineId`; the usable row
   (not Expired / Inactive / past `expiryDate`) that expires first and holds enough stock is used (FEFO);
2. deduct the dose from `currentStock` (atomic, never below 0) and write an `InventoryTransaction`
   `{ transactionType: "Vaccination Usage", referenceType: "Vaccination", referenceId: vaccination._id }`;
3. update the vaccination + write the AuditLog.

Dose quantity = `quantityUsed` from the body, else the Vaccine `dosage` when the stock unit equals the
vaccine's `dosageUnit` (e.g. 2 ml from an ml stock), else 1 unit (vial / dose / piece).

| Stock situation | Result |
|---|---|
| Vaccine not stocked in this farm at all | allowed, `warnings[]`: nothing deducted |
| All rows expired / inactive | **422** `Vaccination cannot be completed: …` |
| Not enough stock | **422** |
| Stock changed between check and write | **409** — reload and retry |

Missed / Cancelled transitions never touch stock. Reversals and corrections return held stock with
`"Return"` ledger rows.

---

## Endpoints

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/api/v1/farms/:farmId/vaccinations/preview` | Owner/Manager/Vet/Worker | dry-run of create: warnings, blockers, nextDueDate, stock |
| POST | `/api/v1/farms/:farmId/vaccinations` | Owner/Manager/Vet/Worker | schedule or record a dose |
| GET | `/api/v1/farms/:farmId/vaccinations` | Farm member | list + filters |
| GET | `/api/v1/farms/:farmId/vaccinations/meta` | Farm member | statuses, permissions, limits |
| GET | `/api/v1/farms/:farmId/vaccinations/compliance` | Farm member | mandatory coverage + reminders |
| GET | `/api/v1/farms/:farmId/vaccinations/administrators` | Farm member | members selectable as `administeredBy` |
| GET | `/api/v1/farms/:farmId/vaccinations/:id` | Farm member | one record + stock ledger |
| GET | `/api/v1/farms/:farmId/vaccinations/:id/audit-logs` | Owner/Manager/Vet | change history |
| PATCH | `/api/v1/farms/:farmId/vaccinations/:id/complete` | Owner/Manager/Vet/Worker | Scheduled → Completed |
| PATCH | `/api/v1/farms/:farmId/vaccinations/:id/status` | Owner/Manager/Vet | → Missed / Cancelled (+ reschedule); reversal |
| PUT | `/api/v1/farms/:farmId/vaccinations/:id` | Owner/Manager/Vet | controlled correction |
| DELETE | `/api/v1/farms/:farmId/vaccinations/:id` | Owner | delete an unexecuted draft |
| GET | `/api/v1/farms/:farmId/animals/:animalId/vaccinations` | Farm member | animal immunization history |

### POST `/vaccinations` (and `/vaccinations/preview`)

```json
// schedule
{ "animalId": "AN-000125", "vaccineId": "VAC-00001", "vaccinationDate": "2026-12-01", "remarks": "Pre-monsoon round" }

// record an already-given dose
{
  "animalId": "AN-000125",
  "vaccineId": "VAC-00001",
  "status": "Completed",
  "vaccinationDate": "2026-11-20",
  "administeredBy": "<FarmMember _id>",
  "batchNumber": "FMD-BATCH-2026-08",
  "quantityUsed": 2,
  "remarks": "No reaction"
}
```

`status` defaults to `Scheduled`. A Scheduled body may not contain `administeredBy`, `batchNumber` or `quantityUsed`.

**201** `data`:

```json
{
  "vaccination": { "...record, populated animalId / vaccineId / administeredBy / createdBy", "dueDate": "…", "dueInDays": 10, "isOverdue": false, "batchSiblings": 3, "inventoryTransactions": [] },
  "doseStage": "Primary",
  "nextDoseType": "Booster",
  "stockMovement": { "transactionNo": "TRX-2026-000014", "transactionType": "Vaccination Usage", "quantity": 2, "unit": "ml", "stockBefore": 50, "stockAfter": 48 },
  "warnings": []
}
```

`/preview` returns **200** with the draft (`animal`, `vaccine`, `status`, `vaccinationDate`, `nextDueDate`,
`doseStage`, `nextDoseType`, `stock`), `warnings[]`, `blockers[]`, `canSave`, `isPreview: true`. Hard
validation errors (404 / 409 / 400) are thrown exactly like create.

### GET `/vaccinations`

| Query | Meaning |
|---|---|
| `page`, `limit` (≤ 100) | paging (`meta`: `page, limit, totalEntries, totalPage`) |
| `animalId`, `vaccineId` | `_id` or code |
| `status` | comma list, e.g. `Scheduled,Missed` |
| `overdue=true` | derived overdue (see above) |
| `upcomingDays=N` | planned within N days, or a booster/repeat falling due within N days (1–365) |
| `batchNumber` | exact lot — **batch recall**: every dose given from that lot |
| `administeredBy` | FarmMember `_id` |
| `from`, `to` | `YYYY-MM-DD` on `vaccinationDate` (inclusive) |
| `searchTerm` | vaccinationNo / batchNumber / remarks |
| `sort` | `vaccinationDate`, `nextDueDate`, `createdAt`, `updatedAt`, `status`, `vaccinationNo` (prefix `-` = desc; default `-vaccinationDate`) |

Every row carries the derived `dueDate`, `dueInDays`, `isOverdue`.

### GET `/animals/:animalId/vaccinations`

```json
{
  "animal": { "animalCode": "AN-000125", "lifeStatus": "Active", "ageMonths": 14, "...": "..." },
  "counts": { "Scheduled": 1, "Completed": 3, "Missed": 0, "Cancelled": 0 },
  "history": [ "chronological records (oldest first), with dueDate / dueInDays / isOverdue" ],
  "vaccines": [ { "vaccine": {}, "completedDoses": 2, "lastCompletedDate": "…", "lastBatchNumber": "…", "nextDueDate": "…", "nextScheduledDate": null, "state": "Due Soon" } ],
  "upcoming": [ { "_id": "…|null", "vaccinationNo": "…|null", "vaccine": {}, "dueDate": "…", "dueInDays": 5, "type": "Scheduled | Booster / Repeat due" } ],
  "overdue": [ "same shape" ],
  "missingMandatory": [ { "vaccineCode": "VAC-00002", "vaccineName": "…", "planned": false, "eligibleByAge": true } ]
}
```

`vaccines[].state`: `Overdue`, `Due Soon` (≤ 14 days), `Scheduled`, `Up to date`, `Course complete`, `Not given`.

### GET `/vaccinations/compliance?upcomingDays=14`

```json
{
  "asOf": "2026-11-22T00:00:00.000Z",
  "upcomingWindowDays": 14,
  "totals": {
    "activeAnimals": 40,
    "byStatus": { "Scheduled": 6, "Completed": 82, "Missed": 2, "Cancelled": 1 },
    "overdueScheduled": 1, "overdueBoosters": 3,
    "upcomingScheduled": 5, "upcomingBoosters": 4,
    "completionRatePercent": 96.5,
    "mandatoryVaccines": 2, "mandatoryCoveragePercent": 87.5
  },
  "mandatory": [
    { "vaccine": {}, "eligibleAnimals": 38, "covered": 33, "lapsed": 2, "neverVaccinated": 3, "scheduled": 2, "coveragePercent": 86.8,
      "uncoveredAnimals": [ { "animalCode": "AN-000007", "reason": "Never vaccinated | Scheduled, not yet given | Booster / repeat overdue" } ] }
  ],
  "upcoming": [ "Scheduled records due within the window" ],
  "boosterReminders": [ "latest Completed records whose nextDueDate is overdue or within the window (dueInDays)" ]
}
```

Eligible = Active animals at least `minimumAge` months old (no birth date → eligible). Covered = the animal's
latest Completed dose of that vaccine is still current (`nextDueDate` null or not passed).
`completionRatePercent` = Completed ÷ (Completed + Missed + Cancelled).

### GET `/vaccinations/:id`

Populated record + `dueDate`, `dueInDays`, `isOverdue`, `batchSiblings` (other Completed doses of the same
lot in this farm) and `inventoryTransactions[]` (the stock ledger of this record).

### PATCH `/vaccinations/:id/complete`

```json
{ "vaccinationDate": "2026-11-22", "administeredBy": "<FarmMember _id>", "batchNumber": "FMD-BATCH-2026-08", "quantityUsed": 2, "remarks": "Given after milking" }
```

`administeredBy` and `batchNumber` are required; `vaccinationDate` defaults to today (never future).
Only a `Scheduled` record can be completed (Missed / Cancelled → 409; schedule a new dose instead).
Response like create (`vaccination`, `doseStage`, `nextDoseType`, `stockMovement`, `warnings`).

### PATCH `/vaccinations/:id/status`

```json
{ "status": "Missed", "remarks": "Animal was out on pasture", "reschedule": { "vaccinationDate": "2026-11-29", "remarks": "Second attempt" } }
```

- `Scheduled → Missed` (only once the planned date has passed) or `Scheduled → Cancelled`; `remarks` (reason, ≥ 3 chars) is required and stored as `"<Status>: <reason>"`.
- `reschedule` (optional) creates a **new** Scheduled record (`remarks` notes `Rescheduled from VACLOG-…`); date must be today or later.
- `Completed → Cancelled` = **reversal** (Owner / Manager): the dose is returned to stock with a `Return` ledger row, `nextDueDate` is cleared, no reschedule.

`data`: `{ vaccination, rescheduled | null, stockMovements[], warnings[] }`.

### PUT `/vaccinations/:id` — controlled correction

| Current status | Editable fields |
|---|---|
| Scheduled | `vaccineId`, `vaccinationDate` (today or later), `batchNumber`, `remarks` |
| Completed | `vaccineId`, `vaccinationDate` (not future), `nextDueDate` (date or `null`), `administeredBy`, `batchNumber` (cannot be cleared), `remarks`, `quantityUsed` — **`reason` required** |
| Missed / Cancelled | `remarks` |

`animalId` and `status` are refused (400). A changed vaccine/date re-derives `nextDueDate` unless one is sent.
For Completed records, a new vaccine or a different `quantityUsed` returns the held stock and deducts the
corrected dose in one transaction. Optimistic locking: a concurrent edit → 409.
AuditLog stores `oldData` / `newData` / `changedFields` (event `Batch Changed`, `Administrator Changed`,
`Vaccination Date Changed`, `Next Due Date Changed`, `Vaccine Changed` or `Vaccination Updated`).

`data`: `{ mode: "corrected" | "unchanged", vaccination, stockMovements[], warnings[] }`.

### DELETE `/vaccinations/:id`

Owner only. Allowed only for `Scheduled` / `Cancelled` records that never moved stock. Completed and Missed
records (and reversed doses) are history → 409. Audited as `Vaccination Deleted`.

### GET `/vaccinations/administrators`

`{ me, myRole, members: [{ _id, role, userId, fullName }] }` — active members only, no phone / NID / salary.

### GET `/vaccinations/:id/audit-logs`

Paged AuditLog rows (`logNo, action, event, oldData, newData, changedFields, status, createdAt, userId`); IP and user agent are never exposed.

### GET `/vaccinations/meta`

`{ statuses, createStatuses, manualStatusTargets, permissions, sortFields, limits }`.

## Not built yet

- **Notifications**: the Notification module does not exist, so reminders are exposed as derived data
  (`compliance.boosterReminders`, `upcoming`, `overdue`) instead of Notification rows.
- **Inventory API**: vaccine stock rows can only be created once the Inventory module has routes; until
  then completions warn "not tracked in inventory" and deduct nothing.
