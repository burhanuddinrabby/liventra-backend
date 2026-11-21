# Liventra Backend — Feed Records API (Model 09)

Base URL: `http://localhost:5000`

All endpoints require `Authorization: Bearer <accessToken>`. Response envelope and error shape are the
same as every other module (`{ success, message, data, meta? }` / `{ success: false, message, errorSources }`).

A FeedRecord answers **"what was ACTUALLY fed to this animal, in this session, on this day?"**.
It is the reality side of the feed module and the source of the farm's feed consumption and cost.

```text
FeedIngredient → FeedFormula → FeedRecommendation → FeedRecord → Inventory / Analytics
 (what is it?)    (general plan)  (plan for this animal)  (what was actually fed)
```

All routes are farm-scoped: `/api/v1/farms/:farmId/...` where `:farmId` is the farm `_id` or `FARM-00001`.

## Model (new model from DO.md)

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | the record id used in every `:id` route |
| `farmId` / `animalId` | ObjectId | immutable — a feeding logged for the wrong animal is voided and logged again |
| `recommendationId` | ObjectId \| null | optional link to the plan that was followed (ad-hoc feeding = `null`) |
| `feedingSession` | `Morning \| Afternoon \| Evening \| Night` | several sessions per animal per day are normal |
| `feedingDate` | Date | calendar day of the feeding, stored as `YYYY-MM-DDT00:00:00Z`; `createdAt` = when it was logged (backdating allowed) |
| `items[]` | Array | `{ ingredientId, ingredientName, quantity, unit, unitPrice, totalCost }` |
| `items[].ingredientName` | String | **snapshot** taken when the line was first recorded; catalog renames never change it |
| `items[].unitPrice` | Number | **snapshot**, BDT per `unit`; catalog price changes never change it |
| `items[].totalCost` | Number | `quantity × unitPrice`, **server-calculated** |
| `totalFeedQuantity` | Number (kg) | Σ quantity in kg; liters count 1:1, `piece` lines are excluded (a warning says so) |
| `totalCost` | Number (BDT) | Σ `items[].totalCost`, **server-calculated** |
| `remarks` | String | optional, ≤ 1000 chars |
| `fedBy` | ObjectId (FarmMember) | who performed the feeding; defaults to the caller. The person who **logged** it is in AuditLog |
| `isVoided`, `voidedAt`, `voidedBy`, `voidReason` | | set by `DELETE` (records are never hard-deleted) |
| `createdAt` / `updatedAt` | Date | |

Clients may **never** send `totalFeedQuantity`, `totalCost`, `items[].totalCost`, `items[].ingredientName`
or the void fields — bodies are strict and such keys answer **400**.

## Roles (farm role from the active FarmMember row)

| Action | Owner | Manager | Worker | Veterinarian | Accountant |
|---|---|---|---|---|---|
| List / get / animal history / adherence / meta / stats / feeders | ✅ | ✅ | ✅ | ✅ | ✅ |
| Preview + log a feeding | ✅ | ✅ | ✅ | ❌ | ❌ |
| Custom `unitPrice` (≠ catalog/snapshot price) | ✅ | ✅ | ❌ | ❌ | ❌ |
| `allowInsufficientStock` override | ✅ | ✅ | ❌ | ❌ | ❌ |
| Correct (`PUT`) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Void (`DELETE`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Change history, voided records, voided count in stats | ✅ | ✅ | ❌ | ❌ | ❌ |

- Platform `superAdmin` and the farm's owner account are treated as **Owner**; platform `admin` is not.
- Writes need an **Active** farm (`Setup` / `Inactive` / `Suspended` → 403) and a FarmMember row
  (a super admin without one can read but not write).
- An animal or recommendation of another farm is reported as **404** (farm isolation).

## Inventory integration

Inventory (Model 19) and Inventory_Transaction (Model 20) **models** exist (`src/app/modules/inventory`);
the Inventory API itself is not built yet. A feed ingredient is *stocked* when the farm has an
`Inventory` row with `itemType: "Feed"` and `referenceId = ingredientId`.

| Situation | Behaviour |
|---|---|
| Ingredient stocked, enough stock | `currentStock` decreases, one `Consumption` transaction (`referenceType: "FeedRecord"`, `referenceId: <record _id>`) per ingredient, status recomputed (Out of Stock / Low Stock ≤ `reorderLevel` / Available) |
| Stock short | **422** `Insufficient stock for …` — unless an Owner/Manager sends `allowInsufficientStock: true`; then stock is drawn down **to 0, never negative** and a warning is returned |
| Stock row Expired / Inactive / past `expiryDate` | **422** — expired items cannot be used for feeding |
| Ingredient not stocked | allowed; response warning `… is not stocked in this farm's inventory` (nothing deducted) |
| Fed unit not convertible to the stock unit (e.g. kg vs `packet`) | allowed, warning, nothing deducted |

Everything — record write, stock updates, ledger rows — runs in **one MongoDB transaction**; any failure
rolls it all back. On a standalone mongod (no transactions) every step registers an undo step and a
failure is compensated in reverse order. Stock decreases are single conditional updates, so two
feedings racing for the same stock can never oversell it (the loser gets **409**).

The ledger is the source of truth for what a record consumed: corrections and voids read it and move
only the **difference**.

## Endpoints

| Method | Path (under `/api/v1/farms/:farmId`) | Access |
|---|---|---|
| POST | `/feed-records/preview` | Owner / Manager / Worker |
| POST | `/feed-records` | Owner / Manager / Worker |
| GET | `/feed-records` | Farm Member |
| GET | `/feed-records/meta` | Farm Member |
| GET | `/feed-records/stats` | Farm Member |
| GET | `/feed-records/feeders` | Farm Member |
| GET | `/feed-records/adherence/:recommendationId` | Farm Member |
| GET | `/feed-records/:id` | Farm Member |
| GET | `/feed-records/:id/audit-logs` | Owner / Manager |
| PUT | `/feed-records/:id` | Owner / Manager |
| DELETE | `/feed-records/:id` | Owner |
| GET | `/animals/:animalId/feed-records` | Farm Member |

---

### POST `/feed-records` — log a feeding

```json
{
  "animalId": "AN-000125",
  "feedingSession": "Morning",
  "feedingDate": "2026-08-17",
  "recommendationId": "REC-2026-000100",
  "fedBy": "684d9c7b4b89fa2cb4d12353",
  "items": [
    { "ingredientId": "684d...01", "quantity": 10 },
    { "ingredientId": "684d...02", "quantity": 2500, "unit": "g", "unitPrice": 0.068 }
  ],
  "remarks": "Animal consumed only part of the concentrate.",
  "allowInsufficientStock": false,
  "allowDuplicateSession": false
}
```

| Field | Rules |
|---|---|
| `animalId` | required; `_id` or `AN-000001`; must belong to the farm and be `lifeStatus: Active`. Sold / Dead / Transferred / Archived → **409**. Sick / Under Treatment / Quarantine → allowed with a warning |
| `feedingSession` | required enum |
| `feedingDate` | required `YYYY-MM-DD`; not in the future (24 h tolerance), not older than 365 days, not before the birth date |
| `recommendationId` | optional; `_id` or `REC-…`; same farm **and same animal**; status `Confirmed`, `Expert Approved` or `Superseded` (Draft / Rejected → 409) |
| `fedBy` | optional FarmMember `_id`, must be an **active member of this farm**; default = caller |
| `items` | 1–30 lines, each ingredient once; `quantity > 0`; `unit` optional (default = catalog unit) and must be convertible to it (kg↔g, liter↔ml); retired ingredients → 409; unavailable ones → warning |
| `items[].unitPrice` | optional, ≥ 0; default = catalog `pricePerUnit` converted to the line's unit. A different value needs Owner/Manager (403 otherwise) |
| `allowDuplicateSession` | the same animal + day + session is rejected (**422**) unless `true` |

**201** → `data: { feedRecord, stockMovements[], warnings[] }`. `feedRecord` is the detail shape below;
`stockMovements[]` = `{ transactionNo, transactionType, inventoryCode, itemName, quantity, unit, stockBefore, stockAfter }`.

Blocking problems (stock, duplicate, expired stock) → **422** `Feed record cannot be saved: …`.

### POST `/feed-records/preview`

Same body and checks as create, **nothing is written**. Returns the priced draft:
`{ animal, feedingSession, feedingDate, fedBy, recommendation, items[] (+ ingredientCode, category, catalogUnitPrice, priceSource: catalog|snapshot|manual, quantityKg), totalFeedQuantity, totalCost, stock[], warnings[], blockers[], canSave, isPreview: true }`.
`stock[]` per ingredient: `{ ingredientName, tracked, inventoryCode, itemName, inventoryStatus, unit, available, required, delta, expectedAfter, shortfall }`.

### GET `/feed-records` — farm list

Query: `page`, `limit` (≤ 100), `sort` (`feedingDate`, `createdAt`, `totalCost`, `totalFeedQuantity`, `feedingSession`; prefix `-` for desc; default `-feedingDate`),
`animalId` (`_id` / `AN-…`), `feedingSession` (comma list), `recommendationId` (`_id` / `REC-…` / `none` = ad-hoc only),
`fedBy` (FarmMember `_id`), `ingredientId`, `from` / `to` (`YYYY-MM-DD`, inclusive), `searchTerm` (remarks / ingredient name, regex-escaped),
`voided` = `exclude` (default) | `include` | `only` — only Owner/Manager; others always get non-voided rows.

**200** → `meta` + `data: { records[], summary: { records, totalCost, totalFeedQuantity } }` (summary covers the whole filtered set).
Rows populate `animalId { animalCode, name }`, `fedBy { role, userId { userId, fullName } }`, `recommendationId { recommendationNo, status }`.

### GET `/animals/:animalId/feed-records` — animal history

Query: `from` / `to` (default last 30 days, max 366), `feedingSession`, `page`, `limit` (default 20).
**200** → `data: { animal, window, summary { daysFed, records, totalCost, totalFeedQuantity, avgDailyCost, avgDailyFeedQuantity, lastFeeding }, dailySummaries[] { date, records, sessions[], totalFeedQuantity, totalCost, costVariance (vs active plan) }, ingredientTotals[], activeRecommendation, records[] }`.

### GET `/feed-records/:id`

Full record: populated `animalId`, `fedBy`, `voidedBy`, `recommendationId` (with `recommendedItems`, `estimatedDailyCost`)
plus `inventoryTransactions[]` — the stock ledger of this record (`transactionNo`, `transactionType`, `quantity`, `unit`, `unitPrice`, `totalAmount`, `remarks`, `inventoryId { inventoryCode, itemName, unit, currentStock, status }`, `performedBy`).
Voided records stay readable (`isVoided: true`).

### GET `/feed-records/adherence/:recommendationId` — recommended vs actual

`:recommendationId` = `_id` or `REC-…`. Optional `from` / `to`. Uses only non-voided records **linked** to that plan.
A recommendation is a daily plan, so records are added up per day and the **average logged day** is compared:

```json
{
  "recommendation": { "recommendationNo": "REC-2026-000100", "estimatedDailyCost": 280, "recommendedDailyQuantityKg": 15 },
  "period": { "from": "2026-08-15", "to": "2026-08-17", "daysLogged": 3, "records": 6 },
  "summary": { "actualAvgDailyQuantityKg": 12.5, "quantityVarianceKg": -2.5, "quantityAdherencePercent": 83.3,
               "actualAvgDailyCost": 235, "costVariance": -45, "costVariancePercent": -16.07, "status": "Under-fed", "tolerancePercent": 10 },
  "ingredients": [ { "ingredientName": "Napier", "unit": "kg", "recommendedDailyQuantity": 12, "actualAvgDailyQuantity": 10,
                     "varianceQuantity": -2, "variancePercent": -16.67, "status": "Under-fed" } ],
  "extraIngredients": [],
  "daily": [ { "date": "2026-08-17", "sessions": ["Morning", "Evening"], "totalFeedQuantity": 12.5, "totalCost": 235, "costVariance": -45 } ]
}
```

`status`: `On plan` (within ±10 %), `Under-fed`, `Over-fed`, `Not fed`, `No data`. Variance = actual − recommended.

### GET `/feed-records/stats`

Query `from` / `to` (default last 30 days). → `{ window, records, animalsFed, totalCost, totalFeedQuantity, avgDailyCost, linkedToPlan, voided (Owner/Manager only, else null), today { records, animalsFed, totalCost }, bySession { Morning: { records, totalCost }, … }, topIngredients[5], dailyTrend[] }`.

### GET `/feed-records/meta`

`{ feedingSessions, units, permissions, linkableRecommendationStatuses, limits, adherenceTolerancePercent, totalsUnits }`.

### GET `/feed-records/feeders`

Active members selectable as `fedBy`: `{ me: <caller FarmMember _id>, members: [{ _id, role, userId, fullName }] }`.
Only name, code and role are exposed — no phone, NID or salary.

### PUT `/feed-records/:id` — controlled correction (Owner / Manager)

Body: any of `feedingSession`, `feedingDate`, `items`, `remarks` (`null` clears), `fedBy`, `recommendationId` (`null` unlinks),
plus `reason` (stored in the audit log), `allowInsufficientStock`, `allowDuplicateSession`. `animalId` cannot change (400).

- `items`, when sent, replaces the full list. A line for an ingredient already on the record keeps its
  original `ingredientName`, `unit` (if omitted) and `unitPrice` snapshot; only Owner/Manager may send a new price.
- Inventory: per ingredient, `delta = new quantity − quantity this record already consumed (ledger)`.
  `delta > 0` → extra `Consumption`, `delta < 0` → `Return`. Removing a line returns its stock.
- Optimistic lock: if the record changed since it was read → **409**. Voided records → **409**.
- **200** → `{ mode: "updated" | "unchanged", feedRecord, stockMovements[], warnings[] }`.
- AuditLog `Update` / event `FeedRecord Corrected (+ Inventory Reconciled)` with `oldData`, `newData`, `changedFields`.

### DELETE `/feed-records/:id` — void (Owner)

Optional body `{ "reason": "Logged for the wrong animal" }`. In one transaction: marks the record voided,
returns everything it consumed to Inventory (`Return` transactions) and keeps the record as history.
**200** → `{ _id, isVoided: true, voidedAt, stockMovements[], warnings[] }`. Already voided → **409**.
AuditLog `Delete` / event `FeedRecord Voided` with the full `oldData`.

### GET `/feed-records/:id/audit-logs` (Owner / Manager)

Paged audit rows `{ logNo, action, event, oldData, newData, changedFields, status, createdAt, userId { userId, fullName } }`.
IP address and user agent are never returned.

## Error summary

| Status | When |
|---|---|
| 400 | bad id / enum / date / number, client totals sent, unit not convertible, duplicate ingredient line, `animalId` change |
| 403 | not a member, role not allowed, custom price or stock override by Worker, farm not Active |
| 404 | farm / animal / ingredient / recommendation / record not found in this farm |
| 409 | animal not Active, retired ingredient, plan not linkable, voided record, concurrent change / stock taken meanwhile |
| 422 | insufficient or expired stock, duplicate session |

## Not built yet

- Inventory CRUD / purchase API (stock can only be created directly in the DB for now).
- Worker "Assigned" read scope from the final CRUD table: there is no assignment model, so every member reads all farm records.
- Notifications (low stock, deviation) listed in spec §59.
