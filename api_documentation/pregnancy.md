# Liventra Backend — Pregnancy API (Model 18)

Base URL: `http://localhost:5000`

All endpoints require `Authorization: Bearer <accessToken>`. Response envelope and error shape are the
same as every other module (`{ success, message, data, meta? }` / `{ success: false, message, errorSources }`).

A Pregnancy record answers **"which animal became pregnant from which breeding, when was conception recorded, when
is calving expected, when did calving actually happen, how many calves resulted, and what is the current
status?"**. One record = one pregnancy episode. The upstream **Breeding** event (Model 17) records the attempt;
the **Pregnancy** records the resulting lifecycle.

```text
Female Animal → Heat → Breeding (Pending) → Pregnancy check → Confirmed → Pregnancy (Pregnant) → Calving → Delivered
                                                              └→ Failed → no Pregnancy
Pregnancy (Pregnant) → Aborted / Failed (unsuccessful outcome)
```

All routes are farm-scoped: `/api/v1/farms/:farmId/...` where `:farmId` is the farm `_id` or `FARM-00001`.
`:id` accepts the pregnancy `_id` or its `pregnancyNo` (`PRG-2026-000001`).
`animalId` accepts an animal `_id` or `animalCode` (`AN-000001`) of the **same farm**.
`breedingId` accepts a breeding `_id` or `breedingNo` (`BRD-2026-000001`) of the same farm.

## Model (final DB schema)

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `pregnancyNo` | String | `PRG-YYYY-NNNNNN`, server-generated (atomic per-year counter), immutable |
| `farmId` / `animalId` | ObjectId | immutable; the animal must be a Female of this farm |
| `breedingId` | ObjectId | immutable; **unique** — one breeding → at most one pregnancy |
| `conceptionDate` | Date (calendar day) | required; between the heat date and 3 days after the service date |
| `expectedCalvingDate` | Date (calendar day) | required; 240–320 days after conception (defaults to +283) |
| `actualCalvingDate` | Date \| null | set by the calving workflow; required once `Delivered` |
| `calfCount` | Number \| null | 1–10; required once `Delivered` |
| `calfGender` | `Male \| Female \| Twin` \| null | required once `Delivered`; `Twin` only when `calfCount = 2` |
| `pregnancyStatus` | `Pregnant \| Delivered \| Aborted \| Failed` | created `Pregnant` |
| `remarks` | String | ≤ 2000 chars |
| `createdBy` | ObjectId → FarmMember | who created the record |

Clients may never send `pregnancyNo`, `farmId`, `createdBy`, `_id` or timestamps (400). Bodies are strict.

There is **no** `abortionDate`, `deliveryType`, `calfIds[]` or `actualPregnancyCheckDate` (final schema): abortion
timing goes in `remarks` + the AuditLog, and calf-level detail is a separate future Animal workflow.

### Status lifecycle

| Current | Next | Allowed |
|---|---|---|
| Pregnant | Delivered | ✅ calving workflow |
| Pregnant | Aborted | ✅ outcome workflow |
| Pregnant | Failed | ✅ outcome workflow |
| Delivered / Aborted / Failed | anything | ❌ terminal (correct the record instead) |

`Animal.reproductiveStatus` is kept in sync from the **latest valid pregnancy** (never overwritten by an older
cycle): `Pregnant` while active, `Lactating` after delivery, `Open` after abortion / failure when nothing newer
overrides it.

## Permissions (farm role)

| Action | Owner | Manager | Veterinarian | Worker | Accountant |
|---|---|---|---|---|---|
| Read list / detail / animal history / analytics | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create a pregnancy (`POST`) | ✅ | ✅ | ✅ | ❌ | ❌ |
| Record calving (`PATCH /deliver`) | ✅ | ✅ | ✅ | ❌ | ❌ |
| Record an outcome (`PATCH /outcome`) | ✅ | ✅ | ✅ | ❌ | ❌ |
| Correct a record (`PUT`) | ✅ | ✅ | ✅ | ❌ | ❌ |
| Eligible-breedings picker (`GET /eligible-breedings`) | ✅ | ✅ | ✅ | ❌ | ❌ |
| Change history (`GET /:id/audit-logs`) | ✅ | ✅ | ✅ | ❌ | ❌ |
| Delete (`DELETE`) | ✅ (blocked — see below) | ❌ | ❌ | ❌ | ❌ |

Platform `superAdmin` and the farm's owner account act as Owner; platform `admin` has no bypass. Writes need an
**Active** farm (Setup / Inactive / Suspended → 403).

---

## Endpoints

| Method | Path | Who |
|---|---|---|
| POST | `/api/v1/farms/:farmId/pregnancies` | Owner / Manager / Vet |
| GET | `/api/v1/farms/:farmId/pregnancies` | Farm member |
| GET | `/api/v1/farms/:farmId/pregnancies/analytics` | Farm member |
| GET | `/api/v1/farms/:farmId/pregnancies/eligible-breedings` | Owner / Manager / Vet |
| GET | `/api/v1/farms/:farmId/pregnancies/:id` | Farm member |
| GET | `/api/v1/farms/:farmId/pregnancies/:id/audit-logs` | Owner / Manager / Vet |
| PATCH | `/api/v1/farms/:farmId/pregnancies/:id/deliver` | Owner / Manager / Vet |
| PATCH | `/api/v1/farms/:farmId/pregnancies/:id/outcome` | Owner / Manager / Vet |
| PUT | `/api/v1/farms/:farmId/pregnancies/:id` | Owner / Manager / Vet |
| DELETE | `/api/v1/farms/:farmId/pregnancies/:id` | Owner (blocked) |
| GET | `/api/v1/farms/:farmId/animals/:animalId/pregnancies` | Farm member |

### 1. Create a pregnancy from a confirmed breeding

`POST /api/v1/farms/:farmId/pregnancies`

```json
{
  "breedingId": "BRD-2026-000015",
  "conceptionDate": "2026-08-18",
  "expectedCalvingDate": "2027-05-28",
  "remarks": "Rectal palpation positive."
}
```

Validation & integrity rules:

- `breedingId` must exist in this farm, be `Confirmed`, and belong to a **Female Active** animal of this farm.
- **1 Breeding → 1 Pregnancy**: a pregnancy already linked to that breeding → 409 (the unique index is the final guard).
- The animal must not already have an open `Pregnant` episode → 409.
- `conceptionDate` defaults to the breeding's insemination (service) date and must fall between the heat date and
  service + 3 days.
- `expectedCalvingDate` defaults to `conceptionDate + 283` days and must be 240–320 days after conception.
- Side effects: `pregnancyNo` `PRG-YYYY-NNNNNN`, `Animal.reproductiveStatus = "Pregnant"`, AuditLog (`Pregnancy Created`).

**201** → `{ pregnancy: { "...populated record" } }`

Errors: 400 (server fields / dates), 403 (role / farm status), 404 (breeding / animal not in farm),
409 (unconfirmed breeding / duplicate / active pregnancy).

> The Breeding module already creates the Pregnancy atomically when a pregnancy check is `Confirmed`, so this
> endpoint is mainly for explicit or historical creation from an already-confirmed breeding.

### 2. List pregnancy episodes

`GET /api/v1/farms/:farmId/pregnancies`

| Query | Meaning |
|---|---|
| `page`, `limit` (≤ 100) | pagination |
| `animalId` | `_id` or `AN-…` of this farm |
| `pregnancyStatus` | comma list: `Pregnant,Delivered,Aborted,Failed` |
| `upcomingCalvingDays` | Pregnant episodes expected to calve within N days |
| `overdueCalving=true` | Pregnant **and** `expectedCalvingDate` < today (derived; nothing is auto-changed) |
| `from`, `to` (YYYY-MM-DD) + `dateField` | range on `expectedCalvingDate` (default) or `conceptionDate` |
| `searchTerm` | pregnancyNo, animal code or name |
| `sort` | e.g. `-expectedCalvingDate` (default), `conceptionDate`, `pregnancyNo`, … |

Each row: the record with `animalId` (`animalCode name gender lifeStatus reproductiveStatus`),
`breedingId` (`breedingNo breedingMethod heatDetectedDate inseminationDate pregnancyResult`) and
`createdBy` (member + user name). `meta` = `{ page, limit, totalEntries, totalPage }`.

### 3. Animal lifetime pregnancy history

`GET /api/v1/farms/:farmId/animals/:animalId/pregnancies`

```json
{
  "animal": { "_id": "…", "animalCode": "AN-000125", "gender": "Female", "reproductiveStatus": "Pregnant", "...": "" },
  "activePregnancy": { "pregnancyNo": "PRG-2026-000004", "expectedCalvingDate": "…" },
  "pregnancies": [ "all pregnancy episodes, newest conception first" ]
}
```

`animalId` is **not** unique across a lifetime — every episode is kept. `activePregnancy` is the current
`Pregnant` episode (or `null`).

### 4. Reproductive analytics

`GET /api/v1/farms/:farmId/pregnancies/analytics?from=&to=`

| Block | Contents |
|---|---|
| `totalPregnancies` | all episodes in range |
| `byStatus` | `{ Pregnant, Delivered, Aborted, Failed }` counts |
| `deliveryRatePercent` | Delivered / (Delivered + Aborted + Failed) × 100 |
| `abortionRatePercent` | Aborted / total × 100 |
| `twinRatePercent` | `calfCount = 2` deliveries / Delivered × 100 |
| `averageGestationDays` | mean (actualCalvingDate − conceptionDate) over deliveries |
| `averageCalvesPerDelivery` | mean calfCount over deliveries |
| `totalCalves` | sum of calfCount over deliveries |
| `upcomingCalvings` | Pregnant episodes expected within the next 30 days |
| `overdueCalvings` | Pregnant episodes whose expected date has passed |

### 5. Confirmed breedings that can still start a pregnancy

`GET /api/v1/farms/:farmId/pregnancies/eligible-breedings?animalId=&searchTerm=&page=&limit=`

Owner / Manager / Vet only — it feeds the "Record Pregnancy" picker. Lists this farm's breedings where:

- `pregnancyResult === "Confirmed"`, and
- no `Pregnancy` row links to the breeding (**1 Breeding → 1 Pregnancy**), and
- the female is `Active` and has **no open `Pregnant` episode**.

Sorted newest service first. Each row carries the breeding (`breedingNo`, method, heat / insemination dates,
semen batch, technician), the populated `animalId` and `bullId`, plus the defaults `POST /` would apply:

| Field | Meaning |
|---|---|
| `suggestedConceptionDate` | the insemination date, or the heat date when there is none |
| `suggestedCalvingDate` | `suggestedConceptionDate + 283` days |

The list only narrows the picker — `POST /` re-validates every rule, so a stale list can never create an
invalid record. `meta` = `{ page, limit, totalEntries, totalPage }`.

### 6. One pregnancy

`GET /api/v1/farms/:farmId/pregnancies/:id` (`_id` or `PRG-YYYY-NNNNNN`)

Returns the record populated with the **animal**, the **upstream breeding** (including the **sire** `bullId`),
and the **creator**, plus derived fields:

| Derived | Meaning |
|---|---|
| `daysSinceConception` | today − conceptionDate |
| `daysUntilCalving` | expectedCalvingDate − today (negative = overdue) |
| `isOverdue` | Pregnant and expected date passed |
| `pregnancyDurationDays` | actualCalvingDate − conceptionDate (Delivered only) |
| `calvingVarianceDays` | actualCalvingDate − expectedCalvingDate (Delivered only; negative = early) |

### 7. Record the calving (deliver)

`PATCH /api/v1/farms/:farmId/pregnancies/:id/deliver`

```json
{
  "actualCalvingDate": "2027-05-16",
  "calfCount": 1,
  "calfGender": "Female",
  "remarks": "Normal delivery, healthy calf."
}
```

- Only a `Pregnant` episode can be delivered (409 otherwise).
- `actualCalvingDate` cannot be in the future or before conception; gestation must be 240–320 days.
- `calfCount` 1–10 and `calfGender` `Male | Female | Twin`; `Twin` only when `calfCount = 2`.
- **Atomic unit**: `Pregnancy → Delivered`, `Animal.reproductiveStatus → Lactating`, AuditLog (`Pregnancy Delivered`).

**200** → `{ pregnancy: { "...populated record" } }`

### 8. Record an unsuccessful outcome

`PATCH /api/v1/farms/:farmId/pregnancies/:id/outcome`

```json
{
  "outcome": "Aborted",
  "reason": "Veterinary confirmation of pregnancy loss.",
  "remarks": "No further complications."
}
```

- Only a `Pregnant` episode can be closed (409 otherwise).
- `outcome` must be `Aborted` or `Failed`; `reason` (≥ 3 chars) is required and is appended to `remarks`.
- **Atomic unit**: `Pregnancy → Aborted | Failed`, `Animal.reproductiveStatus → Open` when no newer pregnancy
  overrides it, AuditLog (`Pregnancy Aborted` / `Pregnancy Failed`).

**200** → `{ pregnancy, outcome, reason, reproductiveStatusUpdated }`

### 9. Correct administrative / timeline fields

`PUT /api/v1/farms/:farmId/pregnancies/:id` — send only changed fields.

| Field | Notes |
|---|---|
| `conceptionDate` | re-validated against the breeding heat / service window |
| `expectedCalvingDate` | re-validated to 240–320 days after conception |
| `remarks` | replaces the stored remarks |
| `reason` | required (≥ 3 chars) when a date changes |

Immutable / server-managed: `pregnancyNo`, `farmId`, `animalId`, `breedingId`, `createdBy`, `pregnancyStatus`
(use `/deliver` or `/outcome`), timestamps → 400. AuditLog `Pregnancy Corrected` records `oldData`, `newData` and
`changedFields`.

**200** → `{ mode: "updated" | "unchanged", pregnancy, changedFields? }`

### 10. Change history (audit logs)

`GET /api/v1/farms/:farmId/pregnancies/:id/audit-logs?page=&limit=` — Owner / Manager / Vet.

Newest first. Returns rows written against **this pregnancy** and against its **upstream breeding**, so the
whole paper trail (confirmation → creation → calving / outcome → corrections) reads in one list. Each row:
`logNo action event entityType oldData newData changedFields status createdAt userId` (user populated with
`userId fullName`). IP address and user agent are never exposed to farm users. `meta` =
`{ page, limit, totalEntries, totalPage }`.

### 11. Delete — blocked

`DELETE /api/v1/farms/:farmId/pregnancies/:id` (Owner only)

Pregnancy records are **historical reproductive records** and are never hard-deleted (they feed animal state,
analytics, reports and calf creation). The endpoint always answers **403** with a message to use the
`/outcome` transition (Aborted / Failed) or `PUT` correction instead.

---

## Pregnancy ↔ other modules

- **Breeding (Model 17)**: `breedingId` is unique; a confirmed check creates the pregnancy atomically.
- **Animal (Model 05)**: `Animal.reproductiveStatus` follows the latest valid pregnancy.
- **Milk (Model 10)**: a delivered animal normally becomes `Lactating`, then MilkRecord applies.
- **Notification (Model 23)**: expected-calving reminders use `referenceType = Pregnancy`.
- **AuditLog (Model 24)**: create / deliver / outcome / correction events are recorded.
- Permanent farm deletion includes `pregnancies` (`FARM_DATA_SOURCES`).
