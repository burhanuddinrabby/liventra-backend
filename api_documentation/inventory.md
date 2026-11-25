# Liventra Backend — Inventory & Inventory_Transaction API (Models 19 + 20)

Base URL: `http://localhost:5000`

All endpoints require `Authorization: Bearer <accessToken>`. Response envelope and error shape are the
same as every other module (`{ success, message, data, meta? }` / `{ success: false, message, errorSources }`).

**Inventory** answers *"what does this farm keep in stock, how much is on hand right now, where is it
stored, and is it still usable?"* — the **current state**.
**Inventory_Transaction** answers *"why did that number change?"* — the **append-only movement history**.

```text
Inventory (currentStock) ← changed ONLY by → Inventory_Transaction (Purchase / Consumption / … )
                                                        ↑
                      FeedRecord · Treatment · Vaccination · manual farm actions
```

`currentStock` can never be written directly — not on create (it writes an opening transaction), not on
`PUT`, not by any other module. Every change goes through a transaction, and the reconciliation rule
`sum(inflows) − sum(outflows) === currentStock` therefore always holds.

All routes are farm-scoped: `/api/v1/farms/:farmId/...` where `:farmId` is the farm `_id` or `FARM-00001`.
`:id` accepts the item `_id` or its `inventoryCode` (`INV-2026-000001`); on the transaction routes it
accepts the `_id` or the `transactionNo` (`TRX-2026-000001`).

## Model — Inventory (final DB schema)

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `inventoryCode` | String | `INV-YYYY-NNNNNN`, server-generated (atomic per-year counter), immutable |
| `farmId` | ObjectId | immutable, farm isolation |
| `itemName` | String | ≤ 120 chars; defaults to the linked master record's name |
| `itemType` | `Feed \| Medicine \| Vaccine \| Equipment \| Cleaning Supply \| Other` | required |
| `referenceId` | ObjectId \| null | polymorphic: Feed → FeedIngredient, Medicine → Medicine, Vaccine → Vaccine; **required** for those three, **refused** for the rest |
| `category` | String | free text (≤ 60); suggestions per itemType come from `GET /inventory/meta` |
| `currentStock` | Number | **never** written directly — only through Inventory_Transaction |
| `unit` | `kg \| g \| liter \| ml \| piece \| packet \| box \| bottle` | required; locked once the item has movements |
| `minimumStock` / `reorderLevel` / `maximumStock` | Number | the threshold ladder: `minimum ≤ reorder ≤ maximum` |
| `averagePurchasePrice` | Number | system-maintained weighted average; Owner-only manual correction (needs `reason`) |
| `supplierName` / `storageLocation` | String | optional |
| `expiryDate` | Date \| null | calendar day; a past date makes the item `Expired` |
| `status` | `Available \| Low Stock \| Out of Stock \| Expired \| Inactive` | server-derived, never sent by the client |
| `remarks` | String | ≤ 1000 chars |
| `createdBy` / `updatedBy` | ObjectId → FarmMember | who registered / last touched the item |

### Status is derived, never invented by the UI

One priority rule, used by every endpoint (and by the aggregation behind the list filters):

```text
Inactive  →  Expired (expiryDate < now)  →  Out of Stock (stock ≤ 0)
          →  Low Stock (stock ≤ max(reorderLevel, minimumStock))  →  Available
```

Reads always return the freshly derived value as `derivedStatus` next to the stored `status`.
Until the daily `inventory.sync` job runs, an item that expired overnight keeps a stale **stored** status until
something writes to it — `POST /inventory/sync-statuses` brings the stored values in line.

## Model — Inventory_Transaction (final DB schema)

| Field | Type | Notes |
|---|---|---|
| `transactionNo` | String | `TRX-YYYY-NNNNNN`, server-generated (atomic per-year counter), immutable |
| `farmId` / `inventoryId` | ObjectId | immutable |
| `transactionType` | `Purchase \| Consumption \| Vaccination Usage \| Treatment Usage \| Damage \| Expired \| Adjustment \| Return` | immutable |
| `transactionDate` | Date | the **business** date (backdating allowed up to 365 days, no future dates); `createdAt` keeps the system time |
| `quantity` | Number | **always positive** — the sign comes from the direction |
| `direction` | `In \| Out` | resolved stock direction (see below) |
| `unit` | enum | always equals the item's unit — the system never converts units |
| `unitPrice` / `totalAmount` | Number | required for `Purchase`; `totalAmount = quantity × unitPrice` is verified |
| `referenceType` | `FeedRecord \| Treatment \| Vaccination \| Expense \| Manual \| Purchase` | why the movement happened |
| `referenceId` | ObjectId \| null | the source document |
| `supplierName` / `remarks` | String | `remarks` is **required** for Damage / Expired / Adjustment |
| `performedBy` | ObjectId → FarmMember | who moved the stock |

Every field is immutable and there is **no update or delete path**. A mistake is corrected with an
offsetting row (`POST /inventory-transactions/:id/reverse`).

### Direction

The final schema has no `transactionDirection` field, so direction is derived from `transactionType`:

| Type | Direction |
|---|---|
| Purchase | In |
| Consumption / Vaccination Usage / Treatment Usage / Damage / Expired | Out |
| Return | In by default (stock coming back), `Out` when goods go back to the supplier |
| Adjustment | caller states `direction`, or sends `physicalCount` and the server works it out |

`Adjustment` / `Return` rows written through this module also **store** the resolved direction, so the
ledger stays auditable. Rows written earlier (and by FeedRecord / Treatment / Vaccination) carry no
stored direction and fall back to the table above.

## Permissions (farm role)

| Action | Owner | Manager | Veterinarian | Worker | Accountant |
|---|---|---|---|---|---|
| Read list / detail / ledger / dashboard / alerts / meta / lookup | ✅ | ✅ | ✅ | ✅ | ✅ |
| Register an item (`POST /inventory`) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Update metadata (`PUT`), toggle active, sync statuses | ✅ | ✅ | ❌ | ❌ | ❌ |
| Correct `averagePurchasePrice` | ✅ | ❌ | ❌ | ❌ | ❌ |
| Delete / archive an item (`DELETE`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Change history (`GET /:id/audit-logs`) | ✅ | ✅ | ❌ | ❌ | ✅ |
| Record **Purchase** / **Return** | ✅ | ✅ | ❌ | ❌ | ✅ |
| Record **Consumption** | ✅ | ✅ | ✅ | ✅ | ❌ |
| Record **Damage** / **Expired** / **Adjustment** | ✅ | ✅ | ❌ | ❌ | ❌ |
| Reverse a transaction | ✅ | ✅ | ❌ | ❌ | ❌ |
| Delete a transaction | ✅ (always 403) | ❌ | ❌ | ❌ | ❌ |

Platform `superAdmin` and the farm's owner account act as Owner; platform `admin` has no bypass. Writes
need an **Active** farm (Setup / Inactive / Suspended → 403) and an active FarmMember row (movements are
signed by `performedBy`).

`Vaccination Usage` and `Treatment Usage` can never be posted here — they are written by the vaccination
and treatment workflows so a usage row always points at a real clinical record.

---

## Endpoints

| Method | Path | Who |
|---|---|---|
| POST | `/api/v1/farms/:farmId/inventory` | Owner / Manager |
| GET | `/api/v1/farms/:farmId/inventory` | Farm member |
| GET | `/api/v1/farms/:farmId/inventory/meta` | Farm member |
| GET | `/api/v1/farms/:farmId/inventory/lookup` | Farm member |
| GET | `/api/v1/farms/:farmId/inventory/master-options` | Farm member |
| GET | `/api/v1/farms/:farmId/inventory/dashboard-summary` | Farm member |
| GET | `/api/v1/farms/:farmId/inventory/alerts` | Farm member |
| POST | `/api/v1/farms/:farmId/inventory/sync-statuses` | Owner / Manager |
| GET | `/api/v1/farms/:farmId/inventory/:id` | Farm member |
| GET | `/api/v1/farms/:farmId/inventory/:id/ledger` | Farm member |
| GET | `/api/v1/farms/:farmId/inventory/:id/audit-logs` | Owner / Manager / Accountant |
| PUT | `/api/v1/farms/:farmId/inventory/:id` | Owner / Manager |
| PATCH | `/api/v1/farms/:farmId/inventory/:id/toggle-active` | Owner / Manager |
| DELETE | `/api/v1/farms/:farmId/inventory/:id` | Owner |
| POST | `/api/v1/farms/:farmId/inventory-transactions` | Owner / Manager / Worker / Accountant (by type) |
| GET | `/api/v1/farms/:farmId/inventory-transactions` | Farm member |
| GET | `/api/v1/farms/:farmId/inventory-transactions/summary` | Farm member |
| GET | `/api/v1/farms/:farmId/inventory-transactions/:id` | Farm member |
| POST | `/api/v1/farms/:farmId/inventory-transactions/:id/reverse` | Owner / Manager |
| DELETE | `/api/v1/farms/:farmId/inventory-transactions/:id` | Owner (always 403) |

---

## 1. POST `/api/v1/farms/:farmId/inventory` — register a stock item

Owner / Manager. Body is strict; `inventoryCode`, `farmId`, `status`, `createdBy`, `updatedBy`, `_id` and
timestamps are rejected (400).

```json
{
  "itemName": "Napier Grass",
  "itemType": "Feed",
  "referenceId": "6b0199740e75499779bee2c4",
  "category": "Roughage",
  "currentStock": 250,
  "unit": "kg",
  "minimumStock": 50,
  "reorderLevel": 80,
  "maximumStock": 500,
  "supplierName": "ABC Agro Feed Supplier",
  "storageLocation": "Feed Store Room A",
  "expiryDate": "2027-03-31",
  "remarks": "Store away from direct sunlight.",
  "openingTransactionType": "Purchase",
  "openingUnitPrice": 40,
  "openingTransactionDate": "2026-11-20",
  "openingRemarks": "Opening stock from the November purchase"
}
```

| Field | Rules |
|---|---|
| `itemType` | required enum |
| `unit` | required enum; cannot be changed once the item has movements |
| `referenceId` | **required** for Feed / Medicine / Vaccine and validated against that master catalog (wrong collection → 404, retired master → 422); **refused** for Equipment / Cleaning Supply / Other |
| `itemName` | optional when `referenceId` is given — it defaults to the master record's name |
| `currentStock` | optional, default `0`. **> 0 also writes the opening Inventory_Transaction** |
| thresholds | `minimumStock ≤ reorderLevel ≤ maximumStock` (0 means "not set") |
| `openingTransactionType` | `Purchase` (default when a price is given) or `Adjustment` |
| `openingUnitPrice` | required when the opening stock is a `Purchase`; it seeds `averagePurchasePrice` |
| `confirmDuplicate` | `true` keeps a second row for an item the farm already stocks (a different batch / expiry) |

**Never stock without history** — when `currentStock > 0` the item and its opening transaction are created
in one atomic unit of work (a MongoDB transaction, or compensating undo steps on a standalone mongod).

Duplicate guard: an active row for the same `referenceId` (or the same `itemName` for master-less types)
→ **409** naming the existing `inventoryCode`, unless `confirmDuplicate: true`.

`201` →

```json
{
  "success": true,
  "message": "Inventory item registered with its opening stock (TRX-2026-000001)!",
  "data": {
    "item": {
      "inventoryCode": "INV-2026-000001", "itemName": "Napier Grass", "itemType": "Feed",
      "currentStock": 250, "unit": "kg", "status": "Available",
      "derivedStatus": "Available", "lowStockThreshold": 80,
      "estimatedValue": 10000, "daysUntilExpiry": 127, "recommendedReorderQuantity": 0,
      "averagePurchasePrice": 40
    },
    "openingTransaction": { "transactionNo": "TRX-2026-000001", "transactionType": "Purchase", "quantity": 250, "direction": "In" },
    "master": { "name": "Napier Grass", "code": "ING-00002" }
  }
}
```

## 2. GET `/api/v1/farms/:farmId/inventory` — list

| Query | Meaning |
|---|---|
| `page`, `limit` | pagination (`limit` ≤ 100, default 10) |
| `itemType` | comma list (`Feed,Medicine`) |
| `category` | exact, case-insensitive |
| `status` | comma list of **derived** statuses (`Low Stock,Out of Stock`) |
| `lowStock=true` | at or below `max(reorderLevel, minimumStock)` — includes out-of-stock rows |
| `expired=true` | `expiryDate` already passed |
| `expiringDays=30` | still usable today, expiring within N days |
| `supplierName`, `storageLocation` | partial, case-insensitive |
| `referenceId` | the farm's stock rows for one master catalog item |
| `searchTerm` | `itemName` / `inventoryCode` / supplier / storage location |
| `includeInactive=true` | include archived rows (hidden by default) |
| `sort` | `itemName` (default), `currentStock`, `expiryDate`, `status`, `itemType`, `createdAt`, `updatedAt`; prefix `-` for descending |

Status filters, sorting and pagination all run on the **derived** status inside one aggregation, so the
page you get is the page you asked for.

```json
{
  "meta": { "page": 1, "limit": 10, "totalEntries": 24, "totalPage": 3 },
  "data": {
    "items": [ { "inventoryCode": "INV-2026-000004", "itemName": "Oxytetracycline", "derivedStatus": "Low Stock", "currentStock": 6, "unit": "bottle", "recommendedReorderQuantity": 14, "daysUntilExpiry": 52, "estimatedValue": 1080 } ],
    "summary": { "matchedItems": 24, "estimatedValue": 184250.5, "lowStock": 3, "outOfStock": 1, "expired": 2 }
  }
}
```

`summary` covers **every matched row**, not just the current page — it feeds the list header.

## 3. GET `/inventory/meta` — form metadata

Enums (item types, units, statuses, transaction types, reference types, directions), category suggestions
per item type, the categories this farm already uses, expiry-warning windows, field limits, the allowed
sort fields, and — most useful for the UI — what **this caller** may do:

```json
{
  "permissions": {
    "role": "Manager",
    "canCreateItem": true, "canUpdateItem": true, "canToggleActive": true,
    "canDeleteItem": false, "canReverseTransaction": true, "canCorrectPrice": false,
    "canViewAuditLogs": true,
    "allowedTransactionTypes": ["Purchase", "Consumption", "Damage", "Expired", "Adjustment", "Return"]
  },
  "farmWritable": true
}
```

## 4. GET `/inventory/lookup` — picker list

`?itemType=Feed&searchTerm=nap&includeInactive=false`. Returns up to 200 light rows
(`_id`, `inventoryCode`, `itemName`, `currentStock`, `unit`, derived `status`, `consumable`) for the
"choose a stock item" dropdown on the movement form.

## 5. GET `/inventory/master-options?itemType=Feed` — create-form picker

The active FeedIngredient / Medicine / Vaccine catalog rows (`?searchTerm=`, `?limit=`), each flagged with
`stocked: true|false` and, when stocked, the existing inventory row — so the form can say
*"already stocked as INV-2026-000001"* instead of creating a duplicate.

## 6. GET `/inventory/dashboard-summary`

`?expiringDays=30`. Everything is calculated; no derived value is stored.

```json
{
  "asOf": "2026-11-24T…",
  "cards": {
    "totalItems": 26, "activeItems": 24, "inactiveItems": 2,
    "available": 19, "lowStock": 3, "outOfStock": 1, "expired": 1,
    "expiringSoon": 2, "alertCount": 5, "estimatedStockValue": 184250.5
  },
  "last30Days": { "purchaseQuantity": 850, "purchaseSpend": 34200, "consumptionQuantity": 612.5, "wastageQuantity": 18, "movements": 47 },
  "byItemType": [ { "_id": "Feed", "items": 9, "estimatedValue": 120400, "lowStock": 2, "outOfStock": 0 } ],
  "reorderRecommendations": [ { "inventoryCode": "INV-2026-000004", "itemName": "Oxytetracycline", "currentStock": 6, "recommendedReorderQuantity": 14, "estimatedReorderCost": 2520, "derivedStatus": "Low Stock" } ],
  "expiringSoon": [ … ], "expiredItems": [ … ], "recentTransactions": [ … ],
  "notificationsPersisted": true
}
```

`recommendedReorderQuantity = maximumStock − currentStock`, and only for items at or below their reorder
line (when no maximum is set it falls back to twice the threshold).
Alerts are also stored as notifications (`notification.md`).

## 7. GET `/inventory/alerts`

`?expiringDays=30&limit=50`. The rows behind the dashboard cards, split into `lowStock`, `outOfStock`,
`expired` and `expiringSoon`, plus a `counts` block. Archived (Inactive) items are excluded.

## 8. POST `/inventory/sync-statuses`

Owner / Manager. Re-derives the **stored** `status` of every item in the farm from stock, thresholds and
expiry and reports what changed:

```json
{ "checked": 26, "changed": 2, "changes": [ { "inventoryCode": "INV-2026-000007", "from": "Available", "to": "Expired" } ] }
```

Reads never needed it (they derive), but it keeps the stored column truthful for other modules — notably
the consumption guard that FeedRecord / Treatment / Vaccination apply.

## 9. GET `/inventory/:id` — detail

By `_id` or `inventoryCode`. Returns the item with its derived block, the populated master record, the
last 10 movements (each with `direction` and the signed `delta`), the lifetime purchase spend, and the
**reconciliation** check:

```json
{
  "inventoryCode": "INV-2026-000001", "currentStock": 238, "derivedStatus": "Available",
  "master": { "name": "Napier Grass", "code": "ING-00002", "collection": "FeedIngredient" },
  "movementCount": 4, "purchaseSpend": 10000,
  "reconciliation": { "ledgerBalance": 238, "currentStock": 238, "balanced": true },
  "recentTransactions": [ { "transactionNo": "TRX-2026-000002", "transactionType": "Consumption", "quantity": 12, "direction": "Out", "delta": -12 } ]
}
```

`balanced: false` means a movement bypassed the ledger — investigate, never "fix" the number by hand
(record an `Adjustment` instead).

## 10. GET `/inventory/:id/ledger` — stock ledger with running balance

`?page=&limit=` (≤ 200, default 20), `?transactionType=`, `?from=&to=`. Oldest first, so the balance reads
like a bank statement; `openingBalance` accounts for every movement before the page.

```json
{
  "meta": { "page": 1, "limit": 20, "totalEntries": 4, "totalPage": 1 },
  "data": {
    "item": { "inventoryCode": "INV-2026-000001", "itemName": "Napier Grass", "unit": "kg", "currentStock": 238, "status": "Available" },
    "openingBalance": 0, "closingBalance": 238,
    "totals": { "totalIn": 250, "totalOut": 12, "movements": 4 },
    "reconciliation": { "ledgerBalance": 238, "currentStock": 238, "balanced": true },
    "data": [
      { "transactionNo": "TRX-2026-000001", "transactionType": "Purchase",    "quantity": 250, "direction": "In",  "delta": 250, "balance": 250 },
      { "transactionNo": "TRX-2026-000002", "transactionType": "Consumption", "quantity": 12,  "direction": "Out", "delta": -12, "balance": 238 }
    ]
  }
}
```

Stored quantities stay strictly positive — `delta` and `balance` are computed for display.

## 11. GET `/inventory/:id/audit-logs`

Owner / Manager / Accountant. The AuditLog rows of the item **and** of its ledger entries, newest first
(`?page=&limit=`). IP address and user agent are never exposed to farm users.

## 12. PUT `/inventory/:id` — controlled metadata update

Owner / Manager. Updatable: `itemName`, `category`, `minimumStock`, `maximumStock`, `reorderLevel`,
`supplierName`, `storageLocation`, `expiryDate`, `remarks` (+ `averagePurchasePrice` for the Owner, with
`reason`). Anything else → 400 listing what is updatable.

| Attempt | Result |
|---|---|
| `currentStock` | **400** — "record a Purchase, Consumption, Damage, Expired, Adjustment or Return transaction instead" |
| `unit` / `itemType` / `referenceId` with movements recorded | **409** — deactivate the item and register a new one |
| `unit` / `itemType` / `referenceId` with no movements | 400 — identity fields are not editable here |
| threshold ladder broken | 400 |

A changed `expiryDate` or threshold re-derives `status` in the same write. Changes are recorded in the
AuditLog (`oldData`, `newData`, `changedFields`). Nothing changed → `{ "mode": "unchanged" }`.

## 13. PATCH `/inventory/:id/toggle-active`

Owner / Manager. `{ "active": false, "reason": "Discontinued supplier" }` — `active` omitted flips the
current state; `reason` is required when deactivating.

`Inactive` blocks every new movement while the whole ledger stays readable. Reactivating re-derives the
real status from stock, thresholds and expiry. Response: `mode` (`activated` / `deactivated` /
`unchanged`) plus the item.

## 14. DELETE `/inventory/:id`

Owner. **Archival by default**: the item becomes `Inactive` and its history survives
(`{ "mode": "deactivated" }`). Optional body `{ "reason": "…" }`.

`?hard=true` really deletes, and only when the item is clean:

| Condition | Result |
|---|---|
| any Inventory_Transaction exists | **409** — deleting would destroy the explanation behind past balances |
| `currentStock > 0` | **409** — write the stock off first (Damage / Expired / Adjustment) |
| no stock, no history | 200, `{ "mode": "deleted" }` |

---

## 15. POST `/api/v1/farms/:farmId/inventory-transactions` — record a movement

The single door through which a farm user changes stock.

```json
{
  "inventoryId": "INV-2026-000001",
  "transactionType": "Purchase",
  "transactionDate": "2026-11-24",
  "quantity": 50,
  "unit": "kg",
  "unitPrice": 45,
  "totalAmount": 2250,
  "supplierName": "ABC Agro Feed Supplier",
  "remarks": "November restock",
  "expiryDate": "2027-06-30"
}
```

| Field | Rules |
|---|---|
| `inventoryId` | `_id` or `inventoryCode`, must belong to this farm |
| `transactionType` | `Purchase`, `Consumption`, `Damage`, `Expired`, `Adjustment`, `Return`. `Vaccination Usage` / `Treatment Usage` → **400** (use their workflow) |
| `quantity` | **> 0** (zero / negative → 400); rounded to 4 decimals |
| `direction` | required for `Adjustment` (or send `physicalCount`); optional for `Return` (default `In`); rejected when it contradicts a fixed type |
| `physicalCount` | `Adjustment` shortcut: the counted stock. The server derives quantity **and** direction from the difference (equal → 400, nothing to adjust) |
| `unit` | must equal the item's unit — no automatic conversion (400) |
| `unitPrice` | **required** for `Purchase`; allowed on other types to value the movement |
| `totalAmount` | verified against `quantity × unitPrice` (± 0.05) |
| `referenceType` | `Manual` (default), `Purchase` (default for a purchase) or `Expense` |
| `referenceId` | only with `referenceType: "Expense"` |
| `remarks` | **required** for `Damage`, `Expired`, `Adjustment` |
| `transactionDate` | business date; ≤ 365 days back, never in the future |
| `expiryDate` | optional on an inflow — refreshes the restocked item's expiry |

Guardrails:

| Situation | Result |
|---|---|
| item `Inactive` | 422 — reactivate it first |
| item `Expired` | 422 for everything except an `Expired` write-off or an `Adjustment`; stock can never be **added** to an expired row |
| outflow larger than `currentStock` | 422 "Insufficient stock: … on hand, … requested" |
| the stock changed while saving | 409 "Reload the item and try again" |
| `currentStock + delta > maximumStock` | allowed, reported in `warnings[]` (farm policy decides) |

**Atomicity and concurrency.** The stock update, the ledger row and the item's price/status update run in
one unit of work, and the stock update is a single conditional pipeline update
(`currentStock >= quantity`), so two workers consuming the same item at the same moment can never drive
stock negative or leave an unlogged change.

A `Purchase` re-derives the weighted average:
`(oldStock × oldAvg + qty × unitPrice) / (oldStock + qty)`.

`201` →

```json
{
  "success": true,
  "message": "Purchase recorded — Napier Grass is now at 288 kg.",
  "data": {
    "transaction": { "transactionNo": "TRX-2026-000003", "transactionType": "Purchase", "quantity": 50, "direction": "In", "delta": 50, "unitPrice": 45, "totalAmount": 2250 },
    "item": { "inventoryCode": "INV-2026-000001", "stockBefore": 238, "currentStock": 288, "status": "Available", "unit": "kg" },
    "alert": null,
    "warnings": []
  }
}
```

`alert` is filled only when the movement **crosses** a threshold (spec §80 de-duplication), so repeated
consumption below the reorder line does not raise the same warning again:

```json
{ "level": "warning", "status": "Low Stock", "message": "Oxytetracycline (INV-2026-000004) stock is at or below its reorder level (6 bottle left)." }
```

`level: "critical"` for out of stock. The matching notification is stored too (`notification.md`).

## 16. GET `/inventory-transactions` — list

| Query | Meaning |
|---|---|
| `page`, `limit` | pagination (`limit` ≤ 100) |
| `inventoryId` | `_id` or `inventoryCode` |
| `transactionType`, `referenceType` | comma lists |
| `direction` | `In` / `Out` (applied after the direction is resolved) |
| `performedBy` | FarmMember `_id` |
| `supplierName` | partial, case-insensitive |
| `from`, `to` | **`transactionDate`** range (the business date, not `createdAt`) |
| `searchTerm` | `transactionNo` / supplier / remarks |
| `sort` | `transactionDate` (default, descending), `createdAt`, `quantity`, `totalAmount`, `transactionType` |

Each row carries the populated item, `performedBy`, the resolved `direction` and the signed `delta`.

## 17. GET `/inventory-transactions/summary`

`?from=&to=` (default: the last 30 days), `?inventoryId=`, `?itemType=`.

```json
{
  "range": { "from": "2026-10-25T…", "to": "2026-11-24T…" },
  "totals": {
    "movements": 47, "stockIn": 900, "stockOut": 630.5, "netChange": 269.5,
    "purchaseQuantity": 850, "purchaseSpend": 34200,
    "consumptionQuantity": 560, "treatmentUsage": 34.5, "vaccinationUsage": 18,
    "damageQuantity": 12, "expiredQuantity": 6, "wastageQuantity": 18, "wastageValue": 740,
    "adjustmentQuantity": 4, "returnQuantity": 50
  },
  "byType": [ … ], "byDirection": [ … ], "byReferenceType": [ … ],
  "bySupplier": [ { "_id": "ABC Agro Feed Supplier", "purchases": 4, "quantity": 600, "spend": 24600 } ],
  "byItem": [ … ], "byMonth": [ { "_id": "2026-11", "inQuantity": 900, "outQuantity": 630.5, "spend": 34200 } ]
}
```

Wastage = `Damage + Expired` (stock lost rather than used). `byMonth` feeds the monthly inventory report.

## 18. GET `/inventory-transactions/:id` — detail

By `_id` or `transactionNo`. Adds the resolved `direction`, the signed `delta`, the item's
`balanceAfter` this movement, the `reversal` row if it was already reversed, and `reversible`.

## 19. POST `/inventory-transactions/:id/reverse` — compensating reversal

Owner / Manager. `{ "reason": "Wrong quantity entered", "reversalType": "Adjustment", "transactionDate": "2026-11-24" }`
(`reason` required, ≥ 3 chars).

The ledger is append-only, so the original row is **never touched**. A new movement in the opposite
direction is written, pointing back at the original — which is also how a double reversal is detected.

| Rule | Behaviour |
|---|---|
| `reversalType` | `Adjustment` (default), or `Return` — the default for reversing a `Purchase` |
| already reversed | **409** naming the existing reversal |
| `Treatment Usage` / `Vaccination Usage` | **409** — correct it in the treatment / vaccination module so the clinical record and the stock stay consistent |
| `referenceType: FeedRecord` | **409** — correct or void that feed record instead |
| reversing an inflow whose stock is already used | **422** — record the real movement instead |
| item `Inactive` | 422 — reactivate it first |

`201` →

```json
{
  "reversal": { "transactionNo": "TRX-2026-000005", "transactionType": "Return", "quantity": 50, "direction": "Out", "remarks": "Reversal of TRX-2026-000003 (Purchase) — Wrong quantity entered" },
  "original": { "transactionNo": "TRX-2026-000003", "direction": "In", "quantity": 50, "mutated": false },
  "item": { "stockBefore": 288, "currentStock": 238, "status": "Available" },
  "alert": null,
  "note": "averagePurchasePrice was left as it is — a weighted average cannot be un-mixed. Correct it with PUT /inventory/:id (Owner) if the reversed purchase skewed it."
}
```

## 20. DELETE `/inventory-transactions/:id` — always 403

```json
{
  "success": false,
  "message": "TRX-2026-000003 cannot be deleted. A committed stock movement is what explains the current balance (sum of inflows − outflows = currentStock), so the ledger is append-only — reverse it with POST /api/v1/farms/:farmId/inventory-transactions/TRX-2026-000003/reverse instead."
}
```

---

## How other modules move this stock

| Module | Transaction type | `referenceType` | Notes |
|---|---|---|---|
| FeedRecord | `Consumption` (and `Return` when corrected / voided) | `FeedRecord` | corrections move only the difference |
| Treatment | `Treatment Usage` (`Return` on a cancelled episode) | `Treatment` | `POST /treatments/:id/consume-inventory`, FEFO across usable rows |
| Vaccination | `Vaccination Usage` (`Return` when a completed dose is cancelled) | `Vaccination` | completing a dose deducts vaccine stock |

Those rows are visible here and reversible **only** through their own module, so the source document and
the stock never disagree.

## Known limitations (from the final schema, not bugs)

- **No batch / lot model.** One item has a single `expiryDate`, so true batch-level FIFO/FEFO is not
  possible. Register separate rows (`confirmDuplicate: true`) for batches with different expiries; the
  health modules then pick the row expiring first.
- **No `reservedStock`.** A feed recommendation suggests a quantity, it does not reserve it.
- **No Supplier master.** `supplierName` is a string on both the item and each transaction.
- **Expense link.** A purchase may carry `referenceType: "Expense"` + `referenceId` (verified in this farm). Recording a purchase here creates no Expense; `POST /expenses/purchase` does both at once, and `GET /expenses/reconciliation` lists purchases without one (see `expense.md`).
- **No Notification rows.** Low-stock / out-of-stock alerts are returned by the API (`alert`,
  `/inventory/alerts`, `dashboard-summary`) until Model 23 exists.
- `POST /inventory/sync-statuses` is the manual version of the daily `inventory.sync` job (needs `JOBS_ENABLED=true`).
- **Equipment** is tracked as a countable stock item only (no serial number, maintenance schedule or
  asset condition).
