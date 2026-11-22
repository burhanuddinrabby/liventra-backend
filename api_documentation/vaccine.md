# Liventra Backend — Vaccines API (Model 12)

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

Vaccine is **global master/reference data** (no `farmId`): it describes *what* a vaccine is and its
scheduling rules. The actual animal-level event is `Vaccination` (Model 13, not built yet), which references
`Vaccine._id` through `vaccineId`. `Disease.recommendedVaccineIds` (Model 14, not built yet) and
`Inventory.referenceId` (`itemType: "Vaccine"`) also point here. Vaccines are **retired**
(`isActive: false`) rather than deleted, so those references never break.

**Historical protection:** changing `dosage`, `boosterAfterDays`, `repeatIntervalDays`, route, etc. only
affects *future* scheduling. Completed Vaccination records keep their own `administeredDate` /
`nextDueDate` and are never recalculated. Every change is written to AuditLog.

## Schema note (DO.md vs final schema)

The DO.md "extras" mention `diseaseTarget`, `dosesRequired`, `intervalDays`, `boosterIntervalMonths`. The
**final DB schema** (`.opencode/Business Logics.md`) uses different fields and wins:

| DO.md term | Implemented as |
|---|---|
| `diseaseTarget` | `targetDiseaseIds[]` (Disease ObjectIds). List filter `?diseaseTarget=` is accepted as an alias of `?targetDiseaseId=` |
| `dosesRequired` / `intervalDays` | `boosterRequired` + `boosterAfterDays` (primary → booster) |
| `boosterIntervalMonths` | `repeatIntervalDays` (long-term repeat, in **days**) |
| — | `dosage` + `dosageUnit`, `shortCode`, `category` (final schema) |

## Enums

```text
category:            Viral | Bacterial | Parasitic | Combined
dosageUnit:          ml | mg | tablet | dose
administrationRoute: IM | SC | IV | Oral | Nasal
```

Served by `GET /api/v1/vaccines/meta` (with route labels such as `SC` → `Subcutaneous`).

## Roles

| Action | Who |
|---|---|
| Read (list, lookup, meta, stats, get, schedule-preview) | any signed-in user |
| Create, update, retire/reactivate, delete | platform `admin` / `superAdmin` |
| Usage counts, audit history | `admin` / `superAdmin` |

Farm Owners/Managers/Workers/Veterinarians only *select* vaccines; they can never change dosage, route or
booster rules, because that would alter the vaccination program of every farm on the platform.

## Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `vaccineCode` | String | auto | `VAC-00001`; immutable, system-generated, never accepted from the client |
| `vaccineName` | String | yes | 2–150 chars; inner whitespace collapsed; unique ignoring case |
| `shortCode` | String | yes | 1–20 letters/digits/hyphens, stored **uppercase**, unique (`FMD`) |
| `targetDiseaseIds` | ObjectId[] | no* | each must exist in `diseases` and not be inactive; duplicates removed; max 50 |
| `manufacturer` | String | no | ≤ 150 |
| `category` | Enum | yes | see enums |
| `dosage` | Number | yes | `> 0`, ≤ 10000 (reference dose per animal) |
| `dosageUnit` | Enum | yes | see enums |
| `administrationRoute` | Enum | yes | see enums |
| `minimumAge` | Number | no | **months**, 0–600; used for eligibility warnings |
| `boosterRequired` | Boolean | no | default `false` |
| `boosterAfterDays` | Integer | conditional | 1–3650; **required when `boosterRequired: true`**, automatically cleared when `false` |
| `repeatIntervalDays` | Integer | no | 1–3650 |
| `storageTemperature` | String | yes | ≤ 50, e.g. `2–8°C` |
| `description` | String | no | ≤ 2000 |
| `isMandatory` | Boolean | no | default `false` |
| `isActive` | Boolean | auto | `true` on create; changed only via `/toggle-active` or DELETE |
| `createdAt`, `updatedAt` | Date | auto | |

\* The final schema marks `targetDiseaseIds` required, but the Disease module does not exist yet, so an
empty list is accepted for now. Any id that *is* sent is validated against the raw `diseases` collection.

## Endpoint summary

| Method | Endpoint | Access |
|---|---|---|
| POST | `/api/v1/vaccines` | `admin` / `superAdmin` |
| GET | `/api/v1/vaccines` | Any authenticated user |
| GET | `/api/v1/vaccines/lookup` | Any authenticated user |
| GET | `/api/v1/vaccines/meta` | Any authenticated user |
| GET | `/api/v1/vaccines/stats` | Any authenticated user |
| GET | `/api/v1/vaccines/:id` | Any authenticated user |
| GET | `/api/v1/vaccines/:id/schedule-preview` | Any authenticated user |
| GET | `/api/v1/vaccines/:id/usage` | `admin` / `superAdmin` |
| GET | `/api/v1/vaccines/:id/audit-logs` | `admin` / `superAdmin` |
| PUT | `/api/v1/vaccines/:id` | `admin` / `superAdmin` |
| PATCH | `/api/v1/vaccines/:id/toggle-active` | `admin` / `superAdmin` |
| DELETE | `/api/v1/vaccines/:id` | `admin` / `superAdmin` |

`:id` is either the Mongo `_id` or the `vaccineCode` (case-insensitive, e.g. `vac-00001`).

---

## POST `/api/v1/vaccines`

JSON body (numbers must be JSON numbers):

```json
{
  "vaccineName": "Foot and Mouth Disease Vaccine",
  "shortCode": "FMD",
  "targetDiseaseIds": [],
  "manufacturer": "ACI Animal Health",
  "category": "Viral",
  "dosage": 2,
  "dosageUnit": "ml",
  "administrationRoute": "SC",
  "minimumAge": 4,
  "boosterRequired": true,
  "boosterAfterDays": 30,
  "repeatIntervalDays": 180,
  "storageTemperature": "2–8°C",
  "description": "Trivalent FMD vaccine (O, A, Asia-1).",
  "isMandatory": true
}
```

- `vaccineCode` is generated; `isActive` is always `true` on creation.
- Unknown keys (including `vaccineCode`, `isActive`) are ignored.

`201` → the created vaccine.

Errors: `400` validation (`dosage` ≤ 0, bad enum, `boosterRequired: true` without `boosterAfterDays`,
unknown/inactive disease id), `409` `Vaccine already exists as "…" (VAC-00002)!` (with a hint to reactivate
when the match is retired) or `Short code "FMD" is already used by …`.

Audit: `Create` / `Vaccine Created`.

## GET `/api/v1/vaccines`

Query parameters (all optional):

| Param | Notes |
|---|---|
| `searchTerm` (alias `search`) | partial, case-insensitive match on `vaccineName` / `vaccineCode` / `shortCode` / `manufacturer` |
| `category` | one value or comma-separated list |
| `dosageUnit` | one value or comma-separated list |
| `administrationRoute` | one value or comma-separated list |
| `isMandatory` | `true` / `false` |
| `boosterRequired` | `true` / `false` |
| `targetDiseaseId` (alias `diseaseTarget`) | Disease ObjectId, or comma-separated list; `400` when none is valid |
| `isActive` | default `true`; `false` = retired only; `all` = both |
| `sort` | comma-separated, `-` for desc. Allowed: `vaccineName` (default), `vaccineCode`, `shortCode`, `category`, `manufacturer`, `dosage`, `minimumAge`, `boosterAfterDays`, `repeatIntervalDays`, `isMandatory`, `isActive`, `createdAt`, `updatedAt` |
| `page`, `limit` | default `1` / `10`; `limit` max 100 |
| `fields` | comma-separated projection, e.g. `vaccineName,shortCode` |

`200` → `data: Vaccine[]`, `meta`.

## GET `/api/v1/vaccines/lookup`

Slim list for Vaccination forms and compliance checklists (max 200, sorted by name). Always
`isActive: true` (retired vaccines cannot be selected for new events). Optional `category`,
`isMandatory`, `targetDiseaseId`, `searchTerm`.

Returns `_id`, `vaccineCode`, `vaccineName`, `shortCode`, `category`, `targetDiseaseIds`, `dosage`,
`dosageUnit`, `administrationRoute`, `minimumAge`, `boosterRequired`, `boosterAfterDays`,
`repeatIntervalDays`, `storageTemperature`, `isMandatory`.

## GET `/api/v1/vaccines/meta`

```json
{
  "categories": ["Viral", "Bacterial", "Parasitic", "Combined"],
  "dosageUnits": ["ml", "mg", "tablet", "dose"],
  "administrationRoutes": [ { "value": "IM", "label": "Intramuscular" }, { "value": "SC", "label": "Subcutaneous" } ],
  "units": { "minimumAge": "months", "boosterAfterDays": "days", "repeatIntervalDays": "days" },
  "limits": { "maxDosage": 10000, "maxMinimumAgeMonths": 600, "maxIntervalDays": 3650 }
}
```

## GET `/api/v1/vaccines/stats`

```json
{
  "total": 8, "active": 7, "retired": 1, "mandatory": 4, "withBooster": 3,
  "byCategory": [ { "category": "Viral", "count": 4, "mandatory": 3 } ]
}
```

`mandatory` / `withBooster` / `byCategory` count active vaccines only; `byCategory` lists every category.

## GET `/api/v1/vaccines/:id`

Full document (active or retired) plus:

- `administrationRouteLabel` — e.g. `"Subcutaneous"`
- `targetDiseases` — `[{ _id, diseaseCode, diseaseName, severity, contagious, isActive }]` read from the
  `diseases` collection (empty until the Disease module exists)

`400` empty ref, `404` not found.

## GET `/api/v1/vaccines/:id/schedule-preview`

Read-only calculation used by the Vaccination module and the UI. Query: `administeredDate`
(ISO date, default now), `animalAgeMonths` (optional).

```json
{
  "vaccine": { "_id": "...", "vaccineCode": "VAC-00001", "vaccineName": "FMD Vaccine", "isActive": true },
  "administeredDate": "2026-01-01T00:00:00.000Z",
  "boosterDueDate": "2026-01-31T00:00:00.000Z",
  "repeatDueDate": "2026-07-30T00:00:00.000Z",
  "nextDueDate": "2026-01-31T00:00:00.000Z",
  "ageCheck": { "eligible": false, "minimumAgeMonths": 4, "animalAgeMonths": 2 }
}
```

- `boosterDueDate` = administered + `boosterAfterDays` (only when `boosterRequired`).
- `repeatDueDate` = (booster date, or administered date when there is no booster) + `repeatIntervalDays`.
- `nextDueDate` = booster date if any, else repeat date, else `null`.
- `ageCheck` is `null` unless both `animalAgeMonths` and `minimumAge` are known; it is a warning, not a block.

The same logic is exported as `computeVaccineSchedule()` from `vaccine.utils.ts` for the Vaccination module.

## GET `/api/v1/vaccines/:id/usage` (admin)

```json
{
  "_id": "...", "vaccineCode": "VAC-00001", "vaccineName": "FMD Vaccine",
  "usage": { "vaccinations": 0, "diseases": 0, "inventories": 0, "total": 0 },
  "canHardDelete": true
}
```

Counted by raw collection: `vaccinations.vaccineId`, `diseases.recommendedVaccineIds`,
`inventories.referenceId` (with `itemType: "Vaccine"`). Missing collections count 0.

## GET `/api/v1/vaccines/:id/audit-logs` (admin)

Change history, newest first. `page`, `limit` (default 20, max 100). Same row shape as the other master
catalogs (`logNo`, `action`, `event`, `oldData`, `newData`, `changedFields`, populated `userId`,
`deviceType`, `status`, `createdAt`). IP address and user agent are stored but not returned.

## PUT `/api/v1/vaccines/:id`

Any subset of the create fields. `vaccineCode` and `isActive` cannot be changed here. Send `null` (or `""`)
to clear an optional field (`manufacturer`, `minimumAge`, `boosterAfterDays`, `repeatIntervalDays`,
`description`).

- The booster rule is checked on the **merged** result: setting `boosterRequired: true` on a vaccine without
  `boosterAfterDays` → `400`; setting `boosterRequired: false` clears `boosterAfterDays`.
- Only newly added `targetDiseaseIds` must be active diseases (an already-linked disease that was later
  retired may stay).

`200` → updated vaccine. When a protocol field changed (dosage, unit, route, minimum age, booster, repeat,
storage) the message says `Protocol changes apply to future vaccinations only.` If nothing actually changed,
the current document is returned and no audit row is written. `400` when no updatable field is sent,
`409` name/shortCode conflict.

Audit: `Update` with `oldData` / `newData` / `changedFields`. `event` is the first match of:
`Target Disease Changed`, `Dosage Changed`, `Route Changed`, `Booster Rule Changed`,
`Repeat Interval Changed`, `Mandatory Status Changed`, `Manufacturer Changed`, else `Vaccine Updated`.

## PATCH `/api/v1/vaccines/:id/toggle-active`

```json
{ "isActive": false, "reason": "Product discontinued" }
```

Both optional: without `isActive` the value is flipped. `reason` (≤ 500) is stored in the audit row only.
Retiring hides the vaccine from lists (unless `isActive=false|all`) and from `/lookup`, but keeps the
document so Vaccination / Disease links stay valid.

Audit: `Archive` / `Vaccine Deactivated`, or `Update` / `Vaccine Activated`.

## DELETE `/api/v1/vaccines/:id`

- Default: **soft delete** — same as retiring (`isActive: false`).
  `200` → `{ "mode": "retired", "vaccine": { ... }, "usage": { ... } }`.
- `?hard=true`: permanently deletes, only when `usage.total === 0`.
  `200` → `{ "mode": "deleted", "vaccine": null, "usage": { ... } }`;
  `409` when referenced by any Vaccination, Disease or Inventory document.

Audit: `Archive` (soft) or `Delete` / `Vaccine Deleted` with the full `oldData` snapshot (hard).
