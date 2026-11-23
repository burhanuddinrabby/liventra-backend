# Liventra Backend — Breeding API (Model 17)

Base URL: `http://localhost:5000`

All endpoints require `Authorization: Bearer <accessToken>`. Response envelope and error shape are the
same as every other module (`{ success, message, data, meta? }` / `{ success: false, message, errorSources }`).

A Breeding record answers **"when was heat detected, when was the female served, by which method, with which bull /
semen batch, who did it, when is the pregnancy check due, and what was the result?"**. One record = one heat cycle /
service event. The resulting pregnancy lifecycle lives in a separate **Pregnancy** record (Model 18), created
automatically when a breeding is confirmed.

```text
Female Animal → Heat → Breeding (Pending) → Pregnancy check → Confirmed → Pregnancy (Pregnant) → Calving
                                                            └→ Failed → Animal stays / returns Open → next heat
```

All routes are farm-scoped: `/api/v1/farms/:farmId/...` where `:farmId` is the farm `_id` or `FARM-00001`.
`:id` accepts the breeding `_id` or its `breedingNo` (`BRD-2026-000001`).
`animalId` and `bullId` accept an animal `_id` or `animalCode` (`AN-000001`) of the **same farm**.

## Model (final DB schema)

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `breedingNo` | String | `BRD-YYYY-NNNNNN`, server-generated (atomic per-year counter), immutable |
| `farmId` / `animalId` | ObjectId | immutable; the animal must be a Female of this farm. `animalId` is **not** unique (repeat attempts are legitimate) |
| `heatDetectedDate` | Date (calendar day) | required; never in the future, ≤ 730 days back, never before birth |
| `inseminationDate` | Date \| null | service date (insemination / mating / transfer). `null` = heat logged, service not recorded yet. `heat ≤ service ≤ heat + 7 days`, never in the future |
| `breedingMethod` | `Artificial Insemination \| Natural Mating \| Embryo Transfer` | |
| `bullId` | ObjectId → Animal \| null | a **Male** animal of this farm (see method rules) |
| `semenBatchNo` | String \| null | stored upper-case, ≤ 100 chars |
| `technicianName` | String | required (final schema), free text — who performed / handled the service |
| `expectedPregnancyCheckDate` | Date | defaults to service (or heat) date + **35 days**; must be 14–120 days after it |
| `pregnancyResult` | `Pending \| Confirmed \| Failed` | always created `Pending`; changed only through `PATCH /:id/pregnancy-result` |
| `remarks` | String | ≤ 2000 chars; check results / corrections are appended as `[Check 2026-09-20: Confirmed] note` |
| `createdBy` | ObjectId → FarmMember | who logged the record |

Clients may never send `breedingNo`, `farmId`, `createdBy`, `_id` or timestamps, and never `pregnancyResult` on
create / PUT (400). Bodies are strict.

There is **no** status, cost, embryo, or actual-check-date field (final schema): money belongs to Expense / Income,
embryo / donor details go in `remarks`, and the actual check day is kept in `remarks` + the AuditLog.

### Method rules

| Method | `semenBatchNo` | `bullId` |
|---|---|---|
| Artificial Insemination | **required** (traceability) | optional — the sire; any male of this farm (may already be sold / dead) |
| Natural Mating | **not applicable** — sending one → 400 (cleared automatically when a PUT switches the method) | **required** — an **Active** male of this farm |
| Embryo Transfer | optional | optional (embryo / donor details → `remarks`; a warning reminds you) |

A female, a cross-farm animal, or the animal itself as `bullId` is rejected (400 / 404). A Natural-Mating bull
under 12 months only produces a warning.

### Animal eligibility (create)

| Check | Result |
|---|---|
| `gender` ≠ Female | 409 |
| `lifeStatus` ≠ Active (Sold / Dead / Transferred / Archived) | 409 |
| `reproductiveStatus` = `Calf` or `Pregnant` | 409 |
| An active Pregnancy record (`pregnancyStatus: Pregnant`) | 409 |
| Age < 12 months (when `birthDate` is known) | 409 |
| `reproductiveStatus` = `Dry` | allowed + warning (farm policy — dry cows are normally pregnant) |
| `healthStatus` ≠ Healthy | allowed + warning |
| Another breeding still `Pending` | allowed + warning (record its result, e.g. Failed after a return to heat) |
| Same animal, heat or service date within ±3 days of another record | 409 **Possible duplicate** unless `confirmDuplicate: true` |

`Heifer`, `Open` and `Lactating` are the normal eligible states. Creating a breeding does **not** change
`Animal.reproductiveStatus` (the Animal enum has no "Inseminated" state).

### Animal reproductive status sync

| Event | `Animal.reproductiveStatus` |
|---|---|
| Breeding created / corrected / deleted | unchanged |
| Confirmed, and this is the animal's **latest** breeding | `Pregnant` |
| Confirmed, but a newer breeding exists | unchanged (a warning explains why) |
| Failed (normal check) | unchanged — Heifer / Open / Lactating are already non-pregnant states |
| Failed as a correction of Confirmed, latest breeding, no other active pregnancy | `Pregnant` → `Open` |

"Latest" = the most recent `heatDetectedDate` (then creation time). Old records never overwrite a newer cycle.

## Permissions (farm role)

| Action | Owner | Manager | Veterinarian | Worker | Accountant |
|---|---|---|---|---|---|
| Read list / detail / animal history / analytics / checks / bulls / meta | ✅ | ✅ | ✅ | ✅ | ✅ |
| Log a breeding (`POST`) | ✅ | ✅ | ✅ | ✅ | ❌ |
| Record / correct the pregnancy result (`PATCH /pregnancy-result`) | ✅ | ✅ | ✅ | ❌ | ❌ |
| Correct a record (`PUT`) | ✅ | ✅ | ✅ | ❌ | ❌ |
| Change history (`/audit-logs`) | ✅ | ✅ | ✅ | ❌ | ❌ |
| Delete (`DELETE`) | ✅ | ❌ | ❌ | ❌ | ❌ |

Platform `superAdmin` and the farm's owner account act as Owner; platform `admin` has no bypass. Writes need an
**Active** farm (Setup / Inactive / Suspended → 403). The final-schema CRUD table is stricter for Worker (no create)
and forbids deletion; the DO.md route table (newer instruction) lets Workers log events and the Owner remove
unconfirmed erroneous entries, so the API follows it.

---

## Endpoints

| Method | Path | Who |
|---|---|---|
| POST | `/api/v1/farms/:farmId/breedings` | Owner / Manager / Vet / Worker |
| GET | `/api/v1/farms/:farmId/breedings` | Farm member |
| GET | `/api/v1/farms/:farmId/breedings/meta` | Farm member |
| GET | `/api/v1/farms/:farmId/breedings/analytics` | Farm member |
| GET | `/api/v1/farms/:farmId/breedings/pregnancy-checks` | Farm member |
| GET | `/api/v1/farms/:farmId/breedings/eligibility?animalId=` | Farm member |
| GET | `/api/v1/farms/:farmId/breedings/bulls` | Farm member |
| GET | `/api/v1/farms/:farmId/breedings/:id` | Farm member |
| GET | `/api/v1/farms/:farmId/breedings/:id/audit-logs` | Owner / Manager / Vet |
| PATCH | `/api/v1/farms/:farmId/breedings/:id/pregnancy-result` | Owner / Manager / Vet |
| PUT | `/api/v1/farms/:farmId/breedings/:id` | Owner / Manager / Vet |
| DELETE | `/api/v1/farms/:farmId/breedings/:id` | Owner |
| GET | `/api/v1/farms/:farmId/animals/:animalId/breedings` | Farm member |

### 1. Log a breeding event

`POST /api/v1/farms/:farmId/breedings`

```json
{
  "animalId": "AN-000125",
  "heatDetectedDate": "2026-08-17",
  "inseminationDate": "2026-08-18",
  "breedingMethod": "Artificial Insemination",
  "bullId": "AN-000087",
  "semenBatchNo": "SEM-2026-88421",
  "technicianName": "Md. Rahim",
  "expectedPregnancyCheckDate": "2026-09-22",
  "remarks": "Clear standing heat in the morning.",
  "confirmDuplicate": false
}
```

Natural Mating: `bullId` required, omit `semenBatchNo`. `expectedPregnancyCheckDate` may be omitted (→ service + 35 d).

**201** →

```json
{
  "breeding": { "...populated record + derived fields (see GET /:id)" : "" },
  "pregnancyCheckReminder": { "expectedPregnancyCheckDate": "2026-09-22T00:00:00.000Z", "dueInDays": 30 },
  "warnings": ["AN-000125 is currently Sick — check with the veterinarian before breeding."]
}
```

Errors: 400 (dates / method rules / server fields), 403 (role / farm status), 404 (animal / bull not in farm),
409 (eligibility blocker or possible duplicate).

### 2. List breeding records

`GET /api/v1/farms/:farmId/breedings`

| Query | Meaning |
|---|---|
| `page`, `limit` (≤ 100) | pagination |
| `animalId`, `bullId` | `_id` or `AN-…` of this farm |
| `breedingMethod` | comma list of methods |
| `pregnancyResult` | comma list: `Pending,Confirmed,Failed` |
| `overdueCheck=true` | Pending **and** `expectedPregnancyCheckDate` < today (derived; nothing is ever auto-failed) |
| `check=overdue\|today\|upcoming` (+ `checkDays`, default 7, ≤ 90) | Pending checks by due window |
| `semenBatchNo` | exact match, case-insensitive (recall-style lookup) |
| `technicianName` | contains, case-insensitive |
| `heatOnly=true` | records with no service date yet |
| `from`, `to` (YYYY-MM-DD) + `dateField` | range on `heatDetectedDate` (default), `inseminationDate` or `expectedPregnancyCheckDate` — the calendar view |
| `searchTerm` | breedingNo, semen batch, technician, remarks |
| `sort` | e.g. `-heatDetectedDate` (default), `expectedPregnancyCheckDate`, `breedingNo`, … (see `/meta`) |

Each row: the record with `animalId` (`animalCode name reproductiveStatus lifeStatus`), `bullId` (`animalCode name`),
`createdBy` (member + user name) and derived fields:

| Derived | Meaning |
|---|---|
| `isHeatOnly` | no service date recorded yet |
| `daysSinceService` | today − inseminationDate |
| `checkDueInDays` | Pending only: days until the check (negative = overdue) |
| `checkState` | Pending only: `Overdue \| Today \| Upcoming` |
| `isCheckOverdue` | `checkState === "Overdue"` |
| `earliestConfirmDate` | service + 21 days |

### 3. Animal breeding history

`GET /api/v1/farms/:farmId/animals/:animalId/breedings`

```json
{
  "animal": { "_id": "…", "animalCode": "AN-000125", "gender": "Female", "reproductiveStatus": "Open", "...": "" },
  "summary": {
    "attempts": 3, "confirmed": 1, "failed": 2, "pending": 0, "evaluated": 3,
    "conceptionRatePercent": 33.33, "attemptsPerConception": 3, "avgAttemptsBeforePregnancy": 3,
    "consecutiveFailures": 0, "isRepeatBreeder": false,
    "lastHeatDate": "…", "lastServiceDate": "…", "daysSinceLastHeat": 40, "nextExpectedHeat": null
  },
  "activePendingChecks": [ "Pending records with derived check flags" ],
  "activePregnancy": { "pregnancyNo": "PRG-2026-000004", "expectedCalvingDate": "…" },
  "pregnancies": [ "all Pregnancy records of the animal" ],
  "eligibility": { "eligible": false, "blockers": ["…"], "warnings": [], "...": "" },
  "history": [ "oldest → newest, each with attemptNumber, attemptsForConception, pregnancy" ]
}
```

`isRepeatBreeder` = 3+ failed attempts in a row since the last conception. `nextExpectedHeat` = last heat + 21 days
(only when the last attempt is not Confirmed). `eligibility` is `null` for male animals.

### 4. Analytics

`GET /api/v1/farms/:farmId/breedings/analytics?from=&to=&breedingMethod=`

| Block | Contents |
|---|---|
| `totals` | attempts, confirmed, failed, pending, evaluated, `conceptionRatePercent` = Confirmed / (Confirmed + Failed) (Pending excluded), `attemptsPerConception` = evaluated / confirmed, `avgAttemptsBeforePregnancy`, animalsBred, heatOnly, overdueChecks, checksDueNext7Days, activePregnancies, calvingsDueNext30Days |
| `byMethod[]` | per method: attempts / confirmed / failed / pending / rate |
| `byBull[]`, `bySemenBatch[]`, `byTechnician[]` | top 10 by evaluated attempts, same stats |
| `monthly[]` | last 12 heat months in range: `month` (`YYYY-MM`) + stats |
| `repeatBreeders[]` | animals with ≥ 3 consecutive failures |
| `disclaimer` | bull / batch numbers are descriptive, not proof of genetic quality |

### 5. Pregnancy-check reminders

`GET /api/v1/farms/:farmId/breedings/pregnancy-checks?days=7` → `{ asOf, windowDays, overdue[], today[], upcoming[] }`
(Pending records only). There is no Notification module yet, so reminders are derived here.

### 6. Eligibility pre-check (form helper)

`GET /api/v1/farms/:farmId/breedings/eligibility?animalId=AN-000125&serviceDate=2026-08-18` →
`{ animal, eligible, blockers[], warnings[], ageMonths, activePregnancy, pendingBreedings[], lastBreeding, canCreate, suggestedPregnancyCheckDate }`

### 7. Bulls (picker)

`GET /api/v1/farms/:farmId/breedings/bulls?includeInactive=false&searchTerm=` → male animals of the farm
(`animalCode name tagNumber lifeStatus birthDate breedId purpose`) + `ageMonths`, `isMature`, `attempts`,
`confirmed`, `failed`, `conceptionRatePercent`. Active only by default; `includeInactive=true` adds sold / dead
sires (valid for AI / ET).

### 8. Meta

`GET /api/v1/farms/:farmId/breedings/meta` → `breedingMethods`, `pregnancyResults`, `resultTransitions`,
`updatableByResult`, `materialFields`, `permissions`, `reproductivePolicy`, `methodRules`, `sortFields`,
`dateFields`, `limits` (ages, check-day window, min confirm days, gestation 283 / 240–320, …).

### 9. One breeding

`GET /api/v1/farms/:farmId/breedings/:id` → the record populated (`animalId` with reproductive / life / health status,
`bullId`, `createdBy`) + derived fields + `attemptNumber` (1-based position in the animal's history),
`isLatestForAnimal`, `hasPregnancy`, and `pregnancy` (the linked Pregnancy record, or `null`).

### 10. Record the pregnancy-check result

`PATCH /api/v1/farms/:farmId/breedings/:id/pregnancy-result`

```json
{
  "pregnancyResult": "Confirmed",
  "checkDate": "2026-09-22",
  "conceptionDate": "2026-08-18",
  "expectedCalvingDate": "2027-05-28",
  "earlyCheck": false,
  "remarks": "Rectal palpation positive.",
  "reason": "only for corrections"
}
```

| Transition | Rules |
|---|---|
| Pending → **Confirmed** | service date recorded; ≥ **21 days** since service (409 otherwise); before `expectedPregnancyCheckDate` needs `earlyCheck: true`; no other active pregnancy for the animal (409). `conceptionDate` defaults to the service day (heat … service + 3 d); `expectedCalvingDate` defaults to conception + **283** days (allowed 240–320). |
| Pending → **Failed** | any time; the attempt is kept, no Pregnancy |
| Failed → Confirmed / Pending | correction — `reason` required |
| Confirmed → Failed | correction — `reason` required; the linked Pregnancy must still be `Pregnant` (409 once Delivered / Aborted) |
| anything else | 409 |

`checkDate` (default today) cannot be in the future or before the service date; it is stored in `remarks` and the
audit row because the schema has no actual-check-date field.

**Confirmed is one atomic unit** (MongoDB transaction, or undo-step compensation on a standalone server):
1. `Breeding.pregnancyResult = Confirmed` (optimistic lock on the current result + `updatedAt` → 409 on a race)
2. Pregnancy created: `pregnancyNo` `PRG-YYYY-NNNNNN`, `breedingId`, `animalId`, `farmId`, `conceptionDate`,
   `expectedCalvingDate`, `pregnancyStatus: Pregnant` — or, after an earlier Confirmed → Failed correction, the
   same Pregnancy is re-opened (unique index on `breedingId`: one breeding → at most one pregnancy)
3. `Animal.reproductiveStatus = Pregnant` when this is the latest breeding
4. AuditLog rows for the Breeding and the Pregnancy

Confirmed → Failed closes the linked Pregnancy as `Failed` (kept, never deleted) and returns the animal to `Open`
when nothing newer overrides it — also atomic.

**200** → `{ breeding, pregnancy: { _id, pregnancyNo, action: "Created" | "Reopened" | "Closed" } | null,
animalReproductiveStatus: { from, to } | null, calvingReminder: { expectedCalvingDate, dueInDays } | null, warnings[] }`

### 11. Correct a record

`PUT /api/v1/farms/:farmId/breedings/:id` — send only changed fields.

| Current result | Editable |
|---|---|
| Pending | `heatDetectedDate`, `inseminationDate` (or `null`), `breedingMethod`, `bullId` (or `null`), `semenBatchNo` (or `null`), `technicianName`, `expectedPregnancyCheckDate`, `remarks` |
| Confirmed / Failed | `bullId`, `semenBatchNo`, `technicianName`, `remarks` (correct the result first to change dates / method) |

`reason` (≥ 3 chars) is required when `heatDetectedDate`, `inseminationDate`, `breedingMethod` or `bullId` change.
The merged record is re-validated (date chain + method rules). `animalId` / `pregnancyResult` → 400.
**200** → `{ mode: "updated" | "unchanged", breeding, changedFields?, warnings[] }`. AuditLog events:
`Method Changed`, `Bull Changed`, `Semen Batch Changed`, `Pregnancy Check Date Changed`, `Heat Date Changed`,
`Insemination Date Changed`, `Technician Changed`, `Breeding Corrected`.

### 12. Delete an erroneous entry

`DELETE /api/v1/farms/:farmId/breedings/:id` with body `{ "reason": "Logged for the wrong cow" }` (required).

Owner only. Refused (409) for a `Confirmed` breeding or any breeding with a linked Pregnancy record (even one closed by
a correction). The full record is kept in the AuditLog (`Breeding Deleted`). **200** → `{ _id, breedingNo, deleted: true }`.

### 13. Change history

`GET /api/v1/farms/:farmId/breedings/:id/audit-logs?page=&limit=` — Owner / Manager / Vet. Rows for the breeding
**and** its linked Pregnancy (`entityType`), newest first: `logNo action event oldData newData changedFields createdAt
userId{userId fullName}` (no IP / user agent).

---

## Pregnancy record (Model 18, created by this module)

| Field | Notes |
|---|---|
| `pregnancyNo` | `PRG-YYYY-NNNNNN`, atomic per-year counter |
| `farmId`, `animalId`, `breedingId` | `breedingId` is unique |
| `conceptionDate`, `expectedCalvingDate` | from the confirmation |
| `actualCalvingDate`, `calfCount`, `calfGender` (`Male \| Female \| Twin`) | `null` until the calving workflow (future Pregnancy module) |
| `pregnancyStatus` | `Pregnant \| Delivered \| Aborted \| Failed` |
| `remarks`, `createdBy`, timestamps | |

Pregnancy routes (delivery, abortion, calving reminders) are a later module; today the record is read through the
breeding detail and the animal history. Both collections are included in permanent farm deletion
(`FARM_DATA_SOURCES`: `breedings`, `pregnancies`).
