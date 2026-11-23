# Liventra Backend — Breeds API (Model 04)

Base URL: `http://localhost:5000`

All endpoints require `Authorization: Bearer <accessToken>`.

Common response envelope (via `sendResponse`):

```json
{ "success": true, "message": "<string>", "data": { } }
```

List endpoints also return a `meta` object. Errors come from `globalErrorHandler`:

```json
{ "success": false, "message": "<string>", "errorSources": [ { "errorPath": "", "errorMessage": "<string>" } ] }
```

Breed is **global master/reference data**: it has no `farmId`, is not guarded by `FarmMember`, and is
referenced by `Animal.breedId` and `FeedFormula.breedId`. Breeds are normally **deactivated** (suspended)
so existing animal and formula records keep working; an admin may **permanently delete** a breed only
when no animal or feed formula references it (`DELETE /breeds/:id?hard=true`).

## Enums

```text
category:          Indigenous | Crossbreed | Exotic
purpose:           Dairy | Beef | Dual Purpose | Breeding
heatTolerance:     Low | Medium | High
diseaseResistance: Low | Medium | High
temperament:       Calm | Moderate | Aggressive
```

These arrays are also served by `GET /api/v1/breeds/meta`, so the frontend does not need to hardcode them.

## Roles

- `user` — read-only access (list, lookup, meta, get by id/code), enough to select a breed while
  registering or editing an animal.
- `admin` / `superAdmin` — create, update, change the image and activate/deactivate breeds.
- Farm membership roles are irrelevant here; breed management is centralized on purpose, so farms
  cannot create spelling variants of the same breed.

## Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `breedCode` | String | auto | `BREED-00001`; immutable, system-generated |
| `breedName` | String | yes | 2–100 chars, case-insensitively unique |
| `origin` | String | yes | 1–100 chars |
| `category` | Enum | yes | see enums |
| `purpose` | Enum | yes | see enums |
| `averageMilkPerDay` | Number | no | ≥ 0; reference litres/day, **not** actual production |
| `averageAdultWeight` | Number | no | > 0; reference kg |
| `averageDailyFeed` | Number | no | ≥ 0; reference feed amount/day |
| `heatTolerance` | Enum | no | see enums |
| `temperament` | Enum | no | see enums |
| `colorPattern` | String | no | ≤ 100 chars, visual description |
| `image` | String | no | URL / Cloudinary path |
| `diseaseResistance` | Enum | no | see enums |
| `isNative` | Boolean | auto | defaults to `false` |
| `description` | String | no | ≤ 2000 chars |
| `isActive` | Boolean | auto | defaults to `true` |

Breed-level values are reference data only. Actual milk, weight, feeding and health belong to
`MilkRecord`, `WeightRecord`, `FeedRecord` and the animal/health modules.

---

## Endpoint summary

| Method | Endpoint | Access |
|---|---|---|
| POST | `/api/v1/breeds` | `admin` / `superAdmin` |
| GET | `/api/v1/breeds` | Any authenticated user |
| GET | `/api/v1/breeds/lookup` | Any authenticated user |
| GET | `/api/v1/breeds/meta` | Any authenticated user |
| GET | `/api/v1/breeds/stats` | Any authenticated user |
| GET | `/api/v1/breeds/code/:breedCode` | Any authenticated user |
| GET | `/api/v1/breeds/:id` | Any authenticated user |
| PATCH | `/api/v1/breeds/:id` | `admin` / `superAdmin` |
| PATCH | `/api/v1/breeds/:id/image` | `admin` / `superAdmin` |
| PATCH | `/api/v1/breeds/:id/status` | `admin` / `superAdmin` |
| GET | `/api/v1/breeds/:id/usage` | `admin` / `superAdmin` |
| DELETE | `/api/v1/breeds/:id` | `admin` / `superAdmin` |

---

### 1. Create a breed

- **URL**: `POST /api/v1/breeds`
- **Access**: `admin` / `superAdmin`
- **Headers**: `application/json`, or `multipart/form-data` when sending an `image` file

JSON body:

```json
{
  "breedName": "Holstein Friesian",
  "origin": "Netherlands",
  "category": "Exotic",
  "purpose": "Dairy",
  "averageMilkPerDay": 18,
  "averageAdultWeight": 550,
  "averageDailyFeed": 22,
  "heatTolerance": "Low",
  "temperament": "Calm",
  "colorPattern": "Black and white",
  "image": "https://res.cloudinary.com/.../holstein.jpg",
  "diseaseResistance": "Medium",
  "isNative": false,
  "description": "High-yield dairy breed used in intensive milk production systems.",
  "isActive": true
}
```

Multipart alternative — the image file goes in the `image` field and the same JSON payload is
serialised into the `data` field (the `image` key inside `data` is optional):

```text
image: <file>                      (optional)
data:  {"breedName":"Holstein Friesian","origin":"Netherlands","category":"Exotic","purpose":"Dairy"}
```

Image resolution priority:

1. `image` file — checked and uploaded to Cloudinary; the returned `secure_url` is stored and the
   local temp file is deleted.
2. `image` URL in the body — stored as-is when no file is sent.
3. Otherwise `image` is stored as an empty string.

A non-file request with `Content-Type: application/json` behaves exactly as before.

**Required**: `breedName`, `origin`, `category`, `purpose`.

**Optional**: `averageMilkPerDay`, `averageAdultWeight`, `averageDailyFeed`, `heatTolerance`,
`temperament`, `colorPattern`, `image`, `diseaseResistance`, `isNative` (default `false`),
`description`, `isActive` (default `true`).

Business rules:

- `breedCode` is generated by the server (`BREED-00001`, last row + 1), is immutable, and is **never**
  accepted from the client. Any `breedCode`, `_id`, `createdAt` or `updatedAt` in the body is ignored.
- `breedName` is unique case-insensitively (`"Holstein Friesian"` / `"Holstein friesen"` collide → `409`).
- `averageAdultWeight` must be > 0; the other reference numbers must be ≥ 0.
- Enum values are validated twice: by Zod at the route and again in the service (the Zod result is
  discarded, so the service works from the raw body).
- Creating a breed has no effect on existing animals or historical feed recommendations.

**Successful response** (201):

```json
{
  "success": true,
  "message": "Breed created successfully!",
  "data": {
    "_id": "6710b2c3d4e5f6a7b8c9d0e1",
    "breedCode": "BREED-00001",
    "breedName": "Holstein Friesian",
    "origin": "Netherlands",
    "category": "Exotic",
    "purpose": "Dairy",
    "averageMilkPerDay": 18,
    "averageAdultWeight": 550,
    "averageDailyFeed": 22,
    "heatTolerance": "Low",
    "temperament": "Calm",
    "colorPattern": "Black and white",
    "image": "https://res.cloudinary.com/.../holstein.jpg",
    "diseaseResistance": "Medium",
    "isNative": false,
    "description": "High-yield dairy breed used in intensive milk production systems.",
    "isActive": true,
    "createdAt": "2026-11-07T10:15:00.000Z",
    "updatedAt": "2026-11-07T10:15:00.000Z"
  }
}
```

---

### 2. List breeds

- **URL**: `GET /api/v1/breeds`
- **Access**: Any authenticated user

Query parameters:

| Parameter | Notes |
|---|---|
| `searchTerm` | Case-insensitive match on `breedName`, `breedCode`, `origin`, `colorPattern` |
| `category` | Exact enum match |
| `purpose` | Exact enum match |
| `origin` | Exact string match |
| `isNative` | `true` / `false` |
| `heatTolerance` | Exact enum match |
| `temperament` | Exact enum match |
| `diseaseResistance` | Exact enum match |
| `isActive` | `true` (default) / `false` / `all` — `false` and `all` are honoured for `admin`/`superAdmin` only; everyone else is forced to `true` |
| `sort` | Comma list; allowed: `breedName`, `breedCode`, `origin`, `category`, `purpose`, `averageMilkPerDay`, `averageAdultWeight`, `averageDailyFeed`, `isNative`, `isActive`, `createdAt`, `updatedAt`. Prefix `-` for descending. Default `breedName` |
| `page` | Default `1` |
| `limit` | Default `10`, max `100` |
| `fields` | Comma list, e.g. `fields=breedCode,breedName,category,purpose` |

Unknown filter keys and unknown sort fields are dropped. The search term is regex-escaped, so user
input is matched literally.

Deactivated breeds are hidden by default: they must not appear in animal-registration selectors, but
they remain retrievable by id or code and existing animals keep their reference.

**Successful response** (200):

```json
{
  "success": true,
  "message": "Breeds retrieved successfully!",
  "meta": { "page": 1, "limit": 10, "totalEntries": 1, "totalPage": 1 },
  "data": [
    {
      "_id": "6710b2c3d4e5f6a7b8c9d0e1",
      "breedCode": "BREED-00001",
      "breedName": "Holstein Friesian",
      "origin": "Netherlands",
      "category": "Exotic",
      "purpose": "Dairy",
      "averageMilkPerDay": 18,
      "averageAdultWeight": 550,
      "isNative": false,
      "isActive": true
    }
  ]
}
```

---

### 3. Breed lookup (selector payload)

- **URL**: `GET /api/v1/breeds/lookup`
- **Access**: Any authenticated user

Lightweight, active-only payload for dropdowns in animal registration/editing and feed-formula screens.

Query parameters: `searchTerm` (matches `breedName` / `breedCode`), `category`, `purpose`.

Always sorted by `breedName`, capped at 200 rows, and projected to
`_id`, `breedCode`, `breedName`, `category`, `purpose`, `isNative`.

**Successful response** (200):

```json
{
  "success": true,
  "message": "Breed lookup retrieved successfully!",
  "data": [
    {
      "_id": "6710b2c3d4e5f6a7b8c9d0e1",
      "breedCode": "BREED-00001",
      "breedName": "Holstein Friesian",
      "category": "Exotic",
      "purpose": "Dairy",
      "isNative": false
    }
  ]
}
```

---

### 4. Breed metadata

- **URL**: `GET /api/v1/breeds/meta`
- **Access**: Any authenticated user

Returns the enum arrays straight from `breed.constants.ts` so the UI has a single source of truth.

**Successful response** (200):

```json
{
  "success": true,
  "message": "Breed metadata retrieved successfully!",
  "data": {
    "categories": ["Indigenous", "Crossbreed", "Exotic"],
    "purposes": ["Dairy", "Beef", "Dual Purpose", "Breeding"],
    "resistanceLevels": ["Low", "Medium", "High"],
    "temperaments": ["Calm", "Moderate", "Aggressive"]
  }
}
```

---

### 5. Breed statistics

- **URL**: `GET /api/v1/breeds/stats`
- **Access**: Any authenticated user

Distribution across the **breed master list** (inactive breeds included). Three aggregations run in
parallel; category/purpose buckets are returned in enum order and include `count: 0` for values that
are not used yet.

**Successful response** (200):

```json
{
  "success": true,
  "message": "Breed statistics retrieved successfully!",
  "data": {
    "total": 42,
    "active": 40,
    "inactive": 2,
    "nativeCount": 12,
    "nonNativeCount": 30,
    "byCategory": [
      { "category": "Indigenous", "count": 15 },
      { "category": "Crossbreed", "count": 12 },
      { "category": "Exotic", "count": 15 }
    ],
    "byPurpose": [
      { "purpose": "Dairy", "count": 20 },
      { "purpose": "Beef", "count": 8 },
      { "purpose": "Dual Purpose", "count": 9 },
      { "purpose": "Breeding", "count": 5 }
    ]
  }
}
```

Animal-derived analytics (animals per breed, average milk/weight per breed, health/feed-cost by
breed) are **not** part of this endpoint — they must be computed from `Animal`, `MilkRecord` and
`WeightRecord` once those modules exist, never stored as counters on `Breed`.

---

### 6. Get a breed by id

- **URL**: `GET /api/v1/breeds/:id`
- **Access**: Any authenticated user

`:id` is the Mongo ObjectId. Both active and inactive breeds are returned (an inactive breed must still
be viewable from an existing animal's profile). Invalid ids → `400`; unknown ids → `404`.

**Successful response** (200): a single breed object as in the create response.

---

### 7. Get a breed by code

- **URL**: `GET /api/v1/breeds/code/:breedCode`
- **Access**: Any authenticated user

`:breedCode` is case-insensitive (`breed-00001` works). Useful for deep links, printed reports and
support conversations. Unknown codes → `404`.

**Successful response** (200): a single breed object.

---

### 8. Update a breed

- **URL**: `PATCH /api/v1/breeds/:id`
- **Access**: `admin` / `superAdmin`
- **Headers**: `Content-Type: application/json`

Any subset of the creation fields:

```json
{
  "averageAdultWeight": 560,
  "temperament": "Moderate",
  "description": "Updated reference notes."
}
```

Business rules:

- Updatable: `breedName`, `origin`, `category`, `purpose`, `averageMilkPerDay`, `averageAdultWeight`,
  `averageDailyFeed`, `heatTolerance`, `temperament`, `colorPattern`, `image`, `diseaseResistance`,
  `isNative`, `description`.
- **Not** updatable here: `breedCode`, `_id`, `createdAt`, `updatedAt`. `isActive` is handled by
  `PATCH /:id/status`; a value sent here is ignored.
- Renaming to a name already used by another breed (case-insensitive) → `409`.
- At least one updatable field is required (`400` otherwise).
- Changing reference values never rewrites historical `FeedRecommendation` records; only future
  recommendations use the new values.

**Successful response** (200): the updated breed object.

---

### 9. Update the breed image

- **URL**: `PATCH /api/v1/breeds/:id/image`
- **Access**: `admin` / `superAdmin`
- **Headers**: `Content-Type: multipart/form-data` (file) or `application/json` (URL)

Provide either:

- form field `image` — image file, uploaded to Cloudinary (the local temp file is deleted), or
- JSON body `{ "image": "https://res.cloudinary.com/.../breed.png" }`.

If both are sent the uploaded file wins. Providing neither returns `400`.

**Successful response** (200): the updated breed object with the new `image` URL.

---

### 10. Activate / deactivate a breed

- **URL**: `PATCH /api/v1/breeds/:id/status`
- **Access**: `admin` / `superAdmin`
- **Headers**: `Content-Type: application/json`

```json
{ "isActive": false }
```

- `true` — the breed is selectable again for new animals and feed formulas.
- `false` — the breed disappears from `GET /breeds` (default view) and from `/lookup`, but existing
  animals, formulas and historical recommendations keep their reference.
- Idempotent: setting the current value succeeds.

**Successful response** (200): `"Breed deactivated successfully!"` or `"Breed activated successfully!"`
with the updated breed object.

---

### Breed usage

- **URL**: `GET /api/v1/breeds/:id/usage`
- **Access**: `admin` / `superAdmin`

Reference counts used by the delete dialog to decide whether a permanent delete is allowed.

```json
{
  "success": true,
  "message": "Breed usage retrieved successfully!",
  "data": {
    "_id": "6710a1c2a1b2c3d4e5f60701",
    "breedCode": "BREED-00001",
    "breedName": "Red Chittagong",
    "isActive": true,
    "usage": { "animals": 0, "feedFormulas": 0, "total": 0 },
    "canHardDelete": true
  }
}
```

---

### Delete a breed (suspend or permanent)

- **URL**: `DELETE /api/v1/breeds/:id` (optional `?hard=true`)
- **Access**: `admin` / `superAdmin`

| Mode | Behaviour |
|---|---|
| default (no `hard`) | **Suspend** — sets `isActive: false` (same as `PATCH /:id/status`). Idempotent. |
| `?hard=true` | **Permanent** — removes the breed document from the database. Allowed only when `usage.total === 0`; otherwise `409`. Written to the audit log (`Breed Permanently Deleted`). |

```json
{
  "success": true,
  "message": "Breed permanently deleted!",
  "data": { "mode": "deleted", "breed": null, "usage": { "animals": 0, "feedFormulas": 0, "total": 0 } }
}
```

A suspend returns `"mode": "deactivated"` with the updated breed and the message
`"Breed deactivated (suspended) successfully!"`.

---

## Errors

| Scenario | Status | Message |
|---|---|---|
| Validation failure | 400 | `Validation Error` + `errorSources` |
| Malformed ObjectId | 400 | `Invalid breed id!` |
| No / invalid token | 401 | `You're not authorized!` |
| Non-admin write attempt | 403 | `You're not authorized!` |
| Unknown breed | 404 | `Breed not found!` |
| Permanent delete of a referenced breed | 409 | `Cannot permanently delete: breed is used by N animal(s) and M feed formula(s). Deactivate it instead.` |
| Duplicate breed name | 409 | `Breed name already exists!` |
| Duplicate breed code (retry) | 409 | `Breed code already exists, please retry!` |

## Implementation notes

- `breedCode` is generated by `generateBreedCode()` in `breed.utils.ts` using
  `findOne().sort({ createdAt: -1 })`; the unique index is the final guard against collisions.
- The `breedName` unique index uses `collation: { locale: "en", strength: 2 }`, so lookups that filter
  by name should apply the same collation.
- `validateRequest()` only validates `{ body, cookies }` and discards the parsed result, so the service
  whitelists fields, trims text, coerces numbers and re-checks enums from the raw body.
- `GET /breeds/stats` reports the breed **master-list** distribution (totals, active/inactive,
  native split, by category and purpose). Animal-derived analytics (animals per breed, average
  milk/weight) still require `Animal`, `MilkRecord` and `WeightRecord`, so `GET /breeds/:id/animals`
  ships with Model 05.
