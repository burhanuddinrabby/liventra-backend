# Liventra Backend — Feed Formulas API (Model 07)

Base URL: `http://localhost:5000`

All endpoints require `Authorization: Bearer <accessToken>`. Response envelope and error shape are the
same as every other module (`{ success, message, data, meta? }` / `{ success: false, message, errorSources }`).

A FeedFormula is a **reusable, global feeding blueprint** (no `farmId`): for a breed + stage + purpose +
season (+ optional weight / milk-yield / ADG targets) it says which `FeedIngredient`s to combine and how
much. It is not a per-animal recommendation — `FeedRecommendation` (see `feedRecommendation.md`) references it via
`formulaId` and keeps its own snapshot.

**Historical protection:** formulas are never hard-deleted while referenced, and scientific changes to a
formula already used by a recommendation create a **new version record** instead of overwriting it.

## Enums (final DB schema)

```text
stage:   Calf | Growing | Heifer | Lactating | Dry | Breeding
purpose: Maintenance | Breeding | Growth | Milk Production
season:  Summer | Winter | Rainy | All Season
unit:    kg | g | liter | ml | piece        (same as FeedIngredient)
```

Served by `GET /api/v1/feed-formulas/meta`, together with units, the formulation basis and tolerances.

## Roles

| Action | Who |
|---|---|
| List / lookup / meta / stats / get / versions | any signed-in user (inactive formulas in list/versions: admins only) |
| Match | platform `admin`/`superAdmin`, or a user with an active farm membership; with `farmId`, membership in **that** farm (`superAdmin` / farm owner bypass) |
| Create, preview, update, clone-version, set-default, toggle-active, delete | `admin` / `superAdmin` |
| Usage, audit history | `admin` / `superAdmin` |

Roles are re-read from the DB on every request. Populated users expose only `userId` and `fullName`.

## Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `formulaCode` | String | auto | `FF-000001`; immutable, system-generated |
| `formulaName` | String | yes | 3–150 chars |
| `breedId` | ObjectId | yes | breed must exist and be **active** |
| `stage` / `purpose` / `season` | Enum | yes | see enums |
| `targetWeightRange` | `{min?, max?}` | no | kg, non-negative, `min <= max` |
| `targetMilkYield` | `{min?, max?}` | no | L/day, non-negative, `min <= max` |
| `targetADG` | Number | no | kg/day, ≥ 0 |
| `ingredients[]` | Array | yes | 1–50 lines `{ ingredientId, percentage, quantity, unit }` |
| `expectedNutrition` | Object | auto | `{ dryMatter (kg DM/day), crudeProtein (% of DM), energy (Mcal/kg DM) }` — **calculated** |
| `estimatedDailyCost` | Number | auto | BDT/day at save time — **calculated** |
| `ruleVersion` | String | yes | 1–30 chars `[A-Za-z0-9._-]`, e.g. `v1.0`, `FEED-RULE-2026-01` |
| `description` | String | no | ≤ 2000 chars |
| `isDefault` | Boolean | auto | default `false`; at most one **active** default per exact `(breedId, stage, purpose, season)` |
| `isActive` | Boolean | auto | default `true`; `false` = retired |
| `createdBy` / `updatedBy` | ObjectId (User) | auto | from the token |
| `createdAt` / `updatedAt` | Date | auto | |

### Ingredient lines and the formulation basis

- `ingredientId`: Mongo `_id` **or** `ingredientCode` (`ING-00001`). Must exist, be `isActive` **and**
  `isAvailable`. The same ingredient may not appear twice.
- `quantity`: > 0, amount per animal per day in `unit`.
- `unit`: optional, defaults to the ingredient's unit. Must be convertible to it: `kg↔g`, `liter↔ml`,
  `piece` only with `piece`.
- `percentage`: share of the **total as-fed mix**. Either send it on **every** line (sum must be
  100 ± 0.5, and each value within ±2 points of the line's quantity share) or omit it on **every** line
  and the server derives it from the quantities. Required when a line is in `piece`.

### Calculations (server-side, from FeedIngredient master data)

```text
asFedKg   = quantity converted to kg (liter/ml at 1 kg/L; piece lines excluded from nutrition)
DMkg      = asFedKg × dryMatterPercentage / 100
dryMatter     = Σ DMkg                              (kg DM/day)
crudeProtein  = Σ (DMkg × crudeProtein) / Σ DMkg    (% of DM)
energy        = Σ (DMkg × energy) / Σ DMkg          (Mcal/kg DM)
estimatedDailyCost = Σ quantity (in the ingredient's unit) × pricePerUnit
```

Client-sent `expectedNutrition` / `estimatedDailyCost` are ignored. Stored values are a save-time snapshot;
`GET /:id` also returns `currentMetrics` re-priced with today's ingredient data.

---

## Endpoint summary

| Method | Endpoint | Access |
|---|---|---|
| POST | `/api/v1/feed-formulas` | admin |
| GET | `/api/v1/feed-formulas` | authenticated |
| GET | `/api/v1/feed-formulas/lookup` | authenticated |
| GET | `/api/v1/feed-formulas/meta` | authenticated |
| GET | `/api/v1/feed-formulas/stats` | authenticated |
| POST | `/api/v1/feed-formulas/preview` | admin |
| POST | `/api/v1/feed-formulas/match` | farm member / admin |
| GET | `/api/v1/feed-formulas/:id` | authenticated |
| GET | `/api/v1/feed-formulas/:id/versions` | authenticated |
| GET | `/api/v1/feed-formulas/:id/usage` | admin |
| GET | `/api/v1/feed-formulas/:id/audit-logs` | admin |
| PUT | `/api/v1/feed-formulas/:id` | admin |
| POST | `/api/v1/feed-formulas/:id/clone-version` | admin |
| PATCH | `/api/v1/feed-formulas/:id/set-default` | admin |
| PATCH | `/api/v1/feed-formulas/:id/toggle-active` | admin |
| DELETE | `/api/v1/feed-formulas/:id` | admin |

`:id` is the Mongo `_id` or the `formulaCode` (case-insensitive). "admin" = `admin` / `superAdmin`.

---

## POST `/api/v1/feed-formulas`

```json
{
  "formulaName": "Holstein Lactating Summer Formula",
  "breedId": "665f1c2e8b3a4d0012345678",
  "stage": "Lactating",
  "purpose": "Milk Production",
  "season": "Summer",
  "targetWeightRange": { "min": 450, "max": 600 },
  "targetMilkYield": { "min": 15, "max": 20 },
  "targetADG": 0.2,
  "ingredients": [
    { "ingredientId": "ING-00001", "quantity": 12, "unit": "kg" },
    { "ingredientId": "ING-00002", "quantity": 3 },
    { "ingredientId": "ING-00005", "quantity": 100, "unit": "g" }
  ],
  "ruleVersion": "v1.0",
  "description": "Summer ration for 15–20 L/day cows",
  "isDefault": true
}
```

`201` → `data`:

```json
{
  "formula": { "_id": "…", "formulaCode": "FF-000001", "ingredients": [ { "ingredientId": "…", "percentage": 79.47, "quantity": 12, "unit": "kg" } ], "expectedNutrition": { "dryMatter": 5.31, "crudeProtein": 12.4, "energy": 2.35 }, "estimatedDailyCost": 280, "isDefault": true, "isActive": true, "…": "…" },
  "calculation": { "breakdown": [ { "ingredientCode": "ING-00001", "asFedKg": 12, "dryMatterKg": 2.64, "estimatedCost": 60, "…": "…" } ], "totals": { "asFedKg": 15.1, "percentage": 100 } },
  "warnings": []
}
```

Errors: `400` validation (inactive breed, unknown/retired/unavailable ingredient, duplicate ingredient,
incompatible unit, percentages not summing to 100 or not matching quantities, bad range), `409` same
name + ruleVersion already exists for this context. With `isDefault: true` any other active default of the
same context is unset (audited).

## GET `/api/v1/feed-formulas`

Query: `breedId`, `stage`, `purpose`, `season` (comma-separated multi-select), `isDefault`, `ruleVersion`,
`ingredientId` (formulas using an ingredient), `minCost` / `maxCost`, `searchTerm` (code / name),
`sort` (`formulaName`, `-createdAt`, `estimatedDailyCost`, `ruleVersion`, …; default `-createdAt`),
`page`, `limit` (≤ 100), `fields`.
`isActive` defaults to `true`; admins may pass `false` or `all` (ignored for other users). `breedId` is
populated with `breedCode breedName`.

## GET `/api/v1/feed-formulas/lookup`

Slim active list (≤ 200) for selectors. Query: `breedId`, `stage`, `purpose`, `season` (also returns
`All Season` formulas), `searchTerm`. Defaults first.

## GET `/api/v1/feed-formulas/meta`

`{ stages, purposes, seasons, units, unitConversions, nutritionUnits, formulationBasis, seasonCalendar, maxIngredients, currency }`.

## GET `/api/v1/feed-formulas/stats`

`{ total, active, retired, defaults, avgEstimatedDailyCost, byStage[], byPurpose[], bySeason[] }`
(breakdowns count active formulas; every enum value is present).

## POST `/api/v1/feed-formulas/preview`

Body `{ "ingredients": [ … ] }` — runs the full ingredient validation and calculation **without saving**.
Returns `{ ingredients, expectedNutrition, estimatedDailyCost, breakdown, totals, warnings, nutritionUnits }`.

## POST `/api/v1/feed-formulas/match`

Deterministic formula selection for an animal context. Either send the context explicitly, or `farmId` +
`animalId` to derive it (`breedId`, `currentWeight`, stage from `reproductiveStatus` Calf/Heifer/Lactating/
Dry, purpose from Dairy→Milk Production, Beef→Growth, Breeding→Breeding). Explicit fields win.

```json
{
  "farmId": "FARM-00001",
  "animalId": "6660a1…",
  "breedId": "665f1c2e8b3a4d0012345678",
  "stage": "Lactating",
  "purpose": "Milk Production",
  "season": "Summer",
  "weight": 520,
  "milkYield": 18,
  "targetADG": 0.2,
  "limit": 5
}
```

`breedId`, `stage`, `purpose` must end up known (else `400`). `season` defaults to the current Bangladesh
season (Summer Mar–Jun, Rainy Jul–Oct, Winter Nov–Feb) with a warning.

Algorithm:

1. Candidates: `isActive`, exact `breedId` + `stage` + `purpose`, `season` = requested **or** `All Season`.
2. Excluded when the weight / milk yield is outside the formula's target range (counted in `excluded`).
3. Score: exact season 30 / All Season 15; weight in range 25 / formula without range 10; milk yield in
   range 25 / no range 10; ADG closeness up to 10.
4. Order: score → `isDefault` → newest `ruleVersion` → latest update.
5. A tie at the top between two non-default formulas → `bestMatch: null`, `requiresManualSelection: true`.
   No candidate → `matched: false` with a warning. The engine never invents a formula.

`200` → `data`:

```json
{
  "context": { "breed": { "breedName": "Holstein Friesian", "…": "…" }, "stage": "Lactating", "purpose": "Milk Production", "season": "Summer", "seasonSource": "request", "weight": 520, "milkYield": 18, "targetADG": null, "animal": null },
  "matched": true,
  "bestMatch": { "formula": { "formulaCode": "FF-000001", "currentEstimatedDailyCost": 285, "…": "…" }, "score": 80, "explanation": ["Summer formula applied", "Weight 520 kg is within 450–600 kg", "…"], "warnings": [] },
  "requiresManualSelection": false,
  "candidates": [ "…same shape as bestMatch…" ],
  "totalCandidates": 1,
  "excluded": { "outOfWeightRange": 0, "outOfMilkYieldRange": 0 },
  "warnings": []
}
```

Candidate `warnings` flag retired/unavailable ingredients and unchecked ranges.

## GET `/api/v1/feed-formulas/:id`

Full specification: `breedId` populated (`breedCode breedName category purpose isActive`),
`ingredients[].ingredientId` populated with nutrition/price fields, `createdBy` / `updatedBy`
(`userId fullName`), plus:

- `nutritionUnits`
- `currentMetrics`: `{ expectedNutrition, estimatedDailyCost, costDifference, breakdown, totals }` re-priced
  with current ingredient data (the stored values remain the save-time snapshot)
- `warnings`: retired / unavailable / missing ingredients

Inactive formulas are readable here by any signed-in user (recommendation history links to them).

## GET `/api/v1/feed-formulas/:id/versions`

`{ context, current, versions[] }` — every formula with the same exact `(breedId, stage, purpose, season)`,
newest `ruleVersion` first. Non-admins see active ones plus the requested formula.

## GET `/api/v1/feed-formulas/:id/usage` (admin)

`{ _id, formulaCode, formulaName, usage: { feedRecommendations, total }, canHardDelete, scientificEditMode }`
(`scientificEditMode` is `in-place` or `new-version`).

## GET `/api/v1/feed-formulas/:id/audit-logs` (admin)

Paginated (`page`, `limit` ≤ 100) audit rows, newest first. Events: `Formula Created`, `Formula Updated`,
`Ingredient Changed`, `Target Range Changed`, `Rule Version Changed`, `Formula Version Created`,
`Formula Made Default`, `Formula Removed as Default`, `Formula Activated`, `Formula Deactivated`,
`Formula Deleted`.

## PUT `/api/v1/feed-formulas/:id`

Any subset of the create fields (except `isDefault`), plus `createNewVersion` / `retirePrevious`. `null`
clears `description`, `targetWeightRange`, `targetMilkYield`, `targetADG`.

| Change | Result (`data.mode`) |
|---|---|
| nothing differs from the stored values | `unchanged` (`200`) |
| only `formulaName` / `description` | `updated` in place (`200`) |
| scientific fields (context, targets, `ingredients`, `ruleVersion`) on a formula **not** referenced by any recommendation | `updated` in place, nutrition/cost recalculated (`200`) |
| scientific fields on a **referenced** formula, or `createNewVersion: true` | `versioned` (`201`): new record with a new `formulaCode`; `ruleVersion` from the body if it differs, else auto-bumped (`v1.0 → v1.1`) |

When versioned, `retirePrevious` (default `true`) retires the original and the default flag moves to the
new version (same context only). Response: `{ mode, formula, previous, usage?, warnings }`. If an in-place
edit moves a default formula to another context, it stops being the default.

## POST `/api/v1/feed-formulas/:id/clone-version`

Creates a new version record from the source; all body fields optional:

```json
{ "ruleVersion": "v2.0", "bump": "major", "ingredients": [ … ], "formulaName": "…", "retirePrevious": false, "isDefault": false }
```

- `ruleVersion` must differ from the source; omitted → bumped (`bump`: `minor` default, or `major`;
  `FEED-RULE-2026-01 → FEED-RULE-2026-02`).
- Stored ingredients are re-validated (retired/unavailable ones block the clone — send replacements).
- `retirePrevious` default `false`; `isDefault: true` makes the clone the context default.

`201` → `{ formula, previous, warnings }`.

## PATCH `/api/v1/feed-formulas/:id/set-default`

Body optional `{ "isDefault": true }` (default `true`). `true`: formula must be active; other active
defaults of the exact context are unset first (a partial unique index blocks races → `409`). `false`
removes the default flag.

## PATCH `/api/v1/feed-formulas/:id/toggle-active`

Body optional `{ "isActive": false, "reason": "…" }` (omitted `isActive` flips). Retiring also clears
`isDefault`; the record and its recommendations stay intact. Reactivating requires an active breed and no
retired ingredients (`409` otherwise — clone a new version instead).

## DELETE `/api/v1/feed-formulas/:id`

Default: soft-retire (same as `toggle-active` with `isActive: false`) → `{ mode: "retired", formula, usage }`.
`?hard=true`: permanent delete only when no FeedRecommendation references it, else `409`
→ `{ mode: "deleted", formula: null, usage }`.
