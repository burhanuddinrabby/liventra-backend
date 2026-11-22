# Liventra Backend — Diseases API (Model 14)

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

Disease is **global master/reference data** (no `farmId`): it describes *what* a disease is: its symptoms,
causes, prevention and recommended vaccines. It never stores which animals are affected. Animal-level
events reference it: `Treatment.diseaseId` (Model 16, not built yet) and `Vaccine.targetDiseaseIds[]`.
Diseases are **deactivated** (`isActive: false`) rather than deleted, so those references never break.

**Clinical safety:** symptoms are reference information. `GET /search-by-symptoms` ranks diseases by
symptom overlap as a lookup aid. It is **never a diagnosis**, and every response carries a disclaimer.

## Schema note (old model → final schema)

Implemented from the **final DB schema** (`.opencode/Business Logics.md`), which adds `causes[]`,
`severity` and `contagious` to the older Model 14 spec. `diseaseCode` uses the final-schema format
`DIS-00001` (not `DIS-FMD-001` / `DIS-001`).

## Enums

```text
category: Viral | Bacterial | Parasitic | Metabolic | Nutritional | Reproductive | Other
severity: Low | Medium | High | Critical
```

Served by `GET /api/v1/diseases/meta`.

## Roles

| Action | Who |
|---|---|
| Read: list (active), lookup, meta, stats, search-by-symptoms, get, recommended-vaccines | any signed-in user |
| List inactive diseases (`?isActive=false\|all`) | `admin` / `superAdmin` (others always get active rows) |
| Create, update, link vaccines, deactivate/reactivate, delete | platform `admin` / `superAdmin` |
| check-name, usage counts, audit history | `admin` / `superAdmin` |

This follows the final schema's CRUD matrix: Admin creates/reads/updates/disables, while Owner and Manager
(and other farm roles) are read-only. A deactivated disease stays readable **by id/code** for everyone,
so old treatment records still resolve.

## Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `diseaseCode` | String | auto | `DIS-00001`; immutable, system-generated, never accepted from the client |
| `diseaseName` | String | yes | 2–150 chars; whitespace collapsed; unique ignoring case **and** normalized (see duplicates) |
| `category` | Enum | yes | see enums |
| `symptoms` | String[] | yes (≥ 1) | each a non-empty string ≤ 150; trimmed; case-insensitive duplicates removed; max 50 |
| `causes` | String[] | no | same rules as symptoms; default `[]` |
| `prevention` | String | no | ≤ 2000; `null`/`""` clears on PUT |
| `severity` | Enum | yes | see enums |
| `contagious` | Boolean | no | default `false` (Treatment module will raise a health warning when `true`) |
| `recommendedVaccineIds` | ObjectId[] | no | each must exist in `vaccines`; **newly added** ones must be active; duplicates removed; max 50 |
| `description` | String | no | ≤ 5000; `null`/`""` clears on PUT |
| `isActive` | Boolean | auto | `true` on create; only changed via toggle-active / DELETE |
| `createdAt` / `updatedAt` | Date | auto | |

Unknown body keys are ignored (service-layer whitelist).

### Duplicate-name detection

Names are compared on a normalized key (lower-case, `&` = `and`, punctuation and extra spaces removed):

| Existing | New | Result |
|---|---|---|
| `Foot and Mouth Disease` | `foot & mouth-disease` | **409** always (exact normalized match) |
| `Foot and Mouth Disease` | `Foot and Mouth` / `FMD` (initials) | **409** unless the body has `"confirmDuplicate": true` |

The 409 message names the existing disease and code. If the existing one is deactivated, the message says
to reactivate it instead.

### Disease ↔ Vaccine sync

`recommendedVaccineIds` (Disease) and `targetDiseaseIds` (Vaccine) are kept consistent by the service. When
a vaccine is linked to or unlinked from a disease (create, PUT, PATCH recommended-vaccines), the disease id is
`$addToSet`/`$pull`ed on that vaccine in the **same atomic unit**: a transaction on a replica set, or
undo-compensation on a standalone mongod. Each affected vaccine gets a `Target Disease Changed` audit row.
To skip the vaccine side, send `"syncVaccineTargets": false`.

Removing a recommendation only changes current guidance. Historical Vaccination records are never touched.

## Endpoint summary

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/api/v1/diseases` | admin | create master disease |
| GET | `/api/v1/diseases` | signed-in | paginated list + filters |
| GET | `/api/v1/diseases/lookup` | signed-in | slim active list for selectors |
| GET | `/api/v1/diseases/meta` | signed-in | enums, limits, disclaimer |
| GET | `/api/v1/diseases/stats` | signed-in | catalog counts |
| GET | `/api/v1/diseases/search-by-symptoms` | signed-in | reference ranking by symptom overlap |
| GET | `/api/v1/diseases/check-name` | admin | duplicate-name pre-check for forms |
| GET | `/api/v1/diseases/:id` | signed-in | full detail + recommended vaccines |
| GET | `/api/v1/diseases/:id/recommended-vaccines` | signed-in | prevention view |
| GET | `/api/v1/diseases/:id/usage` | admin | reference counts |
| GET | `/api/v1/diseases/:id/audit-logs` | admin | change history |
| PUT | `/api/v1/diseases/:id` | admin | update master guidance |
| PATCH | `/api/v1/diseases/:id/recommended-vaccines` | admin | add/remove vaccine links |
| PATCH | `/api/v1/diseases/:id/toggle-active` | admin | deactivate/reactivate |
| DELETE | `/api/v1/diseases/:id` | admin | soft delete; `?hard=true` only if unreferenced |

`:id` accepts a Mongo `_id` or a `diseaseCode` (`DIS-00001`, case-insensitive).

---

## POST `/api/v1/diseases`

```json
{
  "diseaseName": "Foot and Mouth Disease",
  "category": "Viral",
  "symptoms": ["High Fever", "Mouth Ulcer", "Excessive Salivation", "Lameness"],
  "causes": ["Virus", "Direct Contact", "Contaminated Feed"],
  "prevention": "Regular vaccination and proper farm biosecurity.",
  "severity": "High",
  "contagious": true,
  "recommendedVaccineIds": ["665f0c1e2a9b3c0012ab34cd"],
  "description": "A highly contagious viral disease of cloven-hoofed animals.",
  "confirmDuplicate": false,
  "syncVaccineTargets": true
}
```

**201** → the created disease document. Errors: `400` validation / unknown or retired vaccine id, `409`
duplicate name, `403` non-admin.

## GET `/api/v1/diseases`

Query parameters:

| Param | Notes |
|---|---|
| `category`, `severity` | single or comma-separated (`Viral,Bacterial`); unknown values ignored |
| `contagious` | `true` / `false` |
| `symptom` | diseases with a symptom containing the text (case-insensitive) |
| `recommendedVaccineId` (alias `vaccineId`) | one or more Vaccine ObjectIds, comma-separated |
| `isActive` | default `true`; `false` / `all` honoured for admins only |
| `searchTerm` (alias `search`) | name, code, symptoms, causes (regex-escaped, ≤ 100 chars) |
| `sort` | `diseaseName` (default), `diseaseCode`, `category`, `severity`, `contagious`, `isActive`, `createdAt`, `updatedAt`; prefix `-` for desc |
| `page`, `limit` | limit 1–100, default 10 |
| `fields` | comma-separated projection |

## GET `/api/v1/diseases/lookup`

Active diseases only, max 200, sorted by name: `_id diseaseCode diseaseName category severity contagious`.
Filters: `category`, `severity`, `contagious`, `recommendedVaccineId`, `searchTerm` (name/code).

## GET `/api/v1/diseases/meta`

```json
{
  "categories": ["Viral", "Bacterial", "Parasitic", "Metabolic", "Nutritional", "Reproductive", "Other"],
  "severities": ["Low", "Medium", "High", "Critical"],
  "limits": { "maxNameLength": 150, "maxListItems": 50, "maxListItemLength": 150, "maxPreventionLength": 2000, "maxDescriptionLength": 5000, "maxRecommendedVaccines": 50, "maxSymptomQuery": 20 },
  "symptomSearchDisclaimer": "Reference lookup only — ..."
}
```

## GET `/api/v1/diseases/stats`

```json
{
  "total": 12, "active": 11, "inactive": 1, "contagious": 6,
  "withRecommendedVaccines": 7, "withoutRecommendedVaccines": 4,
  "byCategory": [ { "category": "Viral", "count": 4, "contagious": 4 } ],
  "bySeverity": [ { "severity": "Low", "count": 1 } ]
}
```

Every enum value is present (zero counts included). Breakdowns count active diseases only.

## GET `/api/v1/diseases/search-by-symptoms?symptoms=Fever,Salivation`

Also accepts repeated `?symptoms=Fever&symptoms=Salivation` (alias `symptom`). Max 20 symptoms; optional
`category`, `limit` (1–50, default 10). Only active diseases are searched. A query symptom matches a disease
symptom when either text contains the other (`fever` ↔ `High Fever`).

```json
{
  "disclaimer": "Reference lookup only — symptoms overlap across diseases. This is not a diagnosis; confirm with a veterinarian.",
  "querySymptoms": ["Fever", "Salivation"],
  "totalMatches": 3,
  "results": [
    {
      "_id": "...", "diseaseCode": "DIS-00001", "diseaseName": "Foot and Mouth Disease",
      "category": "Viral", "severity": "High", "contagious": true, "recommendedVaccineCount": 1,
      "matchedSymptoms": ["Fever", "Salivation"],
      "matchedDiseaseSymptoms": ["High Fever", "Excessive Salivation"],
      "unmatchedQuerySymptoms": [],
      "matchCount": 2, "queryCoverage": 1, "diseaseCoverage": 0.5
    }
  ]
}
```

Ranking: `matchCount` desc → `diseaseCoverage` desc → severity (Critical first) → name.

## GET `/api/v1/diseases/check-name?diseaseName=FMD&excludeId=<id>` (admin)

```json
{ "diseaseName": "FMD", "available": true, "requiresConfirmation": true,
  "matches": [ { "_id": "...", "diseaseCode": "DIS-00001", "diseaseName": "Foot and Mouth Disease", "isActive": true, "match": "similar" } ] }
```

`available: false` means an exact normalized duplicate exists. `requiresConfirmation: true` means POST/PUT
needs `confirmDuplicate: true`. Pass `excludeId` when editing.

## GET `/api/v1/diseases/:id`

The full disease, plus:

- `recommendedVaccines`: **active** vaccines from `recommendedVaccineIds` (`vaccineCode vaccineName shortCode category dosage dosageUnit administrationRoute minimumAge boosterRequired boosterAfterDays repeatIntervalDays isMandatory isActive`)
- `retiredRecommendedVaccineCount`: linked vaccines that are retired
- `inactiveRecommendedVaccines`: admins only, the retired linked vaccines

## GET `/api/v1/diseases/:id/recommended-vaccines`

```json
{ "disease": { "_id": "...", "diseaseCode": "DIS-00001", "diseaseName": "...", "isActive": true, "prevention": "..." },
  "vaccines": [ { "vaccineCode": "VAC-00001", "...": "..." } ],
  "inactiveVaccines": [] }
```

`inactiveVaccines` is returned to admins only.

## GET `/api/v1/diseases/:id/usage` (admin)

```json
{ "_id": "...", "diseaseCode": "DIS-00001", "diseaseName": "...", "isActive": true,
  "usage": { "treatments": 0, "vaccines": 2, "total": 2 }, "canHardDelete": false }
```

`treatments` reads the raw `treatments` collection (`diseaseId` or `diseaseIds`), so it is `0` until the
Treatment module exists.

## GET `/api/v1/diseases/:id/audit-logs` (admin)

Paginated (`page`, `limit` ≤ 100, default 20), newest first. Events: `Disease Created`, `Disease Updated`,
`Disease Renamed`, `Category Changed`, `Symptoms Changed`, `Causes Changed`, `Prevention Changed`,
`Severity Changed`, `Recommended Vaccine Changed`, `Disease Activated`, `Disease Deactivated`,
`Disease Deleted`. Rows carry `oldData`, `newData` and `changedFields`. Actor is populated as
`userId fullName systemRole` (IP and user agent are not exposed).

## PUT `/api/v1/diseases/:id`

Send any subset of the writable fields. `null` or `""` clears `prevention` / `description`. Arrays
**replace** the stored list (after trim + de-dupe). `confirmDuplicate` and `syncVaccineTargets` work as
on POST. Fields that did not actually change are ignored. If nothing changed, the response is
`"No changes detected."` and no audit row is written. Clinical changes return
`"Disease updated! Changes apply to future health records only."`.

## PATCH `/api/v1/diseases/:id/recommended-vaccines`

```json
{ "add": ["<vaccineId>"], "remove": ["<vaccineId>"], "syncVaccineTargets": true }
```

`$addToSet` / `$pull` semantics: at least one id is required, the same id cannot be in both lists, and
added vaccines must exist and be active. Removing an id that is not linked is a no-op. Returns the updated
disease. The message reports `n added, m removed`.

## PATCH `/api/v1/diseases/:id/toggle-active`

```json
{ "isActive": false, "reason": "Merged into DIS-00004" }
```

Omitting `isActive` flips the current value. A deactivated disease disappears from `/lookup`, from default
lists and from symptom search, but stays readable by id/code.

## DELETE `/api/v1/diseases/:id`

- Default: **soft delete** (`isActive: false`) → `{ "mode": "deactivated", "hardDeleteBlocked": false, "disease": { }, "usage": { } }`
- `?hard=true` on an **unreferenced** disease → permanently removed: `{ "mode": "deleted", "disease": null, ... }`
- `?hard=true` on a disease referenced by any Treatment or `Vaccine.targetDiseaseIds` → hard delete is
  **blocked**, and the disease is deactivated instead: `{ "mode": "deactivated", "hardDeleteBlocked": true, ... }`
