# Liventra Backend — Treatments API (Model 16)

Base URL: `http://localhost:5000`

All endpoints require `Authorization: Bearer <accessToken>`. Response envelope and error shape are the
same as every other module (`{ success, message, data, meta? }` / `{ success: false, message, errorSources }`).

A Treatment answers **"what was diagnosed in this animal, when, which medicines were prescribed, who handled it,
and how did the episode end?"**. `Disease` (`/api/v1/diseases`) and `Medicine` (`/api/v1/medicines`) are global
master data; `Treatment` is the farm- and animal-level clinical episode.

```text
Animal → Treatment (Disease + medicines[]) → Inventory_Transaction (Treatment Usage) → Withdrawal → Follow-up → Recovered / Referred / Cancelled
```

All routes are farm-scoped: `/api/v1/farms/:farmId/...` where `:farmId` is the farm `_id` or `FARM-00001`.
`:id` accepts the treatment `_id` or its `treatmentNo` (`TRT-2026-000001`).
`animalId` accepts an animal `_id` or `animalCode` (`AN-000001`); `diseaseId` an `_id` or `DIS-00001`;
`medicines[].medicineId` an `_id` or `MED-00001`.

## Model (final DB schema)

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `treatmentNo` | String | `TRT-YYYY-NNNNNN`, server-generated (atomic per-year counter), immutable |
| `farmId` / `animalId` | ObjectId | immutable — an episode for the wrong animal is cancelled and recorded again |
| `diseaseId` | ObjectId → Disease | **singular** (one primary disease per episode); must be active for new episodes |
| `diagnosisDate` | Date (calendar day) | backdating allowed (≤ 3650 days), never in the future, never before birth |
| `symptoms[]` | String[] | observed in this animal (≤ 30, de-duplicated) — `Disease.symptoms` is the reference list |
| `treatedBy` | ObjectId → FarmMember | who handles the treatment (Owner / Manager / Vet / Worker); defaults to the caller |
| `medicines[]` | `{ _id, medicineId, dosage, dosageUnit, frequency, duration, administrationRoute, instructions? }` | 1–15 lines, one per medicine |
| `estimatedCost` | Number \| null | estimate only (≥ 0) — never creates an Expense |
| `status` | `Ongoing \| Recovered \| Referred \| Cancelled` | always created `Ongoing` |
| `followUpDate` | Date \| null | ≥ `diagnosisDate`, ≤ 365 days ahead |
| `completedDate` | Date \| null | set only by `PATCH /status` → `Recovered` (default today); `null` otherwise |
| `remarks` | String | ≤ 1000 chars; outcome / referral / cancellation notes are appended as `[Status] note` |
| `createdBy` | ObjectId → FarmMember | who entered the record (may differ from `treatedBy`) |

Clients may never send `treatmentNo`, `farmId`, `createdBy`, `completedDate` (except via status) or timestamps (400). Bodies are strict.

### Medicine line rules

| Rule | Result |
|---|---|
| Medicine missing / retired (`isActive: false`) | 404 / 409 (a line already on the episode may keep a later-retired medicine) |
| Same medicine twice | 400 — combine into one line |
| `dosage` ≤ 0 | 400 |
| `dosageUnit` not allowed for `Medicine.dosageForm` | 400 — see matrix below |
| `administrationRoute` not compatible with `Medicine.dosageForm` | 400 — same matrix as `/medicines/meta` |
| `frequency` / `duration` missing | 400 (free text, ≤ 60 chars) |

| dosageForm | dose units | routes |
|---|---|---|
| Injection | ml, mg, dose | IM, IV, SC |
| Tablet | tablet, mg | Oral |
| Bolus | bolus, mg, g | Oral |
| Powder | g, mg, sachet, dose, ml | Oral, Topical, IM, IV, SC |
| Liquid | ml, dose | Oral, Topical, Intranasal |
| Spray | application, ml, dose | Topical, Intranasal |
| Ointment | application, g | Topical |

### Prescription rule

If any medicine has `prescriptionRequired: true`, either the caller or `treatedBy` must be an **Owner, Manager or
Veterinarian** (403 otherwise). When no Veterinarian is involved the response carries a warning.

### Animal health status sync

| Event | `Animal.healthStatus` |
|---|---|
| Treatment created / reopened | `Under Treatment` |
| Recovered and no other `Ongoing` / `Referred` episode | `Healthy` (from Under Treatment / Sick) |
| Recovered but another episode is still `Ongoing` | stays `Under Treatment` |
| Referred | unchanged (not marked Healthy) |
| Cancelled / deleted and nothing else open | `Healthy` only if it was `Under Treatment` |
| Animal in `Quarantine` | never overwritten |

### Withdrawal (derived, never stored)

Per non-cancelled line whose medicine has `withdrawalPeriodDays > 0`:
last dose = `completedDate` → else `diagnosisDate + duration − 1` (duration text parsed: `5 days`, `2 weeks`,
`36 hours`, `Single dose`) → else `followUpDate` → else `diagnosisDate`; an `Ongoing` course is never earlier than today.
Restriction ends at `lastDose + withdrawalPeriodDays`; the animal-level end is the **maximum** across active lines
(`provisional: true` while a course is still Ongoing). Milk and meat share the single catalog field.

```json
"withdrawal": {
  "underWithdrawal": true, "withdrawalEndDate": "2026-09-02T00:00:00.000Z", "daysRemaining": 9,
  "provisional": false, "restrictions": ["Milk", "Meat"],
  "lines": [{ "treatmentNo": "TRT-2026-000001", "medicineName": "Oxytetracycline", "withdrawalPeriodDays": 7,
              "lastDoseDate": "...", "withdrawalEndDate": "...", "provisional": false, "daysRemaining": 9 }]
}
```

## Roles (farm role from the active FarmMember row)

| Action | Owner | Manager | Veterinarian | Worker | Accountant |
|---|---|---|---|---|---|
| List / get / animal history / stats / follow-ups / withdrawals / meta / staff / stock-options | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create (start an episode) | ✅ | ✅ | ✅ | ✅ | ❌ |
| Consume inventory (medicine drawn from stock) | ✅ | ✅ | ✅ | ✅ | ❌ |
| Change status (Recovered / Referred / Cancelled), update (`PUT`), audit logs | ✅ | ✅ | ✅ | ❌ | ❌ |
| Reopen a Recovered / Referred episode (→ Ongoing) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Delete an unexecuted erroneous entry | ✅ | ❌ | ❌ | ❌ | ❌ |

- Platform `superAdmin` and the farm's owner account act as **Owner**; platform `admin` does not.
- Writes need an **Active** farm (otherwise 403) and a FarmMember row.
- A record or animal of another farm is reported as **404** (farm isolation).
- The final DB schema CRUD table lists Worker as read-only and no Delete; DO.md's route table lets Workers create and
  record medicine usage and lets the Owner delete erroneous entries — that is what is implemented (`TreatmentPermissions`).

## Endpoints

| Method | Path | Who |
|---|---|---|
| POST | `/api/v1/farms/:farmId/treatments` | Owner / Manager / Vet / Worker |
| GET | `/api/v1/farms/:farmId/treatments` | Farm member |
| GET | `/api/v1/farms/:farmId/treatments/meta` | Farm member |
| GET | `/api/v1/farms/:farmId/treatments/stats` | Farm member |
| GET | `/api/v1/farms/:farmId/treatments/follow-ups` | Farm member |
| GET | `/api/v1/farms/:farmId/treatments/withdrawals` | Farm member |
| GET | `/api/v1/farms/:farmId/treatments/staff` | Farm member |
| GET | `/api/v1/farms/:farmId/treatments/:id` | Farm member |
| GET | `/api/v1/farms/:farmId/treatments/:id/stock-options` | Farm member |
| GET | `/api/v1/farms/:farmId/treatments/:id/audit-logs` | Owner / Manager / Vet |
| PATCH | `/api/v1/farms/:farmId/treatments/:id/status` | Owner / Manager / Vet (reopen: Owner / Manager) |
| POST | `/api/v1/farms/:farmId/treatments/:id/consume-inventory` | Owner / Manager / Vet / Worker |
| PUT | `/api/v1/farms/:farmId/treatments/:id` | Owner / Manager / Vet |
| DELETE | `/api/v1/farms/:farmId/treatments/:id` | Owner |
| GET | `/api/v1/farms/:farmId/animals/:animalId/treatments` | Farm member |

---

### POST `/treatments` — start an episode

```json
{
  "animalId": "AN-000125",
  "diseaseId": "DIS-00004",
  "diagnosisDate": "2026-08-17",
  "symptoms": ["Fever", "Reduced appetite"],
  "treatedBy": "68a7f1c82f6a4b9e12345678",
  "medicines": [
    { "medicineId": "MED-00001", "dosage": 5, "dosageUnit": "ml", "frequency": "Once daily",
      "duration": "5 days", "administrationRoute": "IM", "instructions": "After feeding" }
  ],
  "estimatedCost": 850,
  "followUpDate": "2026-08-22",
  "remarks": "Follow-up required.",
  "confirmDuplicate": false
}
```

| Check | Result |
|---|---|
| Animal not in this farm | 404 |
| Animal `lifeStatus` ≠ `Active` (Sold / Dead / Transferred / Archived) | 409 — Quarantine **is** allowed |
| Disease missing / inactive | 404 / 409 |
| Future `diagnosisDate`, before birth, `followUpDate` < diagnosis | 400 |
| `treatedBy` not an active Owner / Manager / Vet / Worker of this farm | 400 |
| Possible duplicate: same animal + disease with an open episode, or one diagnosed within ±3 days | 409 unless `confirmDuplicate: true` |
| `status` sent | 400 (always Ongoing) |

`201` → `data`:

```json
{
  "treatment": { "...populated detail (see GET /:id)" },
  "animalHealthStatus": { "from": "Healthy", "to": "Under Treatment" },
  "followUpReminder": { "followUpDate": "2026-08-22T00:00:00.000Z", "dueInDays": 5 },
  "warnings": ["Foot and Mouth Disease is contagious — consider moving AN-000125 to Quarantine."]
}
```

No stock is deducted on create — medicine is drawn through `consume-inventory`. There is no Notification module yet,
so the follow-up reminder is derived and surfaced by `GET /follow-ups` / `GET /stats`.

### GET `/treatments` — list

Query: `page`, `limit` (≤ 100), `sort` (`-diagnosisDate` default; fields `diagnosisDate, followUpDate, completedDate,
createdAt, updatedAt, status, treatmentNo, estimatedCost`), `animalId`, `diseaseId`, `medicineId`, `status`
(comma list), `open=true` (Ongoing + Referred), `treatedBy` (member `_id`), `followUp=overdue|today|upcoming`
(+ `followUpDays`, default 7; `overdue=true` is an alias), `from` / `to` (diagnosisDate), `searchTerm`
(treatmentNo, remarks, symptoms).

Each row is populated (animal, disease, medicines, treatedBy, createdBy) and carries derived fields:
`isOpen`, `followUpDueInDays`, `followUpState` (`Overdue | Today | Upcoming | null`), `isFollowUpOverdue`, `treatmentDays`.

### GET `/treatments/:id`

Full detail: populated `animalId`, `diseaseId` (with reference `symptoms`, severity, contagious, prevention),
`medicines[].medicineId` (form, strength, route, withdrawal, prescriptionRequired), `treatedBy` / `createdBy`
(name + role), derived fields, `withdrawal` (this episode only), `stockConsumed[]` (net per stock row),
`hasStockMovements`, `inventoryTransactions[]` (ledger rows).

### GET `/animals/:animalId/treatments`

```json
{
  "animal": { "animalCode": "AN-000125", "healthStatus": "Under Treatment", "...": "..." },
  "counts": { "Ongoing": 1, "Recovered": 3, "Referred": 0, "Cancelled": 0 },
  "summary": { "totalTreatments": 4, "openTreatments": 1, "avgRecoveryDays": 5.3, "estimatedCostTotal": 3200, "lastDiagnosisDate": "..." },
  "activeTreatments": [ "...Ongoing / Referred episodes (care plans)" ],
  "withdrawal": { "...animal-level, conservative maximum" },
  "history": [ "...latest first, max 500" ]
}
```

### PATCH `/treatments/:id/status`

```json
{ "status": "Recovered", "completedDate": "2026-08-22", "remarks": "Responded well." }
{ "status": "Referred", "remarks": "Referred to Upazila Veterinary Hospital — worsening lameness" }
{ "status": "Cancelled", "remarks": "Duplicate entry", "restoreStock": true }
{ "status": "Ongoing", "remarks": "Relapse after 3 days" }
```

| From → To | Rule |
|---|---|
| Ongoing → Recovered | `completedDate` (default today) ≥ diagnosis, not future |
| Ongoing → Referred | `remarks` (referral details) required; `completedDate` stays null |
| Ongoing / Referred → Cancelled | `remarks` (reason) required; if stock was drawn, `restoreStock` (true = Return rows, false = keep as used) is required (409 otherwise) |
| Referred → Recovered | same as Ongoing → Recovered |
| Recovered / Referred → Ongoing | **reopen** — Owner / Manager only, `remarks` required, animal must be Active; `completedDate` cleared |
| Recovered → Cancelled, Cancelled → anything | 409 |

Response: `{ treatment, animalHealthStatus: { from, to } | null, stockMovements[] }`. AuditLog: `oldData`, `newData`, `changedFields`.

### POST `/treatments/:id/consume-inventory`

```json
{ "items": [ { "medicineId": "MED-00001", "quantity": 5, "inventoryId": "optional stock row _id" } ], "remarks": "Morning dose" }
```

- Omit `items` to draw every prescribed line once. Each item may name the line by `lineId` (medicines[] `_id`) or `medicineId`.
- Stock row: the chosen `inventoryId`, else **FEFO** among the farm's usable `itemType: "Medicine"` rows (`referenceId` = medicine).
- Quantity is in the stock row's unit; defaults to the line `dosage` when the units match (`piece` stock counts tablet /
  bolus / sachet / dose). Otherwise `quantity` is required.
- Not stocked, expired / inactive, or insufficient stock → **422** listing every problem; nothing is written.
- All deductions + `Inventory_Transaction` rows (`transactionType: "Treatment Usage"`, `referenceType: "Treatment"`,
  `referenceId: treatment._id`) run in one transaction (compensation on a standalone mongod).
- Allowed for Ongoing / Recovered / Referred episodes (not Cancelled). Can be called again for later doses.

Response: `{ treatment, stockMovements: [{ transactionNo, itemName, quantity, unit, stockBefore, stockAfter }] }`.

`GET /:id/stock-options` lists, per prescribed line, the farm's stock rows with `usable`, `unitMatchesDose`, `defaultQuantity`.

### PUT `/treatments/:id` — controlled update

| Status | Editable fields |
|---|---|
| Ongoing | `diseaseId`, `diagnosisDate`, `symptoms`, `treatedBy`, `medicines`, `estimatedCost`, `followUpDate`, `remarks` |
| Referred | `followUpDate`, `estimatedCost`, `remarks` |
| Recovered / Cancelled | `remarks` |

- Changing `diseaseId`, `diagnosisDate` or `medicines` requires `reason` (≥ 3 chars).
- `animalId` / `status` are refused (use cancel + new record / `PATCH /status`).
- A medicine that already drew stock cannot be removed from `medicines` (409).
- Optimistic concurrency: a record changed meanwhile → 409.
- Response: `{ mode: "updated" | "unchanged", treatment, changedFields, warnings }`; AuditLog records the full diff.

### DELETE `/treatments/:id` — Owner only

Optional body `{ "reason": "Entered for the wrong animal" }`. Only `Ongoing` / `Cancelled` episodes **without any stock
movement**; Recovered / Referred (medical history) or inventory-linked episodes → 409 (cancel instead).
Animal health status is recalculated. Response: `{ _id, treatmentNo, deleted: true, animalHealthStatus }`.

### GET `/treatments/stats`

Optional `from` / `to` (diagnosisDate). Returns `totals` (`total`, `byStatus`, `animalsUnderTreatment`,
`followUpsOverdue`, `followUpsToday`, `followUpsUpcoming`, `recoveryRatePercent`, `avgRecoveryDays`,
`estimatedCostTotal`, `estimatedCostAverage`), `topDiseases[]`, `topMedicines[]`.

### GET `/treatments/follow-ups`

`?days=7` (0–90). Open episodes grouped as `{ overdue[], today[], upcoming[] }`.

### GET `/treatments/withdrawals`

Active animals currently inside a withdrawal window: `{ asOf, animals: [{ animal, underWithdrawal, withdrawalEndDate, daysRemaining, provisional, restrictions, lines[] }] }`.

### GET `/treatments/staff`

`{ me, myRole, members: [{ _id, role, userId, fullName, canPrescribe }] }` — Owner / Manager / Vet / Worker only, no private fields.

### GET `/treatments/meta`

Statuses, `transitions`, `openStatuses`, `dosageUnits`, `dosageUnitCompatibility`, `administrationRoutes` (+ labels),
`routeCompatibility`, `frequencySuggestions`, `durationSuggestions`, `permissions`, `treatedByRoles`,
`prescriberRoles`, `sortFields`, `limits`.

### GET `/treatments/:id/audit-logs` — Owner / Manager / Vet

Paginated AuditLog rows (`entityType: "Treatment"`): `logNo, action, event, oldData, newData, changedFields, createdAt, userId`.
Events: Treatment Created / Updated / Recovered / Referred / Cancelled / Reopened / Deleted, Medicines Changed,
Follow-up Changed, Disease Changed, Diagnosis Date Changed, Treated By Changed, Treatment Medicine Consumed.

## Integrations

- `milkRecord.utils.ts` `findActiveWithdrawals()` reads the `treatments` collection with the same field names, so milk
  `withdrawalFlag` now reflects real treatments.
- Disease / Medicine `/usage` and hard-delete guards read `treatments` (`diseaseId`, `medicines.medicineId`).
