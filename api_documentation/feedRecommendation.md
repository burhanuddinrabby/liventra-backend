# Liventra Backend — Feed Recommendations API (Model 08)

Base URL: `http://localhost:5000`

All endpoints require `Authorization: Bearer <accessToken>`. Response envelope and error shape are the
same as every other module (`{ success, message, data, meta? }` / `{ success: false, message, errorSources }`).

A FeedRecommendation answers **"what should THIS animal eat, based on its condition at THIS moment?"**.
It is generated from the animal's live context + a `FeedFormula` + the recommendation rules, and once
saved it is an **immutable historical snapshot**: `inputSnapshot`, `recommendedItems` (with snapshotted
`ingredientName` / `estimatedCost`), `totalRecommendedDMI`, `estimatedDailyCost`, `explanation`,
`warnings` and `ruleVersion` are served exactly as stored and are never recalculated from current
Animal / FeedFormula / FeedIngredient data. When anything changes, generate a **new** recommendation.

```text
FeedIngredient → FeedFormula → FeedRecommendation → FeedRecord
 (what is it?)    (general plan)  (plan for this animal now)  (what was actually fed)
```

All routes are farm-scoped: `/api/v1/farms/:farmId/...` where `:farmId` is the farm `_id` or `FARM-00001`.

## Enums (final DB schema)

```text
status:  Draft | Confirmed | Expert Approved | Rejected | Superseded
stage:   Calf | Growing | Heifer | Lactating | Dry | Breeding          (FeedFormula stages)
purpose: Maintenance | Breeding | Growth | Milk Production             (FeedFormula purposes)
season:  Summer | Winter | Rainy | All Season
```

Served by `GET /feed-recommendations/meta` together with transitions, rule factors and permissions.

## Roles (farm role from the active FarmMember row)

| Action | Owner | Manager | Worker | Veterinarian | Accountant |
|---|---|---|---|---|---|
| List / get / animal history / meta / stats | ✅ | ✅ | ✅ | ✅ | ✅ |
| Preview (unsaved) | ✅ | ✅ | ✅ | ✅ | ❌ |
| Save official recommendation | ✅ | ✅ | ❌ | ❌ | ❌ |
| Status change (confirm / reject) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Expert review (approve / reject) | ✅ | ✅ | ❌ | ✅ (the "Expert") | ❌ |
| Audit history of one record | ✅ | ✅ | ❌ | ✅ | ❌ |
| Delete (Draft only) | ✅ | ❌ | ❌ | ❌ | ❌ |

- Platform `superAdmin` and the farm's owner account are treated as **Owner**; platform `admin` is not.
- `createdBy` / `reviewedBy` reference the caller's **FarmMember** row (final schema). A super admin
  without a membership row can read and preview but gets **403** on writes.
- Farms in `Suspended` / `Inactive` status are read-only (writes → 403). Preview still works.
- Populated members expose only `role` and the user's `userId` + `fullName`; audit rows never expose
  IP address or user agent.

## Field reference

| Field | Type | Notes |
|---|---|---|
| `recommendationNo` | String | `REC-2026-000001`; atomic per-year counter, immutable |
| `farmId` / `animalId` | ObjectId | immutable |
| `formulaId` | ObjectId \| null | FeedFormula used |
| `generatedAt` | Date | server time at save |
| `inputSnapshot` | Object | `{ age (months \| null), currentWeight (kg \| null), stage, purpose, healthStatus, reproductiveStatus, milkYield (L/day \| null), targetADG (kg/day \| null), season }` |
| `recommendedItems[]` | Array | `{ ingredientId, ingredientName (snapshot), quantity, unit, estimatedCost (BDT/day, snapshot) }` |
| `totalRecommendedDMI` | Number | kg DM/day |
| `estimatedDailyCost` | Number | BDT/day |
| `explanation[]` / `warnings[]` | String[] | why / limitations |
| `ruleVersion` | String | recommendation rule version (currently `v1.0`) |
| `status` | Enum | see transitions |
| `reviewedBy` / `reviewedAt` | FarmMember / Date | set by expert review **and** by rejection |
| `statusReason` | String | rejection reason (extension) |
| `reviewNote` | String | expert note (extension) |
| `supersededBy` / `supersededAt` | ObjectId / Date | set when a newer plan replaced this one (extension) |
| `createdBy` | FarmMember | who generated it |
| `createdAt` / `updatedAt` | Date | |

## Status lifecycle

```text
Draft ──► Confirmed ──► Expert Approved ──► Superseded
  │           │  └──────────────────────────► Superseded   (automatic, when a newer plan is confirmed)
  └──► Rejected  └──► Rejected
```

| Endpoint | From | To |
|---|---|---|
| `PATCH /:id/status` | Draft | Confirmed, Rejected |
| `PATCH /:id/status` | Confirmed | Rejected |
| `PATCH /:id/review` | Confirmed | Expert Approved, Rejected |
| automatic | Confirmed, Expert Approved | Superseded |

`Superseded` is never set by hand. Only **one** active plan (Confirmed / Expert Approved) exists per animal:
when a recommendation becomes Confirmed (on save or via `/status`), the animal's previous active plans are
marked `Superseded` **after** the new record exists, inside a MongoDB transaction (on a standalone server
without transactions, a compensating rollback is used instead).

## Recommendation rules (ruleVersion `v1.0`)

1. **Context** — age from `birthDate`, `currentWeight`, `healthStatus`, `reproductiveStatus`, latest-day
   milk total from `MilkRecord` (last 7 days), season (request, otherwise the current Bangladesh season:
   Summer Mar–Jun, Rainy Jul–Oct, Winter Nov–Feb).
   - Stage (overridable): Calf / Heifer / Lactating / Dry map 1:1; Pregnant → Breeding; under 6 months → Calf;
     males → Breeding (breeding bulls) or Growing; Open females → Breeding (Beef → Growing).
   - Purpose (overridable): Dairy → Milk Production, Beef → Growth, Breeding → Breeding,
     Dual Purpose → Milk Production (lactating) / Maintenance (dry) / Growth.
2. **Formula** — the requested active `formulaId` (warnings on breed / stage / purpose / season mismatch)
   or the best automatic match from `FeedFormula /match`. No match or an ambiguous tie = **no plan**
   (blocker), never a fabricated one.
3. **Requirement** — `DMI = weight × %BW` (Calf 3.0, Growing 2.75, Heifer 2.5, Lactating 2.5, Dry 2.0,
   Breeding 2.25) `+ 0.1 kg DM per L milk` (Lactating) `+ 1.0 kg DM per kg/day` of requested ADG above the
   formula's target, `× season factor` (Summer 0.95, Winter 1.05). Formula quantities are scaled to this
   DMI, bounded to ×0.5–×2 (warning when capped). No weight → formula used unscaled (warning).
4. **Output** — items priced with the **current** ingredient prices (then frozen on save), total DMI from
   ingredient DM %, crude-protein check per stage.

**Warnings** include stale weight (> 30 days since the last WeightRecord / profile update), missing birth
date / weight / milk record, animal Sick / Under Treatment / Quarantine (expert review recommended),
unavailable or retired ingredients, capped scaling, low protein, summer water intake.

**Blockers** (preview returns `canSave: false` + `blockers[]`; save returns **422**): no / ambiguous formula,
an unavailable ingredient without `allowUnavailableIngredients: true`, no usable ingredient.
Animals that are Sold / Dead / Transferred / Archived → **409** on preview and save.

## Endpoint summary

| Method | Path (under `/api/v1/farms/:farmId`) | Access | Description |
|---|---|---|---|
| POST | `/feed-recommendations/preview` | Owner / Manager / Worker / Vet | live unsaved recommendation |
| POST | `/feed-recommendations` | Owner / Manager | save official snapshot, supersede previous plan |
| GET | `/feed-recommendations` | Farm member | list + filters + pagination |
| GET | `/feed-recommendations/meta` | Farm member* | enums, transitions, rules |
| GET | `/feed-recommendations/stats` | Farm member | counts and active-plan cost |
| GET | `/feed-recommendations/:id` | Farm member | one snapshot (`_id` or `recommendationNo`) |
| GET | `/feed-recommendations/:id/audit-logs` | Owner / Manager / Vet | change history |
| PATCH | `/feed-recommendations/:id/status` | Owner / Manager | confirm / reject |
| PATCH | `/feed-recommendations/:id/review` | Owner / Manager / Vet | expert approve / reject |
| DELETE | `/feed-recommendations/:id` | Owner | delete a **Draft** only |
| GET | `/animals/:animalId/feed-recommendations` | Farm member | animal timeline + active plan |

\* `/meta` is static and only requires a signed-in user.

---

### 1. Preview — `POST /feed-recommendations/preview`

Nothing is written. Re-run it whenever the animal or formula changes.

Body (all optional except `animalId`; unknown keys → 400):

```json
{
  "animalId": "6650f0c1a1b2c3d4e5f60789",
  "formulaId": "FF-000003",
  "stage": "Growing",
  "purpose": "Growth",
  "season": "Winter",
  "milkYield": 8.5,
  "targetADG": 0.8,
  "allowUnavailableIngredients": false
}
```

`formulaId` accepts the `_id` or `formulaCode`. `milkYield` overrides the MilkRecord value.

Response `200`:

```json
{
  "success": true,
  "message": "Recommendation preview generated (not saved)!",
  "data": {
    "isPreview": true,
    "generatedAt": "2026-11-21T08:00:00.000Z",
    "animal": { "_id": "…", "animalCode": "AN-000004", "name": "Lali", "gender": "Female", "purpose": "Dairy",
                "breed": { "_id": "…", "breedCode": "BREED-00002", "breedName": "Sahiwal" } },
    "formula": { "_id": "…", "formulaCode": "FF-000003", "formulaName": "Growing heifer winter", "stage": "Growing",
                 "purpose": "Growth", "season": "Winter", "ruleVersion": "v1.0", "isDefault": true },
    "formulaCandidates": [ { "_id": "…", "formulaCode": "FF-000003", "score": 75, "…": "…" } ],
    "inputSnapshot": { "age": 14, "currentWeight": 180, "stage": "Growing", "purpose": "Growth",
                       "healthStatus": "Healthy", "reproductiveStatus": "Heifer", "milkYield": null,
                       "targetADG": 0.8, "season": "Winter" },
    "recommendedItems": [
      { "ingredientId": "…", "ingredientName": "Napier Grass", "quantity": 12.4, "unit": "kg", "estimatedCost": 74.4,
        "ingredientCode": "ING-00001", "category": "Green Fodder", "dryMatterKg": 2.48, "pricePerUnit": 6,
        "ingredientUnit": "kg", "isAvailable": true }
    ],
    "totalRecommendedDMI": 5.2,
    "estimatedDailyCost": 182.5,
    "requiredDMI": 5.2,
    "scaleFactor": 1.08,
    "explanation": ["Base intake 2.75% of 180 kg body weight = 4.95 kg DM/day (Growing stage)", "…"],
    "warnings": ["Weight data may be stale (last updated 2026-09-01); re-weigh the animal for accuracy."],
    "ruleVersion": "v1.0",
    "blockers": [],
    "canSave": true,
    "currentActiveRecommendation": { "_id": "…", "recommendationNo": "REC-2026-000002", "status": "Confirmed",
                                     "generatedAt": "…", "estimatedDailyCost": 170, "totalRecommendedDMI": 4.9,
                                     "ruleVersion": "v1.0" }
  }
}
```

Preview-only line fields (`ingredientCode`, `category`, `dryMatterKg`, `pricePerUnit`, `ingredientUnit`,
`isAvailable`) are **not** stored.

### 2. Save — `POST /feed-recommendations`

Same body as preview plus `status` (`Confirmed` default, or `Draft`). The server **re-runs the engine** —
client-sent items/costs are never accepted. Auto-generates `recommendationNo`, sets `generatedAt` and
`createdBy`, and (for `Confirmed`) supersedes the animal's previous active plan.

Response `201`:

```json
{
  "success": true,
  "message": "Feed recommendation saved successfully!",
  "data": {
    "recommendation": { "_id": "…", "recommendationNo": "REC-2026-000003", "status": "Confirmed", "…": "…" },
    "supersededRecommendations": ["REC-2026-000002"]
  }
}
```

Errors: `403` role / farm read-only / no membership row, `404` animal or formula, `409` inactive animal or
retired formula, `422` blockers (message lists them).

### 3. List — `GET /feed-recommendations`

Query: `page` (1), `limit` (10, max 100), `sort` (`generatedAt`, `createdAt`, `estimatedDailyCost`,
`totalRecommendedDMI`, `recommendationNo`, `status`, `ruleVersion`; prefix `-` for desc; default `-generatedAt`),
`animalId` (`_id` or `animalCode`), `status` (comma-separated), `ruleVersion`, `formulaId`, `season`, `stage`,
`from` / `to` (on `generatedAt`; a bare `YYYY-MM-DD` `to` includes that whole day), `searchTerm`
(partial `recommendationNo`).

Rows omit `explanation`; `animalId`, `formulaId` and `createdBy` are populated.

```json
{ "success": true, "message": "…", "meta": { "page": 1, "limit": 10, "totalEntries": 23, "totalPage": 3 }, "data": [ … ] }
```

### 4. Animal history — `GET /animals/:animalId/feed-recommendations`

`:animalId` = `_id` or `animalCode`. Query: `status` (comma list), `page`, `limit` (default 50).

```json
{
  "meta": { "page": 1, "limit": 50, "totalEntries": 4, "totalPage": 1 },
  "data": {
    "animal": { "_id": "…", "animalCode": "AN-000004", "name": "Lali", "lifeStatus": "Active", "currentWeight": 180, "…": "…" },
    "activeRecommendation": { "recommendationNo": "REC-2026-000003", "status": "Confirmed", "…": "…" },
    "statusCounts": { "Draft": 0, "Confirmed": 1, "Expert Approved": 0, "Rejected": 1, "Superseded": 2 },
    "history": [ { "…": "newest first, full populated snapshots" } ]
  }
}
```

### 5. Get one — `GET /feed-recommendations/:id`

`:id` = `_id` or `recommendationNo` (`REC-2026-000003`). Returns the populated stored snapshot.

### 6. Meta / stats

`GET /feed-recommendations/meta` → `{ statuses, creatableStatuses, statusTransitions, reviewTransitions, stages,
purposes, seasons, currentSeason, ruleVersion, rules, permissions, units }`.

`GET /feed-recommendations/stats` →

```json
{
  "total": 23,
  "byStatus": { "Draft": 2, "Confirmed": 9, "Expert Approved": 3, "Rejected": 1, "Superseded": 8 },
  "byRuleVersion": [ { "ruleVersion": "v1.0", "count": 23, "avgDailyCost": 176.4 } ],
  "activePlans": { "count": 12, "animalsCovered": 12, "totalDailyCost": 2140.5, "avgDailyCost": 178.38, "avgDMI": 6.2 }
}
```

### 7. Status — `PATCH /feed-recommendations/:id/status`

```json
{ "status": "Confirmed" }
{ "status": "Rejected", "reason": "Animal moved to a different ration" }
```

`reason` is required for `Rejected`. Any snapshot field in the body (`inputSnapshot`, `recommendedItems`,
`totalRecommendedDMI`, `estimatedDailyCost`, `ruleVersion`, …) → **400** ("snapshots are immutable").
Invalid transition → **409**. Confirming a draft of an animal that is no longer active → **409**.
Concurrent change → **409** ("reload and try again"). Writes an AuditLog row.

Response: `{ recommendation, supersededRecommendations: ["REC-…"] }`.

### 8. Expert review — `PATCH /feed-recommendations/:id/review`

```json
{ "decision": "Expert Approved", "reviewNote": "Ration fits the growth target" }
{ "decision": "Rejected", "reviewNote": "Protein too low for this heifer" }
```

Only `Confirmed` records can be reviewed. Sets `reviewedBy` (caller's FarmMember) and `reviewedAt`;
`reviewNote` required for `Rejected`. Writes an AuditLog row (`Approve` / `Reject`).

### 9. Delete — `DELETE /feed-recommendations/:id`

Owner only, **Draft only**. Confirmed / Expert Approved / Superseded / Rejected → **409** (official history).
Response `{ _id, recommendationNo }`. Audited.

### 10. Audit logs — `GET /feed-recommendations/:id/audit-logs`

Query `page`, `limit`. Rows: `{ logNo, action, event, oldData, newData, changedFields, status, createdAt,
userId: { userId, fullName } }`. Events: `Recommendation Generated`, `Recommendation Confirmed`,
`Recommendation Rejected`, `Recommendation Expert Approved`, `Recommendation Superseded`,
`Draft Recommendation Deleted`.
