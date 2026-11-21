# Liventra Backend — Animals API (Model 05)

Base URL: `http://localhost:5000`

All endpoints require `Authorization: Bearer <accessToken>` and live under a farm:
`/api/v1/farms/:farmId/animals` (`:farmId` is the public `FARM-00001` code or the farm ObjectId).

Response envelope and error shape are the same as every other module:

```json
{ "success": true, "message": "<string>", "meta": { }, "data": { } }
{ "success": false, "message": "<string>", "errorSources": [ { "errorPath": "", "errorMessage": "<string>" } ] }
```

`Animal` is the farm's **current master snapshot** of one animal. History (weights, milk, health,
breeding, feed) belongs to its own collections; the animal itself is never hard-deleted.

## Enums

```text
gender:             Male | Female
purpose:            Dairy | Beef | Breeding | Dual Purpose
lifeStatus:         Active | Sold | Dead | Transferred | Archived
healthStatus:       Healthy | Sick | Under Treatment | Quarantine
reproductiveStatus: Calf | Heifer | Open | Pregnant | Lactating | Dry
```

Also served by `GET /animals/meta`, together with the allowed life-status transitions.

## Access control

Every request first passes `auth` (any logged-in, active platform user). The service then requires an
**active `FarmMember` row** in the target farm (platform `superAdmin` and the `Farm.ownerId` account act as
`Owner`; platform `admin` gets no bypass). An animal id from another farm returns **404**.

| Action | Owner | Manager | Worker | Veterinarian | Accountant |
|---|---|---|---|---|---|
| Read list / profile / lookup / stats / meta | ✅ | ✅ | ✅ | ✅ | ✅ |
| See `purchasePrice`, `supplierId` | ✅ | ✅ | ❌ | ❌ | ✅ |
| Register (`POST`) | ✅ | ✅ | ✅ | ❌ | ❌ |
| Edit profile (`PUT`), identification | ✅ | ✅ | ❌ | ❌ | ❌ |
| Location, media | ✅ | ✅ | ✅ | ❌ | ❌ |
| Lifecycle (`lifeStatus`) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Health / reproductive status | ✅ | ✅ | ❌ | ✅ | ❌ |
| Archive (`DELETE`) | ✅ | ❌ | ❌ | ❌ | ❌ |

Farm status rules:

- `Setup` farm — animals cannot be registered yet (403).
- `Inactive` / `Suspended` farm — all animal writes are blocked; reads still work.

Animal state rules:

- Only `lifeStatus = Active` animals accept profile, identification, location, media and status changes.
  Sold / Dead / Transferred / Archived records are read-only history.
- `isActive` is always derived from `lifeStatus` (`Active` ⇒ `true`, anything else ⇒ `false`).

## Field reference

| Field | Type | Writable via | Notes |
|---|---|---|---|
| `farmId` | ObjectId | — | from the URL, immutable |
| `breedId` | ObjectId | POST, PUT | must reference an **active** breed |
| `animalCode` | String | — | `AN-000001`, generated per farm, immutable, unique within the farm |
| `rfid` | String | POST, identification | optional, unique system-wide |
| `qrCode` | String | POST, identification | auto `QR-<farmCode>-<animalCode>` if not supplied, unique system-wide |
| `tagNumber` | String | POST, identification | optional, unique within the farm |
| `name`, `color` | String | POST, PUT | ≤ 100 chars |
| `gender` | Enum | POST | fixed after registration |
| `purpose` | Enum | POST, PUT | |
| `birthDate` | Date | POST, PUT | not in the future |
| `purchaseDate` | Date | POST, PUT | not in the future, not before `birthDate` |
| `purchasePrice` | Number | POST, PUT | ≥ 0, BDT, finance roles only on read |
| `supplierId` | ObjectId | POST, PUT | no Supplier module yet; finance roles only on read |
| `currentWeight` | Number | POST only | kg snapshot; later changes come from `WeightRecord` |
| `profilePhoto` | String | POST, media | http(s) URL or uploaded file |
| `gallery` | `[{ _id, url, caption, uploadedAt }]` | media | max 50 items |
| `location` | `{ shed, pen, stall }` | POST, location | current location only |
| `remarks` | String | POST, PUT, lifecycle | ≤ 2000 chars |
| `lifeStatus` | Enum | lifecycle, DELETE | always `Active` at registration |
| `healthStatus` | Enum | POST, status | defaults to `Healthy` |
| `reproductiveStatus` | Enum | POST (required), status | validated against gender + age |
| `createdBy` / `updatedBy` | ObjectId | — | set from the token |
| `isActive` | Boolean | — | synced with `lifeStatus` |

Every response that returns an animal also includes a computed **`age`** (never stored):

```json
"age": { "years": 2, "months": 8, "days": 6, "totalDays": 981, "totalMonths": 32, "label": "2 years 8 months" }
```

`age` is `null` when `birthDate` is unknown.

### Biological consistency

- `Male` cannot be `Heifer`, `Pregnant`, `Lactating` or `Dry`.
- An animal younger than 9 months (from `birthDate`) cannot be `Pregnant`, `Lactating` or `Dry`.

Checked on registration, on `PATCH /status`, and on `PUT` when `birthDate` changes.

---

## Endpoint summary

| Method | Endpoint | Access |
|---|---|---|
| POST | `/api/v1/farms/:farmId/animals` | Owner / Manager / Worker |
| GET | `/api/v1/farms/:farmId/animals` | Farm Member |
| GET | `/api/v1/farms/:farmId/animals/meta` | Farm Member |
| GET | `/api/v1/farms/:farmId/animals/stats` | Farm Member |
| GET | `/api/v1/farms/:farmId/animals/lookup/:identifier` | Farm Member |
| GET | `/api/v1/farms/:farmId/animals/:animalId` | Farm Member |
| PUT | `/api/v1/farms/:farmId/animals/:animalId` | Owner / Manager |
| PATCH | `/api/v1/farms/:farmId/animals/:animalId/identification` | Owner / Manager |
| PATCH | `/api/v1/farms/:farmId/animals/:animalId/location` | Owner / Manager / Worker |
| PATCH | `/api/v1/farms/:farmId/animals/:animalId/media` | Owner / Manager / Worker |
| PATCH | `/api/v1/farms/:farmId/animals/:animalId/lifecycle` | Owner / Manager |
| PATCH | `/api/v1/farms/:farmId/animals/:animalId/status` | Owner / Manager / Veterinarian |
| DELETE | `/api/v1/farms/:farmId/animals/:animalId` | Owner |

---

### 1. Register an animal

`POST /api/v1/farms/:farmId/animals` — JSON, or `multipart/form-data` with a `profilePhoto` file and the
JSON payload as a string in `data`.

```json
{
  "breedId": "665f1c2e9b1d4a0012ab34cd",
  "tagNumber": "BD-45892",
  "rfid": "RFID-8800123456",
  "name": "Maya",
  "gender": "Female",
  "purpose": "Dairy",
  "color": "Black and White",
  "birthDate": "2024-03-15",
  "purchaseDate": "2026-02-10",
  "purchasePrice": 185000,
  "currentWeight": 480,
  "location": { "shed": "Shed-A", "pen": "Pen-03", "stall": "Stall-12" },
  "healthStatus": "Healthy",
  "reproductiveStatus": "Heifer",
  "remarks": "Bought from local market"
}
```

**Required**: `breedId`, `gender`, `purpose`, `reproductiveStatus`.

Server behaviour:

- Generates `animalCode` (`AN-000001`, per farm, retried on collision) and, unless `qrCode` is sent,
  `qrCode = QR-<farmCode>-<animalCode>`.
- Sets `lifeStatus: Active`, `isActive: true`, `healthStatus: Healthy` (unless sent), `createdBy`.
- Ignores `animalCode`, `lifeStatus`, `isActive`, `gallery`, `createdBy` and any unknown key in the body.
- Rejects an inactive/missing breed, duplicate `rfid` / `qrCode` (system) or `tagNumber` (farm) with **409**.

Response **201** — the populated animal (see §4).

### 2. List animals

`GET /api/v1/farms/:farmId/animals`

| Query | Notes |
|---|---|
| `page`, `limit` | defaults 1 / 10, `limit` ≤ 100 |
| `searchTerm` | partial, case-insensitive on `animalCode`, `tagNumber`, `rfid`, `qrCode`, `name`, `color` |
| `lifeStatus`, `healthStatus`, `reproductiveStatus`, `purpose`, `gender` | exact; comma list allowed (`lifeStatus=Sold,Dead`) |
| `breedId` | ObjectId |
| `shed`, `pen`, `stall` | exact location match |
| `minWeight`, `maxWeight` | `currentWeight` range |
| `isActive` | `true` / `false` / `all` |
| `sort` | e.g. `-createdAt`, `animalCode`, `currentWeight` (`purchasePrice` only for finance roles) |

Default: only `isActive: true` animals. Passing `lifeStatus` or `isActive` overrides that, so
`?lifeStatus=Sold` returns sold animals. List items omit `gallery`; `breedId` is populated with
`breedCode breedName category purpose`; each item has `age`.

### 3. Meta and stats

- `GET /animals/meta` → enum arrays, `lifeStatusTransitions`, `femaleOnlyReproductiveStatuses`.
- `GET /animals/stats` →

```json
{
  "total": 125, "active": 110, "inactive": 15,
  "byLifeStatus": [ { "lifeStatus": "Active", "count": 110 }, "..." ],
  "byHealthStatus": [ { "healthStatus": "Healthy", "count": 96 }, "..." ],
  "byReproductiveStatus": [ "..." ], "byPurpose": [ "..." ], "byGender": [ "..." ],
  "byBreed": [ { "breedId": "...", "breedCode": "BREED-00001", "breedName": "Holstein Friesian", "count": 40 } ]
}
```

`byLifeStatus` counts every animal; the other breakdowns count active animals only.

### 4. Get one animal

`GET /api/v1/farms/:farmId/animals/:animalId` — full profile including `gallery`, populated `breedId`,
`farmId` (`farmId farmName status`), `createdBy` / `updatedBy` (`userId fullName`) and `age`.

### 5. Scanner lookup

`GET /api/v1/farms/:farmId/animals/lookup/:identifier` — exact match inside the farm on `animalCode`
(case-insensitive), `rfid`, `qrCode` or `tagNumber`. Finds inactive animals too (the response shows their
`lifeStatus`). If several animals match different fields, priority is `animalCode > rfid > qrCode > tagNumber`.

```json
{ "matchedBy": "rfid", "animal": { "...": "full profile" } }
```

### 6. Update profile

`PUT /api/v1/farms/:farmId/animals/:animalId` — any subset of
`name, breedId, purpose, color, birthDate, purchaseDate, purchasePrice, supplierId, remarks`.
`null` or `""` clears an optional field. Sending `animalCode`, `currentWeight`, `lifeStatus`, `isActive`
or `farmId` returns **400**; other unknown keys are ignored.

### 7. Identification

`PATCH /animals/:animalId/identification`

```json
{ "rfid": "RFID-001258963", "tagNumber": "BD-45893", "qrCode": "QR-CUSTOM-1", "regenerateQrCode": false }
```

`rfid` / `tagNumber` may be `null` to remove. `qrCode` cannot be removed; `regenerateQrCode: true`
restores the default `QR-<farmCode>-<animalCode>`.

### 8. Location

`PATCH /animals/:animalId/location` — `{ "shed": "Shed-B", "pen": "Pen-01", "stall": "Stall-04" }`.
Replaces the whole current location (at least one key required).

### 9. Media

`PATCH /animals/:animalId/media` — JSON or multipart.

```text
profilePhoto: <file>               (optional, 1)
gallery:      <file> x up to 10    (optional)
data: {
  "profilePhoto": "https://..." | null,        // ignored when a profilePhoto file is sent; null removes
  "galleryCaptions": ["Front view", "Side"],   // captions for uploaded gallery files, same order
  "galleryAdd": [ { "url": "https://...", "caption": "Injury" } ],
  "galleryRemove": ["<gallery item _id>"]
}
```

Only image files and http(s) URLs are accepted; max 50 gallery items per animal.

### 10. Lifecycle

`PATCH /animals/:animalId/lifecycle` — `{ "lifeStatus": "Sold", "remarks": "Sold at Eid market" }`

| From | Allowed to |
|---|---|
| Active | Sold, Dead, Transferred, Archived |
| Archived | Active (reactivation) |
| Sold / Dead / Transferred | — (final) |

`isActive` is synced automatically. History is never deleted.

### 11. Health / reproductive status

`PATCH /animals/:animalId/status` — `{ "healthStatus": "Quarantine" }` and/or
`{ "reproductiveStatus": "Pregnant" }`. Enforces the gender/age rules above. Must differ from the current value.

### 12. Archive (soft delete)

`DELETE /api/v1/farms/:farmId/animals/:animalId` — Owner only. Sets `lifeStatus: Archived`,
`isActive: false`. Only `Active` animals can be archived (Sold/Dead/Transferred keep their real exit reason).
Reactivate through `PATCH /lifecycle` with `{ "lifeStatus": "Active" }`.

---

## Not implemented yet (depends on later models)

- **AuditLog** (Model 24) — no `oldData/newData/changedFields` entries are written yet; `TODO(AuditLog)` markers sit in the service.
- **WeightRecord** (Model 11) — registration does not create the initial weight record yet; `currentWeight` is only settable at registration.
- **DeviceAssignment** (Model 26) — lifecycle exits do not close IoT assignments yet.
- **Income** (Model 22) — selling does not create an income record.
- **Supplier** — `supplierId` is stored as a plain ObjectId with no existence check.
