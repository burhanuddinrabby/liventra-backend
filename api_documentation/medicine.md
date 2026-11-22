# Liventra Backend — Medicines API (Model 15)

Base URL: `http://localhost:5000`

All endpoints require `Authorization: Bearer <accessToken>`.

Common response envelope (via `sendResponse`):

```json
{ "success": true, "message": "<string>", "data": { } }
```

List endpoints also return a `meta` object (`page`, `limit`, `totalEntries`, `totalPage`). Errors come
from `globalErrorHandler`:

```json
{ "success": false, "message": "<string>", "errorSources": [ { "errorPath": "", "errorMessage": "<string>" } ] }
```

Medicine is **global master/reference data** (no `farmId`): it describes *what* a veterinary product is
(active ingredient, brand, strength, form, default route, storage, withdrawal rule). It never stores which
animal received it, the dose, or stock. Those belong to:

- `Treatment.medicines[].medicineId` (Model 16, not built yet): the actual dose, frequency, duration and route for one animal
- `Inventory.referenceId` with `itemType: "Medicine"`: farm-specific stock, batch and expiry

Medicines are **retired** (`isActive: false`) rather than deleted, so those references never break.
`MilkRecord` already reads `medicines.withdrawalPeriodDays` to flag milk during a withdrawal window.

## Schema note (DO.md vs final schema)

| Topic | DO.md / spec MD | Implemented (final schema wins) |
|---|---|---|
| Code format | `MED-001` / `MED-ANT-001` | `MED-00001` (final schema example), immutable, system-generated |
| Required fields | genericName, strength, storageCondition "recommended" | **required**: final schema marks them `Y` |
| `administrationRoute` | required (DO.md) | required, and must be compatible with `dosageForm` |

## Enums

```text
category:            Antibiotic | Anthelmintic | Antipyretic | Vitamin | Mineral | Pain Killer | Hormone | Supplement | Other
dosageForm:          Injection | Tablet | Bolus | Powder | Liquid | Spray | Ointment
administrationRoute: IM | IV | SC | Oral | Topical | Intranasal
```

### Route / dosage-form compatibility

| dosageForm | Allowed administrationRoute |
|---|---|
| Injection | IM, IV, SC |
| Tablet | Oral |
| Bolus | Oral |
| Powder | Oral, Topical, IM, IV, SC (reconstituted) |
| Liquid | Oral, Topical, Intranasal |
| Spray | Topical, Intranasal |
| Ointment | Topical |

Anything else (for example `Tablet + IV` or `Ointment + IV`) → **400**. The matrix is served by
`GET /api/v1/medicines/meta` as `routeCompatibility`, so the UI does not hardcode it.

## Roles

| Action | Who |
|---|---|
| Read (list, lookup, meta, stats, get, withdrawal-preview) | any signed-in user |
| List retired medicines (`?isActive=false\|all`) | `admin` / `superAdmin` (everyone else always gets active only) |
| Get a retired medicine by id/code | any signed-in user (historical Treatment rows must resolve) |
| Create, update, retire/reactivate, delete, check-duplicate | platform `admin` / `superAdmin` |
| Usage counts, audit history | `admin` / `superAdmin` |

Farm Owners, Managers, Workers and Veterinarians only *select* medicines. The final schema's CRUD table gives
create/update/delete to Admin only.

## Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `medicineCode` | String | auto | `MED-00001`; immutable, never accepted from the client |
| `medicineName` | String | yes | 2–150 chars; inner whitespace collapsed |
| `genericName` | String | yes | 2–150, active ingredient; **not unique** (several brands may share it) |
| `brandName` | String | no | 1–150; `null`/`""` clears it on PUT |
| `manufacturer` | String | yes | 2–150 |
| `category` | Enum | yes | see enums |
| `dosageForm` | Enum | yes | see enums |
| `strength` | String | yes | ≤ 60; must start with a number + unit or `%`: `200 mg/ml`, `500 mg`, `10%`, `5 IU/ml`. `abc` → 400 |
| `administrationRoute` | Enum | yes | must be allowed for `dosageForm` |
| `description` | String | no | ≤ 2000; `null`/`""` clears it on PUT |
| `storageCondition` | String | yes | 2–200, e.g. `Store below 25°C`, `2–8°C` |
| `withdrawalPeriodDays` | Integer | yes | 0–3650; `0` = no waiting period; negative → 400 |
| `prescriptionRequired` | Boolean | yes | workflow flag (future vet approval in Treatment) |
| `isActive` | Boolean | auto | `true` on create; changed only through toggle-active / DELETE |
| `createdAt` / `updatedAt` | Date | auto | |

Unknown keys are ignored; `medicineCode` and `isActive` in a POST/PUT body are ignored.

## Duplicate prevention

Comparison is case-, space- and punctuation-insensitive (`&` = `and`; `/ % .` are kept because they change
strength meaning). A create or update answers **409** when another medicine (active or retired) has the same:

1. `medicineName + strength + dosageForm + manufacturer`, or
2. `genericName + brandName + manufacturer + strength + dosageForm` (only when `brandName` is set)

The same `genericName` alone is allowed. If the match is retired, the message says so; reactivate it instead.

## Identity protection

Once **any** Treatment or Inventory row references the medicine, these fields are locked:
`genericName`, `brandName`, `manufacturer`, `strength`, `dosageForm`. Changing them → **409**: register a new
medicine for a different product. `medicineName`, `category`, `administrationRoute` (still checked against the
form), `description`, `storageCondition`, `withdrawalPeriodDays` and `prescriptionRequired` remain editable.
Every change writes an AuditLog row (`entityType: "Medicine"`).

Audit events: `Medicine Created`, `Medicine Updated`, `Strength Changed`, `Route Changed`,
`Withdrawal Period Changed`, `Prescription Requirement Changed`, `Manufacturer Changed`, `Category Changed`,
`Medicine Activated`, `Medicine Deactivated`, `Medicine Deleted`.

## Endpoint summary

| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/v1/medicines` | admin | Register a medicine |
| GET | `/api/v1/medicines` | signed-in | Paginated list + filters + multi-field search |
| GET | `/api/v1/medicines/lookup` | signed-in | Slim active list for Treatment / Inventory selectors |
| GET | `/api/v1/medicines/meta` | signed-in | Enums, route labels, compatibility matrix |
| GET | `/api/v1/medicines/stats` | signed-in | Catalog counters |
| POST | `/api/v1/medicines/check-duplicate` | admin | Duplicate pre-check (no write) |
| GET | `/api/v1/medicines/:id` | signed-in | Full profile by `_id` or `medicineCode` |
| GET | `/api/v1/medicines/:id/withdrawal-preview` | signed-in | Withdrawal end date for a last dose |
| GET | `/api/v1/medicines/:id/usage` | admin | Reference counts |
| GET | `/api/v1/medicines/:id/audit-logs` | admin | Change history |
| PUT | `/api/v1/medicines/:id` | admin | Update details |
| PATCH | `/api/v1/medicines/:id/toggle-active` | admin | Retire / reactivate |
| DELETE | `/api/v1/medicines/:id` | admin | Soft-retire, or `?hard=true` when unreferenced |

`:id` is a Mongo `_id` or a `medicineCode` (`MED-00001`, case-insensitive).

---

## POST `/api/v1/medicines`

```json
{
  "medicineName": "Oxytetracycline 20% LA Injection",
  "genericName": "Oxytetracycline",
  "brandName": "Renamycin LA",
  "manufacturer": "ACI Animal Health",
  "category": "Antibiotic",
  "dosageForm": "Injection",
  "strength": "200 mg/ml",
  "administrationRoute": "IM",
  "description": "Long-acting broad-spectrum antibiotic.",
  "storageCondition": "Store below 25°C, protect from light",
  "withdrawalPeriodDays": 28,
  "prescriptionRequired": true
}
```

**201** → the created document (`medicineCode` generated, `isActive: true`).

Errors: **400** missing/invalid field, negative withdrawal, bad strength, incompatible route/form;
**409** duplicate product; **403** non-admin.

## GET `/api/v1/medicines`

| Query | Notes |
|---|---|
| `searchTerm` (alias `search`) | matches `medicineName`, `genericName`, `brandName`, `medicineCode`, `manufacturer` (regex-escaped, case-insensitive) |
| `category`, `dosageForm`, `administrationRoute` | single value or comma-separated list |
| `prescriptionRequired` | `true` / `false` |
| `hasWithdrawal` | `true` → `withdrawalPeriodDays > 0`; `false` → `0` |
| `manufacturer` | partial, case-insensitive |
| `isActive` | default `true`; admins may send `false` or `all` (ignored for normal users) |
| `sort` | e.g. `medicineName`, `-createdAt`, `withdrawalPeriodDays` (whitelisted) |
| `page`, `limit` | default 1 / 10, `limit` ≤ 100 |
| `fields` | comma-separated projection |

## GET `/api/v1/medicines/lookup`

Active medicines only, max 200, sorted by name, slim projection (code, name, generic, brand, manufacturer,
category, form, strength, route, storage, withdrawal, prescriptionRequired). Accepts `searchTerm`, `category`,
`dosageForm`, `administrationRoute`, `prescriptionRequired`.

## GET `/api/v1/medicines/meta`

```json
{
  "categories": ["Antibiotic", "..."],
  "dosageForms": ["Injection", "..."],
  "administrationRoutes": [{ "value": "IM", "label": "Intramuscular" }],
  "routeCompatibility": { "Injection": ["IM", "IV", "SC"], "Tablet": ["Oral"] },
  "identityFields": ["genericName", "brandName", "manufacturer", "strength", "dosageForm"],
  "units": { "withdrawalPeriodDays": "days" },
  "limits": { "maxWithdrawalPeriodDays": 3650 },
  "strengthExamples": ["200 mg/ml", "500 mg", "10%", "5 IU/ml"]
}
```

## GET `/api/v1/medicines/stats`

```json
{
  "total": 12, "active": 10, "retired": 2,
  "prescriptionRequired": 6, "withWithdrawal": 7, "antibiotics": 4,
  "byCategory": [{ "category": "Antibiotic", "count": 4 }],
  "byDosageForm": [{ "dosageForm": "Injection", "count": 5 }]
}
```

Counters other than `total`/`active`/`retired` count active medicines only.

## POST `/api/v1/medicines/check-duplicate` (admin)

Body: any of `medicineName`, `genericName`, `brandName`, `manufacturer`, `strength`, `dosageForm`, plus
optional `excludeId` (when editing). Needs at least `manufacturer + strength + dosageForm` to match anything.

```json
{ "isDuplicate": true, "matches": [{ "_id": "...", "medicineCode": "MED-00003", "medicineName": "...", "isActive": true, "matchedOn": "name+strength+form+manufacturer" }] }
```

## GET `/api/v1/medicines/:id`

The full document plus `administrationRouteLabel` (e.g. `Intramuscular`) and `compatibleRoutes` for its form.
Retired medicines are returned too, with `isActive: false`.

## GET `/api/v1/medicines/:id/withdrawal-preview`

`?lastAdministeredDate=YYYY-MM-DD` (default: now). Read-only.

```json
{
  "medicine": { "_id": "...", "medicineCode": "MED-00001", "medicineName": "...", "isActive": true },
  "lastAdministeredDate": "2026-08-17T00:00:00.000Z",
  "withdrawalPeriodDays": 7,
  "withdrawalEndDate": "2026-08-24T00:00:00.000Z",
  "withdrawalActive": true,
  "remainingDays": 4,
  "disclaimer": "Reference calculation only. ..."
}
```

## GET `/api/v1/medicines/:id/usage` (admin)

```json
{ "_id": "...", "medicineCode": "MED-00001", "medicineName": "...",
  "usage": { "treatments": 0, "inventories": 2, "total": 2 },
  "canHardDelete": false, "identityLocked": true }
```

## GET `/api/v1/medicines/:id/audit-logs` (admin)

`?page=&limit=` (default 20). Newest first; `userId` populated with `userId fullName systemRole`.

## PUT `/api/v1/medicines/:id`

Any subset of the writable fields, plus optional `changeReason` (≤ 500, stored on the audit row).
`brandName` / `description` accept `null` or `""` to clear.

- No real change → **200** `"No changes detected."` and no audit row.
- Locked identity field on a referenced medicine → **409**.
- New route/form combination incompatible → **400**.
- New identity equals another product → **409**.

## PATCH `/api/v1/medicines/:id/toggle-active`

Body (optional): `{ "isActive": false, "reason": "Discontinued by manufacturer" }`. Without `isActive` the
current value flips. Reactivating is refused (**409**) when an active duplicate of the same product now exists.

## DELETE `/api/v1/medicines/:id`

- Default: soft-retire (`isActive: false`) → `{ "mode": "retired", "medicine": {...}, "usage": {...} }`
- `?hard=true`: permanently deletes only when `usage.total === 0` → `{ "mode": "deleted", "medicine": null }`;
  otherwise **409** (hard delete is blocked, never silently downgraded).
