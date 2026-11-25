# Liventra Backend — Animals API (Model 05)

Base URL: `http://localhost:5000`

All endpoints require `Authorization: Bearer <accessToken>` and live under a farm:
`/api/v1/farms/:farmId/animals` (`:farmId` is the public `FARM-00001` code or the farm ObjectId).

Response envelope and error shape are the same as every other module:

```json
{ "success": true, "message": "<string>", "meta": { }, "data": { } }
{ "success": false, "message": "<string>", "errorSources": [ { "errorPath": "", "errorMessage": "<string>" } ], "err": { }, "stack": null }
```

`meta` is only present on the list endpoint. `stack` is filled only when `NODE_ENV=development`.
The error samples below omit `err` and `stack` for brevity.

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

### Common errors (any endpoint)

| Status | `message` | When |
|---|---|---|
| 403 | `You're not authorized!` | missing token (from `auth`) |
| 401 | `You're not authorized!` | invalid token (from `auth`) |
| 403 | `Your token is expired!` | expired token |
| 404 | `-User not found or inactive!` | token user missing or deactivated |
| 403 | `You are not an active member of this farm!` | no active `FarmMember` row |
| 403 | `Your farm role (Worker) is not allowed to <action>!` | role lacks the permission in the table above |
| 403 | `This farm is inactive — animal records are read-only!` | write on an `Inactive` / `Suspended` farm |
| 400 | `Invalid animal id!` | `:animalId` is not an ObjectId |
| 404 | `Animal not found!` | no such animal **in this farm** |
| 409 | `Animal is Sold — its record is read-only. Reactivate it first if it was archived.` | write on a non-`Active` animal |
| 409 | `RFID is already assigned to another animal!` | also `QR code …` / `Tag number …` |

```json
{
  "success": false,
  "message": "Your farm role (Worker) is not allowed to change an animal's life status!",
  "errorSources": [
    { "errorPath": "", "errorMessage": "Your farm role (Worker) is not allowed to change an animal's life status!" }
  ]
}
```

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

Optional fields that were never set (or were cleared) are **absent** from the response, not `null`.
`updatedBy` only appears after the first update.

### Biological consistency

- `Male` cannot be `Heifer`, `Pregnant`, `Lactating` or `Dry`.
- An animal younger than 9 months (from `birthDate`) cannot be `Pregnant`, `Lactating` or `Dry`.

Checked on registration, on `PATCH /status`, and on `PUT` when `birthDate` changes.

### Sample animal object (detail)

Returned as `data` by register, get-one, every `PUT`/`PATCH`, and `DELETE`
(and as `data.animal` by lookup). Populated references:
`breedId` → `breedCode breedName category purpose image isActive`,
`farmId` → `farmId farmName status`, `createdBy` / `updatedBy` → `userId fullName`.

```json
{
  "_id": "6740a1f2c3d4e5f601234567",
  "farmId": {
    "_id": "6731b0e1a2b3c4d5e6f70011",
    "farmId": "FARM-00001",
    "farmName": "Green Valley Dairy",
    "status": "Active"
  },
  "breedId": {
    "_id": "665f1c2e9b1d4a0012ab34cd",
    "breedCode": "BREED-00001",
    "breedName": "Holstein Friesian",
    "category": "Exotic",
    "purpose": "Dairy",
    "image": "https://res.cloudinary.com/<cloud>/image/upload/v1/breeds/holstein.jpg",
    "isActive": true
  },
  "animalCode": "AN-000001",
  "rfid": "RFID-8800123456",
  "qrCode": "QR-FARM-00001-AN-000001",
  "tagNumber": "BD-45892",
  "name": "Maya",
  "gender": "Female",
  "purpose": "Dairy",
  "color": "Black and White",
  "birthDate": "2024-03-15T00:00:00.000Z",
  "purchaseDate": "2026-02-10T00:00:00.000Z",
  "purchasePrice": 185000,
  "currentWeight": 480,
  "profilePhoto": "https://res.cloudinary.com/<cloud>/image/upload/v1/FARM-00001-AN-000001-profile.jpg",
  "gallery": [],
  "location": { "shed": "Shed-A", "pen": "Pen-03", "stall": "Stall-12" },
  "remarks": "Bought from local market",
  "lifeStatus": "Active",
  "healthStatus": "Healthy",
  "reproductiveStatus": "Heifer",
  "createdBy": { "_id": "6720f0a1b2c3d4e5f6a70001", "userId": "U-25-0001", "fullName": "Rahim Uddin" },
  "isActive": true,
  "createdAt": "2026-11-21T08:30:12.345Z",
  "updatedAt": "2026-11-21T08:30:12.345Z",
  "age": { "years": 2, "months": 8, "days": 6, "totalDays": 981, "totalMonths": 32, "label": "2 years 8 months" }
}
```

For Worker / Veterinarian callers `purchasePrice` and `supplierId` are removed from every animal object.

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

**Request**

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

**Response 201**

```json
{
  "success": true,
  "message": "Animal registered successfully!",
  "data": {
    "_id": "6740a1f2c3d4e5f601234567",
    "farmId": { "_id": "6731b0e1a2b3c4d5e6f70011", "farmId": "FARM-00001", "farmName": "Green Valley Dairy", "status": "Active" },
    "breedId": { "_id": "665f1c2e9b1d4a0012ab34cd", "breedCode": "BREED-00001", "breedName": "Holstein Friesian", "category": "Exotic", "purpose": "Dairy", "image": "https://res.cloudinary.com/<cloud>/image/upload/v1/breeds/holstein.jpg", "isActive": true },
    "animalCode": "AN-000001",
    "rfid": "RFID-8800123456",
    "qrCode": "QR-FARM-00001-AN-000001",
    "tagNumber": "BD-45892",
    "name": "Maya",
    "gender": "Female",
    "purpose": "Dairy",
    "color": "Black and White",
    "birthDate": "2024-03-15T00:00:00.000Z",
    "purchaseDate": "2026-02-10T00:00:00.000Z",
    "purchasePrice": 185000,
    "currentWeight": 480,
    "gallery": [],
    "location": { "shed": "Shed-A", "pen": "Pen-03", "stall": "Stall-12" },
    "remarks": "Bought from local market",
    "lifeStatus": "Active",
    "healthStatus": "Healthy",
    "reproductiveStatus": "Heifer",
    "createdBy": { "_id": "6720f0a1b2c3d4e5f6a70001", "userId": "U-25-0001", "fullName": "Rahim Uddin" },
    "isActive": true,
    "createdAt": "2026-11-21T08:30:12.345Z",
    "updatedAt": "2026-11-21T08:30:12.345Z",
    "age": { "years": 2, "months": 8, "days": 6, "totalDays": 981, "totalMonths": 32, "label": "2 years 8 months" }
  }
}
```

**Typical errors**

| Status | `message` |
|---|---|
| 400 | `gender must be one of: Male, Female!` *(enum check; same wording for other enums)* |
| 400 | `A male animal cannot have reproductive status 'Pregnant'!` |
| 400 | `An animal younger than 9 months cannot be 'Lactating'!` |
| 400 | `purchaseDate cannot be earlier than birthDate!` |
| 400 | `birthDate cannot be in the future!` |
| 400 | `This breed is deactivated and cannot be assigned to animals!` |
| 403 | `Animals cannot be added while the farm is still in Setup status!` |
| 404 | `Breed not found!` |
| 409 | `Tag number is already assigned to another animal!` |

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
`breedCode breedName category purpose`; `farmId` and `createdBy` / `updatedBy` stay as plain ids;
each item has `age`.

**Request**

```text
GET /api/v1/farms/FARM-00001/animals?page=1&limit=2&healthStatus=Healthy&shed=Shed-A&sort=animalCode
```

**Response 200** (as seen by a Worker — no `purchasePrice` / `supplierId`)

```json
{
  "success": true,
  "message": "Animals retrieved successfully!",
  "meta": { "page": 1, "limit": 2, "totalEntries": 37, "totalPage": 19 },
  "data": [
    {
      "_id": "6740a1f2c3d4e5f601234567",
      "farmId": "6731b0e1a2b3c4d5e6f70011",
      "breedId": { "_id": "665f1c2e9b1d4a0012ab34cd", "breedCode": "BREED-00001", "breedName": "Holstein Friesian", "category": "Exotic", "purpose": "Dairy" },
      "animalCode": "AN-000001",
      "rfid": "RFID-8800123456",
      "qrCode": "QR-FARM-00001-AN-000001",
      "tagNumber": "BD-45892",
      "name": "Maya",
      "gender": "Female",
      "purpose": "Dairy",
      "color": "Black and White",
      "birthDate": "2024-03-15T00:00:00.000Z",
      "purchaseDate": "2026-02-10T00:00:00.000Z",
      "currentWeight": 480,
      "location": { "shed": "Shed-A", "pen": "Pen-03", "stall": "Stall-12" },
      "lifeStatus": "Active",
      "healthStatus": "Healthy",
      "reproductiveStatus": "Heifer",
      "createdBy": "6720f0a1b2c3d4e5f6a70001",
      "isActive": true,
      "createdAt": "2026-11-21T08:30:12.345Z",
      "updatedAt": "2026-11-21T08:30:12.345Z",
      "age": { "years": 2, "months": 8, "days": 6, "totalDays": 981, "totalMonths": 32, "label": "2 years 8 months" }
    },
    {
      "_id": "6740a2a8c3d4e5f601234590",
      "farmId": "6731b0e1a2b3c4d5e6f70011",
      "breedId": { "_id": "665f1d3a9b1d4a0012ab34ce", "breedCode": "BREED-00004", "breedName": "Red Chittagong", "category": "Indigenous", "purpose": "Dual Purpose" },
      "animalCode": "AN-000002",
      "qrCode": "QR-FARM-00001-AN-000002",
      "gender": "Male",
      "purpose": "Beef",
      "location": { "shed": "Shed-A", "pen": "Pen-05" },
      "lifeStatus": "Active",
      "healthStatus": "Healthy",
      "reproductiveStatus": "Calf",
      "createdBy": "6720f0a1b2c3d4e5f6a70001",
      "isActive": true,
      "createdAt": "2026-11-21T08:41:03.120Z",
      "updatedAt": "2026-11-21T08:41:03.120Z",
      "age": null
    }
  ]
}
```

**Typical errors**: `400 lifeStatus must be one of: …!`, `400 breedId must be a valid id!`,
`400 Animals cannot be sorted by 'purchasePrice'!` (non-finance role or unknown field),
`400 minWeight must be a non-negative number!`.

### 3. Meta and stats

#### `GET /animals/meta`

**Response 200**

```json
{
  "success": true,
  "message": "Animal metadata retrieved successfully!",
  "data": {
    "genders": ["Male", "Female"],
    "purposes": ["Dairy", "Beef", "Breeding", "Dual Purpose"],
    "lifeStatuses": ["Active", "Sold", "Dead", "Transferred", "Archived"],
    "healthStatuses": ["Healthy", "Sick", "Under Treatment", "Quarantine"],
    "reproductiveStatuses": ["Calf", "Heifer", "Open", "Pregnant", "Lactating", "Dry"],
    "lifeStatusTransitions": {
      "Active": ["Sold", "Dead", "Transferred", "Archived"],
      "Archived": ["Active"],
      "Sold": [],
      "Dead": [],
      "Transferred": []
    },
    "femaleOnlyReproductiveStatuses": ["Heifer", "Pregnant", "Lactating", "Dry"]
  }
}
```

#### `GET /animals/stats`

`byLifeStatus` counts every animal; the other breakdowns count active animals only. Enum buckets are
always listed in enum order and include zero counts; `byBreed` is sorted by count, descending.

**Response 200**

```json
{
  "success": true,
  "message": "Animal statistics retrieved successfully!",
  "data": {
    "total": 125,
    "active": 110,
    "inactive": 15,
    "byLifeStatus": [
      { "lifeStatus": "Active", "count": 110 },
      { "lifeStatus": "Sold", "count": 9 },
      { "lifeStatus": "Dead", "count": 2 },
      { "lifeStatus": "Transferred", "count": 0 },
      { "lifeStatus": "Archived", "count": 4 }
    ],
    "byHealthStatus": [
      { "healthStatus": "Healthy", "count": 96 },
      { "healthStatus": "Sick", "count": 6 },
      { "healthStatus": "Under Treatment", "count": 5 },
      { "healthStatus": "Quarantine", "count": 3 }
    ],
    "byReproductiveStatus": [
      { "reproductiveStatus": "Calf", "count": 22 },
      { "reproductiveStatus": "Heifer", "count": 18 },
      { "reproductiveStatus": "Open", "count": 20 },
      { "reproductiveStatus": "Pregnant", "count": 25 },
      { "reproductiveStatus": "Lactating", "count": 19 },
      { "reproductiveStatus": "Dry", "count": 6 }
    ],
    "byPurpose": [
      { "purpose": "Dairy", "count": 70 },
      { "purpose": "Beef", "count": 25 },
      { "purpose": "Breeding", "count": 5 },
      { "purpose": "Dual Purpose", "count": 10 }
    ],
    "byGender": [
      { "gender": "Male", "count": 30 },
      { "gender": "Female", "count": 80 }
    ],
    "byBreed": [
      { "breedId": "665f1c2e9b1d4a0012ab34cd", "breedCode": "BREED-00001", "breedName": "Holstein Friesian", "count": 40 },
      { "breedId": "665f1d3a9b1d4a0012ab34ce", "breedCode": "BREED-00004", "breedName": "Red Chittagong", "count": 35 }
    ]
  }
}
```

### 4. Get one animal

`GET /api/v1/farms/:farmId/animals/:animalId` — full profile including `gallery`, populated `breedId`,
`farmId` (`farmId farmName status`), `createdBy` / `updatedBy` (`userId fullName`) and `age`.

**Request**

```text
GET /api/v1/farms/FARM-00001/animals/6740a1f2c3d4e5f601234567
```

**Response 200**

```json
{
  "success": true,
  "message": "Animal retrieved successfully!",
  "data": { "...": "sample animal object (detail), see above" }
}
```

**Errors**: `400 Invalid animal id!`, `404 Animal not found!` (also for an animal of another farm).

### 5. Scanner lookup

`GET /api/v1/farms/:farmId/animals/lookup/:identifier` — exact match inside the farm on `animalCode`
(case-insensitive), `rfid`, `qrCode` or `tagNumber`. Finds inactive animals too (the response shows their
`lifeStatus`). If several animals match different fields, priority is `animalCode > rfid > qrCode > tagNumber`.

**Request**

```text
GET /api/v1/farms/FARM-00001/animals/lookup/RFID-8800123456
```

**Response 200** — `message` names the field that matched.

```json
{
  "success": true,
  "message": "Animal found by rfid!",
  "data": {
    "matchedBy": "rfid",
    "animal": { "...": "sample animal object (detail), see above" }
  }
}
```

**Errors**: `400 An identifier is required!`, `404 No animal in this farm matches that identifier!`

### 6. Update profile

`PUT /api/v1/farms/:farmId/animals/:animalId` — any subset of
`name, breedId, purpose, color, birthDate, purchaseDate, purchasePrice, supplierId, remarks`.
`null` or `""` clears an optional field. Sending `animalCode`, `currentWeight`, `lifeStatus`, `isActive`
or `farmId` returns **400**; other unknown keys are ignored.

**Request**

```json
{ "name": "Maya Rani", "purpose": "Dual Purpose", "color": null, "remarks": "Moved to dual purpose" }
```

**Response 200** — the updated detail object; `color` is gone, `updatedBy` is now set.

```json
{
  "success": true,
  "message": "Animal profile updated successfully!",
  "data": {
    "_id": "6740a1f2c3d4e5f601234567",
    "animalCode": "AN-000001",
    "name": "Maya Rani",
    "purpose": "Dual Purpose",
    "remarks": "Moved to dual purpose",
    "updatedBy": { "_id": "6720f0a1b2c3d4e5f6a70002", "userId": "U-25-0002", "fullName": "Karim Hossain" },
    "updatedAt": "2026-11-21T09:02:44.010Z",
    "...": "all other fields of the detail object"
  }
}
```

**Errors**

```json
{
  "success": false,
  "message": "currentWeight, lifeStatus cannot be changed through this endpoint!",
  "errorSources": [ { "errorPath": "", "errorMessage": "currentWeight, lifeStatus cannot be changed through this endpoint!" } ]
}
```

Also `400 No updatable animal fields were provided!` and the breed / date / gender-age errors from §1.

### 7. Identification

`PATCH /animals/:animalId/identification`

`rfid` / `tagNumber` may be `null` to remove. `qrCode` cannot be removed; `regenerateQrCode: true`
restores the default `QR-<farmCode>-<animalCode>`.

**Request**

```json
{ "rfid": "RFID-001258963", "tagNumber": null, "regenerateQrCode": true }
```

**Response 200** — detail object; `tagNumber` is now absent.

```json
{
  "success": true,
  "message": "Animal identification updated successfully!",
  "data": {
    "_id": "6740a1f2c3d4e5f601234567",
    "animalCode": "AN-000001",
    "rfid": "RFID-001258963",
    "qrCode": "QR-FARM-00001-AN-000001",
    "...": "all other fields of the detail object"
  }
}
```

**Errors**: `400 No identification changes were provided!` (also when every value equals the current one),
`400 qrCode cannot be removed — send regenerateQrCode: true to restore the default!`,
`409 RFID is already assigned to another animal!`.

### 8. Location

`PATCH /animals/:animalId/location` — replaces the whole current location (at least one key required).

**Request**

```json
{ "shed": "Shed-B", "pen": "Pen-01", "stall": "Stall-04" }
```

**Response 200**

```json
{
  "success": true,
  "message": "Animal location updated successfully!",
  "data": {
    "_id": "6740a1f2c3d4e5f601234567",
    "animalCode": "AN-000001",
    "location": { "shed": "Shed-B", "pen": "Pen-01", "stall": "Stall-04" },
    "...": "all other fields of the detail object"
  }
}
```

**Errors**: `400 Provide at least one of shed, pen or stall!`, `400 location.shed is too long!` (> 50 chars).

### 9. Media

`PATCH /animals/:animalId/media` — JSON or multipart.

**Request**

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

Only image files and http(s) URLs are accepted; max 50 gallery items per animal. Removals are applied
before additions; new items are appended to the end of `gallery`.

**Response 200**

```json
{
  "success": true,
  "message": "Animal media updated successfully!",
  "data": {
    "_id": "6740a1f2c3d4e5f601234567",
    "animalCode": "AN-000001",
    "profilePhoto": "https://res.cloudinary.com/<cloud>/image/upload/v1/FARM-00001-AN-000001-profile.jpg",
    "gallery": [
      {
        "_id": "6740b3c1c3d4e5f6012345a1",
        "url": "https://res.cloudinary.com/<cloud>/image/upload/v1/FARM-00001-AN-000001-gallery-0.jpg",
        "caption": "Front view",
        "uploadedAt": "2026-11-21T09:15:30.000Z"
      },
      {
        "_id": "6740b3c1c3d4e5f6012345a2",
        "url": "https://example.com/photos/maya-injury.jpg",
        "caption": "Injury",
        "uploadedAt": "2026-11-21T09:15:30.000Z"
      }
    ],
    "...": "all other fields of the detail object"
  }
}
```

**Errors**: `400 No media changes were provided!`, `400 Only image files can be uploaded!`,
`400 An animal can have at most 50 gallery images!`, `400 galleryAdd[0].url must be an http(s) URL!`,
`404 Gallery item <id> not found!`, `502 Image upload failed!`.

### 10. Lifecycle

`PATCH /animals/:animalId/lifecycle`

| From | Allowed to |
|---|---|
| Active | Sold, Dead, Transferred, Archived |
| Archived | Active (reactivation) |
| Sold / Dead / Transferred | — (final) |

`isActive` is synced automatically. History is never deleted. `remarks`, when sent, replaces the animal's remarks.

**Request**

```json
{ "lifeStatus": "Sold", "remarks": "Sold at Eid market" }
```

**Response 200**

```json
{
  "success": true,
  "message": "Animal life status updated successfully!",
  "data": {
    "_id": "6740a1f2c3d4e5f601234567",
    "animalCode": "AN-000001",
    "lifeStatus": "Sold",
    "isActive": false,
    "remarks": "Sold at Eid market",
    "...": "all other fields of the detail object"
  }
}
```

**Errors**

| Status | `message` |
|---|---|
| 409 | `Animal is already Sold!` |
| 409 | `Cannot change life status from Archived to Sold! Allowed: Active.` |
| 409 | `Sold is a final life status and cannot be changed!` |

### 11. Health / reproductive status

`PATCH /animals/:animalId/status` — `healthStatus` and/or `reproductiveStatus`. Enforces the gender/age
rules above. At least one value must differ from the current one.

**Request**

```json
{ "healthStatus": "Quarantine", "reproductiveStatus": "Pregnant" }
```

**Response 200**

```json
{
  "success": true,
  "message": "Animal status updated successfully!",
  "data": {
    "_id": "6740a1f2c3d4e5f601234567",
    "animalCode": "AN-000001",
    "healthStatus": "Quarantine",
    "reproductiveStatus": "Pregnant",
    "...": "all other fields of the detail object"
  }
}
```

**Errors**: `400 Provide a healthStatus or reproductiveStatus different from the current one!`,
`400 A male animal cannot have reproductive status 'Pregnant'!`,
`400 An animal younger than 9 months cannot be 'Pregnant'!`.

### 12. Archive (soft delete)

`DELETE /api/v1/farms/:farmId/animals/:animalId` — Owner only. Sets `lifeStatus: Archived`,
`isActive: false`. Only `Active` animals can be archived (Sold/Dead/Transferred keep their real exit reason).
Reactivate through `PATCH /lifecycle` with `{ "lifeStatus": "Active" }`.

**Response 200**

```json
{
  "success": true,
  "message": "Animal archived successfully!",
  "data": {
    "_id": "6740a1f2c3d4e5f601234567",
    "animalCode": "AN-000001",
    "lifeStatus": "Archived",
    "isActive": false,
    "...": "all other fields of the detail object"
  }
}
```

**Errors**: `403 Your farm role (Manager) is not allowed to remove animals!`,
`409 Animal is already archived!`, `409 Animal is already Sold and out of active operations!`.

---

## Audit

Register, profile, identification, location, status, media, lifecycle and archive are recorded. History (Owner / Manager):
`GET /farms/:farmId/audit-logs/entity/Animal/:id` (`auditLog.md`).

## Not implemented yet (depends on later models)

- **WeightRecord** (Model 11) — registration does not create the initial weight record yet; `currentWeight` is only settable at registration.
- **DeviceAssignment** (Model 26) — lifecycle exits do not close IoT assignments yet.
- **Income** (Model 22) — selling does not create an income record.
- **Supplier** — `supplierId` is stored as a plain ObjectId with no existence check.
