# Liventra Backend — Feed Ingredients API (Model 06)

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

FeedIngredient is **global master/reference data** (no `farmId`). It is referenced by
`FeedFormula.ingredients[].ingredientId`, `FeedRecommendation.recommendedItems[].ingredientId`,
`FeedRecord.items[].ingredientId` and `Inventory.referenceId`. Ingredients are **retired**
(`isActive: false`) rather than deleted, so historical formulas, recommendations and feeding logs never
lose their reference.

**Historical protection:** changing `pricePerUnit` or nutrition values only affects *future* formula cost
estimates and recommendations. `FeedRecommendation` (`estimatedCost`, `recommendedItems`) and `FeedRecord`
(`unitPrice`, `totalCost`) keep their own snapshots and are never recalculated.

## Enums

Values follow the final DB schema (`.opencode/Business Logics.md`), which drops `ton`/`bag`:

```text
unit:     kg | g | liter | ml | piece
category: Roughage | Concentrate | Protein Supplement | Mineral | Vitamin | Additive
```

Served by `GET /api/v1/feed-ingredients/meta` together with the nutrition units, so the frontend does not
need to hardcode them.

## Roles

| Action | Who |
|---|---|
| Read (list, lookup, meta, stats, get) | any signed-in user |
| Create, update, retire/reactivate, delete | platform `admin` / `superAdmin` |
| Toggle availability | `admin` / `superAdmin`, **or** a user with an active `Owner` / `Manager` membership in at least one farm |
| Usage counts, audit history | `admin` / `superAdmin` |

Ingredients are not farm-scoped, so "Manager" means "manages at least one farm". Nutrition data is
centrally controlled on purpose: arbitrary edits would make feed recommendations inconsistent.

## Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `ingredientCode` | String | auto | `ING-00001`; immutable, system-generated, never accepted from the client |
| `ingredientName` | String | yes | 2–100 chars; inner whitespace collapsed. Unique ignoring case, spaces and punctuation (`RiceBran` = `rice bran` = `Rice-Bran`) |
| `unit` | Enum | yes | see enums |
| `category` | Enum | yes | see enums |
| `dryMatterPercentage` | Number | yes | 0–100 (%) |
| `crudeProtein` | Number | yes | 0–100 (%) |
| `crudeFiber` | Number | yes | 0–100 (%) |
| `energy` | Number | yes | ≥ 0, Mcal/kg |
| `calcium` | Number | no | 0–100 (%) |
| `phosphorus` | Number | no | 0–100 (%) |
| `pricePerUnit` | Number | yes | ≥ 0, BDT per `unit` (current/reference price) |
| `availability` | Number | no | ≥ 0, reference quantity available — **not** a stock ledger (Inventory owns farm stock) |
| `supplierId` | ObjectId | no | Supplier collection not finalized yet; only the id format is validated |
| `description` | String | no | ≤ 2000 chars |
| `isAvailable` | Boolean | auto | default `true`; temporary market/stock availability |
| `isActive` | Boolean | auto | default `true`; `false` = retired from the catalog |
| `createdAt` / `updatedAt` | Date | auto | |

`isActive` vs `isAvailable`: an ingredient that is temporarily out of market stays `isActive: true,
isAvailable: false`; a permanently removed one is `isActive: false`. New formulas must only use
`isActive && isAvailable` ingredients; the recommendation engine should warn on unavailable ones.

---

## Endpoint summary

| Method | Endpoint | Access |
|---|---|---|
| POST | `/api/v1/feed-ingredients` | `admin` / `superAdmin` |
| GET | `/api/v1/feed-ingredients` | Any authenticated user |
| GET | `/api/v1/feed-ingredients/lookup` | Any authenticated user |
| GET | `/api/v1/feed-ingredients/meta` | Any authenticated user |
| GET | `/api/v1/feed-ingredients/stats` | Any authenticated user |
| GET | `/api/v1/feed-ingredients/:id` | Any authenticated user |
| GET | `/api/v1/feed-ingredients/:id/usage` | `admin` / `superAdmin` |
| GET | `/api/v1/feed-ingredients/:id/audit-logs` | `admin` / `superAdmin` |
| PUT | `/api/v1/feed-ingredients/:id` | `admin` / `superAdmin` |
| PATCH | `/api/v1/feed-ingredients/:id/availability` | `admin` / `superAdmin` / farm Owner·Manager |
| PATCH | `/api/v1/feed-ingredients/:id/toggle-active` | `admin` / `superAdmin` |
| DELETE | `/api/v1/feed-ingredients/:id` | `admin` / `superAdmin` |

`:id` is either the Mongo `_id` or the `ingredientCode` (case-insensitive, e.g. `ing-00001`).

---

## POST `/api/v1/feed-ingredients`

JSON body (numbers must be JSON numbers):

```json
{
  "ingredientName": "Napier Grass",
  "unit": "kg",
  "category": "Roughage",
  "dryMatterPercentage": 22,
  "crudeProtein": 9.5,
  "crudeFiber": 30,
  "energy": 2.1,
  "calcium": 0.45,
  "phosphorus": 0.28,
  "pricePerUnit": 5,
  "availability": 500,
  "supplierId": "665f1c2e8b3a4d0012345678",
  "description": "High-fiber roughage commonly used as a major forage component.",
  "isAvailable": true
}
```

- `ingredientCode` is generated; `isActive` is always `true` on creation; `isAvailable` defaults to `true`.
- Unknown keys are ignored.

`201` → the created ingredient.

Errors: `400` validation (negative values, percentages > 100, bad enum, bad `supplierId`), `409`
`Ingredient already exists as "Rice Bran" (ING-00002)!` (with a hint to reactivate when the match is retired).

Audit: `Create` / `Ingredient Created`.

## GET `/api/v1/feed-ingredients`

Query parameters (all optional):

| Param | Notes |
|---|---|
| `searchTerm` | partial, case-insensitive match on `ingredientName` / `ingredientCode` |
| `category` | one value or comma-separated list |
| `unit` | one value or comma-separated list |
| `isAvailable` | `true` / `false` |
| `isActive` | default `true`; `false` = retired only; `all` = both |
| `supplierId` | ObjectId |
| `minPrice`, `maxPrice` | `pricePerUnit` range |
| `sort` | comma-separated, `-` for desc. Allowed: `ingredientName` (default), `ingredientCode`, `category`, `unit`, `pricePerUnit`, `dryMatterPercentage`, `crudeProtein`, `crudeFiber`, `energy`, `availability`, `isAvailable`, `isActive`, `createdAt`, `updatedAt` |
| `page`, `limit` | default `1` / `10`; `limit` max 100 |
| `fields` | comma-separated projection, e.g. `ingredientName,pricePerUnit` |

`200` → `data: FeedIngredient[]`, `meta`.

## GET `/api/v1/feed-ingredients/lookup`

Slim list for formula builders and cost estimators (max 200, sorted by name). Returns `_id`,
`ingredientCode`, `ingredientName`, `category`, `unit`, `pricePerUnit`, all nutrition values,
`isAvailable`, `isActive`.

- Always `isActive: true`.
- Unavailable ingredients are excluded unless `includeUnavailable=true` (so a UI can show them disabled
  with a warning).
- Optional `category` (comma-separated) and `searchTerm`.

## GET `/api/v1/feed-ingredients/meta`

```json
{
  "units": ["kg", "g", "liter", "ml", "piece"],
  "categories": ["Roughage", "Concentrate", "Protein Supplement", "Mineral", "Vitamin", "Additive"],
  "nutritionUnits": { "dryMatterPercentage": "%", "crudeProtein": "%", "crudeFiber": "%", "energy": "Mcal/kg", "calcium": "%", "phosphorus": "%" },
  "currency": "BDT"
}
```

## GET `/api/v1/feed-ingredients/stats`

```json
{
  "total": 12, "active": 11, "retired": 1, "available": 9, "unavailable": 2,
  "byCategory": [ { "category": "Roughage", "count": 4, "avgPricePerUnit": 6.5 } ]
}
```

`available` / `unavailable` count active ingredients only; `byCategory` lists every category (count 0
included) for active ingredients.

## GET `/api/v1/feed-ingredients/:id`

Full document (active or retired). `400` empty ref, `404` not found.

## GET `/api/v1/feed-ingredients/:id/usage` (admin)

```json
{
  "_id": "...", "ingredientCode": "ING-00001", "ingredientName": "Napier Grass",
  "usage": { "feedFormulas": 0, "feedRecommendations": 0, "feedRecords": 0, "inventories": 0, "total": 0 },
  "canHardDelete": true
}
```

The FeedFormula / FeedRecommendation / FeedRecord / Inventory modules are not built yet; their collections
are counted by raw name (`feedformulas.ingredients.ingredientId`, `feedrecommendations.recommendedItems.ingredientId`,
`feedrecords.items.ingredientId`, `inventories.referenceId`), so the counts are 0 until those modules exist.

## GET `/api/v1/feed-ingredients/:id/audit-logs` (admin)

Change history, newest first. `page`, `limit` (default 20, max 100). Each row: `logNo` (`LOG-000001`),
`action`, `event`, `oldData`, `newData`, `changedFields`, `userId` (populated `userId`, `fullName`,
`systemRole`), `deviceType`, `status`, `createdAt`. IP address and user agent are stored but not returned.

## PUT `/api/v1/feed-ingredients/:id`

Any subset of the create fields **except** `isAvailable` (use `/availability`) and `isActive` (use
`/toggle-active`). `ingredientCode` cannot change. Send `null` (or `""`) to clear an optional field
(`calcium`, `phosphorus`, `availability`, `supplierId`, `description`).

`200` → updated ingredient. If nothing actually changed, the current document is returned and no audit row
is written. `400` when no updatable field is sent, `409` name conflict.

Audit: `Update` with `oldData` / `newData` / `changedFields` for the changed fields only. `event` is
`Ingredient Price Changed` (when `pricePerUnit` changed), else `Ingredient Nutrition Changed`, else
`Supplier Changed`, else `Ingredient Updated`.

## PATCH `/api/v1/feed-ingredients/:id/availability`

```json
{ "isAvailable": false, "reason": "Out of market after flood" }
```

Both fields optional: without `isAvailable` the current value is flipped. `reason` (≤ 500) is stored in
the audit row only.

- `403` when the caller is neither a platform admin nor an active farm Owner/Manager.
- `409` when the ingredient is retired (reactivate it first).

Audit: `Update` / `Ingredient Availability Changed`.

## PATCH `/api/v1/feed-ingredients/:id/toggle-active`

```json
{ "isActive": false, "reason": "Replaced by ING-00007" }
```

Both optional: without `isActive` the value is flipped. Retiring hides the ingredient from lists (unless
`isActive=false|all`) and from `/lookup`, but keeps the document. Reactivating fails with `409` if another
active/retired ingredient now uses a variant of the same name.

Audit: `Archive` / `Ingredient Deactivated`, or `Update` / `Ingredient Activated`.

## DELETE `/api/v1/feed-ingredients/:id`

- Default: **soft delete** — same as retiring (`isActive: false`).
  `200` → `{ "mode": "retired", "ingredient": { ... }, "usage": { ... } }`.
- `?hard=true`: permanently deletes, only when `usage.total === 0`.
  `200` → `{ "mode": "deleted", "ingredient": null, "usage": { ... } }`;
  `409` when referenced by any formula, recommendation, feed record or inventory item.

Audit: `Archive` (soft) or `Delete` / `Ingredient Deleted` with the full `oldData` snapshot (hard).

---

## AuditLog (Model 24, minimal)

This module introduced `src/app/modules/auditLog/` (model + `recordAuditLog()` helper; no routes yet).
Rows are immutable; `logNo` uses an atomic counter (`auditcounters` collection). Audit writes are
best-effort: the business change is already saved, so a failed audit insert is logged to the console
rather than failing the request. `FeedIngredient` and `Breed` were added to the Model 24 `entityType` list.
