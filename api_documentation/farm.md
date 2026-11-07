# Liventra Backend — Farms API (Model 02)

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

`:farmId` in every URL accepts the public farm id (`FARM-00001`) **or** the farm ObjectId.

## Enums

```text
farmType:  Dairy | Beef | Breeding | Mixed | Research
status:    Setup | Active | Inactive | Suspended
```

`Suspended` is stored under the `FarmStatuses.ARCHIVED` constant. New farms always start in `Setup`.

## Roles

- `user` — can create farms and act inside farms where they hold an active membership.
- `admin` / `superAdmin` — platform-level access: list all farms and change farm status.
- `superAdmin` — additionally may transfer ownership of any farm and repair memberships.
- **Farm-scoped permission comes from `FarmMember`, not the system role.** Farm membership roles are
  `Owner | Manager | Worker | Veterinarian | Accountant`; see
  [`farmMember.md`](./farmMember.md) for the full permission matrix.
- Editing farm settings (`PUT /farms/:farmId`, `PATCH /farms/:farmId/logo`) requires an **active
  membership with the `Owner` or `Manager` role**. Any active member may read the farm profile.

---

## Endpoint summary

| Method | Endpoint | Access |
|---|---|---|
| POST | `/api/v1/farms` | Any authenticated, email-verified user |
| GET | `/api/v1/farms` | `admin` / `superAdmin` |
| GET | `/api/v1/farms/my-farms` | Any authenticated user (active memberships) |
| GET | `/api/v1/farms/:farmId` | Any active farm member |
| PUT | `/api/v1/farms/:farmId` | Farm Owner / Manager |
| PATCH | `/api/v1/farms/:farmId/logo` | Farm Owner / Manager |
| PATCH | `/api/v1/farms/:farmId/status` | `admin` / `superAdmin` |
| POST | `/api/v1/farms/:farmId/transfer-ownership` | Farm Owner / `superAdmin` |

---

### 1. Create a farm

- **URL**: `POST /api/v1/farms`
- **Method**: POST
- **Headers**: `Content-Type: multipart/form-data`
- **Body**:
  - `logo` — *optional* image file (uploaded to Cloudinary, becomes `logo`)
  - `data` — **required** JSON string with the farm fields (parsed with `JSON.parse` in `farm.route.ts`):

```json
{
  "farmName": "Green Valley Dairy",
  "address": {
    "village": "Rampur",
    "union": "Rampur Union",
    "postOffice": "Rampur Bazar",
    "upazila": "Sadar",
    "district": "Cumilla",
    "postalCode": "3500",
    "country": "Bangladesh"
  },
  "location": { "latitude": 23.4607, "longitude": 91.1809 },
  "phone": "01712345678",
  "email": "greenvalley@example.com",
  "establishedDate": "2024-06-01",
  "farmType": "Dairy",
  "totalArea": { "size": 3.5, "unit": "acre" },
  "capacity": 80,
  "description": "A mixed dairy and breeding farm.",
  "logo": "https://res.cloudinary.com/.../logo.png"
}
```

**Required**: `farmName`, `address.upazila`, `address.district`, `address.country`, `farmType`,
`capacity`.

**Optional**: `address.village`, `address.union`, `address.postOffice`, `address.postalCode`,
`location` (both coordinates must be sent together), `phone`, `email`, `establishedDate`,
`totalArea`, `description`, `logo`.
`farmName` max 150 chars, `description` max 2000 chars, `capacity` and `totalArea.size` ≥ 0,
`latitude` in [-90, 90], `longitude` in [-180, 180].

Business rules:

- Requester must be an **active** user with `emailVerified: true`, otherwise `403`.
- A user may not own two farms simultaneously while one is in `Setup` status (`403`).
- `farmName` must be unique per owner (`403` on duplicates).
- A `FARM-NNNNN` id is generated automatically; `status` is forced to `Setup`.
- The creator's active `Owner` FarmMember row is created in the same workflow. If it cannot be
  created, the new farm is removed so an ownerless farm is never left behind.
- If a `logo` file is uploaded it takes precedence over the `logo` JSON value.

**Successful response** (201):

```json
{
  "success": true,
  "message": "Farm created successfully!",
  "data": {
    "_id": "6710a1c2a1b2c3d4e5f60799",
    "farmId": "FARM-00001",
    "farmName": "Green Valley Dairy",
    "ownerId": "6710a1c2a1b2c3d4e5f60711",
    "address": {
      "village": "Rampur",
      "union": "Rampur Union",
      "postOffice": "Rampur Bazar",
      "upazila": "Sadar",
      "district": "Cumilla",
      "postalCode": "3500",
      "country": "Bangladesh"
    },
    "location": { "latitude": 23.4607, "longitude": 91.1809 },
    "phone": "01712345678",
    "email": "greenvalley@example.com",
    "establishedDate": "2024-06-01T00:00:00.000Z",
    "farmType": "Dairy",
    "totalArea": { "size": 3.5, "unit": "acre" },
    "capacity": 80,
    "description": "A mixed dairy and breeding farm.",
    "logo": "https://res.cloudinary.com/.../logo.png",
    "status": "Setup",
    "createdAt": "2026-11-07T08:00:00.000Z",
    "updatedAt": "2026-11-07T08:00:00.000Z"
  }
}
```

---

### 2. List all farms (platform admin)

- **URL**: `GET /api/v1/farms`
- **Access**: `admin` / `superAdmin`
- **Query parameters**: `searchTerm` (matches `farmName`, `farmId`, `phone`, `email`), any exact-match
  farm field filter (e.g. `status=Active`, `farmType=Dairy`, `ownerId=<id>`), `sort`, `page`
  (default `1`), `limit` (default `10`), `fields`.

**Successful response** (200):

```json
{
  "success": true,
  "message": "Farms retrieved successfully!",
  "meta": { "page": 1, "limit": 10, "totalEntries": 1, "totalPage": 1 },
  "data": [
    {
      "_id": "6710a1c2a1b2c3d4e5f60799",
      "farmId": "FARM-00001",
      "farmName": "Green Valley Dairy",
      "ownerId": {
        "_id": "6710a1c2a1b2c3d4e5f60711",
        "userId": "U-26-0001",
        "fullName": "Rahim Ahmed",
        "email": "rahim@example.com",
        "phone": "01712345678"
      },
      "farmType": "Dairy",
      "capacity": 80,
      "status": "Setup"
    }
  ]
}
```

`ownerId` is populated with the owner's `userId`, `fullName`, `email` and `phone`.

---

### 3. My farms

- **URL**: `GET /api/v1/farms/my-farms`
- **Access**: Any authenticated user
- **Query parameters**: same as the list above (`searchTerm`, exact filters, `sort`, `page`, `limit`,
  `fields`).

Returns every farm where the requester has an **active FarmMember row** (owned farms included).
Each record carries `membershipRole`, so the UI can render farm-specific permissions — a user can be
`Owner` of one farm and `Worker` on another.

**Successful response** (200):

```json
{
  "success": true,
  "message": "Farms retrieved successfully!",
  "meta": { "page": 1, "limit": 10, "totalEntries": 2, "totalPage": 1 },
  "data": [
    {
      "_id": "6710a1c2a1b2c3d4e5f60799",
      "farmId": "FARM-00001",
      "farmName": "Green Valley Dairy",
      "ownerId": { "userId": "U-26-0001", "fullName": "Rahim Ahmed" },
      "farmType": "Dairy",
      "capacity": 80,
      "status": "Active",
      "membershipRole": "Owner"
    },
    {
      "_id": "6710a1c2a1b2c3d4e5f60888",
      "farmId": "FARM-00002",
      "farmName": "River Side Farm",
      "ownerId": { "userId": "U-26-0005", "fullName": "Karim Rahman" },
      "farmType": "Beef",
      "capacity": 40,
      "status": "Active",
      "membershipRole": "Worker"
    }
  ]
}
```

---

### 4. Get a farm

- **URL**: `GET /api/v1/farms/:farmId`
- **Access**: Any **active** farm member (Owner, Manager, Worker, Veterinarian, Accountant)

Returns the farm with `ownerId` populated (`userId`, `fullName`, `email`, `phone`,
`profilePicture`). Non-members receive `403`; unknown farms `404`.

**Successful response** (200): a single farm object as above with the populated owner.

---

### 5. Update a farm

- **URL**: `PUT /api/v1/farms/:farmId`
- **Access**: Farm Owner / Manager
- **Headers**: `Content-Type: application/json`

Any subset of the creation fields:

```json
{
  "farmName": "Green Valley Dairy & Breeding",
  "farmType": "Mixed",
  "address": {
    "upazila": "Sadar",
    "district": "Cumilla",
    "country": "Bangladesh"
  },
  "location": { "latitude": 23.46, "longitude": 91.18 },
  "phone": "01798765432",
  "email": "contact@greenvalley.example.com",
  "establishedDate": "2024-06-01",
  "totalArea": { "size": 4, "unit": "acre" },
  "capacity": 100,
  "description": "Expanded to mixed farming."
}
```

Business rules:

- Only these fields are updatable: `farmName`, `farmType`, `address`, `location`, `phone`, `email`,
  `establishedDate`, `totalArea`, `capacity`, `description`. `farmId`, `ownerId`, `status` and `logo`
  are handled by other endpoints (logo → `PATCH /logo`, status → admin endpoint).
- `address` replaces the whole subdocument, so `upazila`, `district` and `country` are required when
  it is provided. `location` requires both coordinates together.
- Renaming to a farm name the owner already uses on another farm is rejected (`403`).
- A `Suspended` farm cannot be updated (`403`).
- At least one updatable field is required (`400` otherwise).

**Successful response** (200): the updated farm with the populated owner.

---

### 6. Update the farm logo

- **URL**: `PATCH /api/v1/farms/:farmId/logo`
- **Access**: Farm Owner / Manager
- **Headers**: `Content-Type: multipart/form-data` (file) or `application/json` (URL)

Provide either:
- form field `logo` — image file (uploaded to Cloudinary), or
- JSON body `{ "logo": "https://res.cloudinary.com/.../new-logo.png" }`.

If both are sent, the uploaded file wins. Providing neither returns `400`. A `Suspended` farm cannot
be updated.

**Successful response** (200): the updated farm with the new `logo` URL.

---

### 7. Update farm status (platform admin)

- **URL**: `PATCH /api/v1/farms/:farmId/status`
- **Access**: `admin` / `superAdmin`
- **Headers**: `Content-Type: application/json`

```json
{ "status": "Active" }
```

Allowed values: `Setup | Active | Inactive | Suspended`.

- `Active` — normal operation.
- `Inactive` — operations restricted by application policy; historical data remains readable.
- `Suspended` — normal operations blocked except for platform administrators.
- `Setup` — onboarding state used by farm creation.

**Successful response** (200): the updated farm with the populated owner.

---

### 8. Transfer farm ownership

- **URL**: `POST /api/v1/farms/:farmId/transfer-ownership`
- **Access**: Farm Owner / `superAdmin`
- **Headers**: `Content-Type: application/json`

```json
{ "newOwnerId": "U-26-0005" }
```

`newOwnerId` accepts the public user id (`U-YY-NNNN`) or the User ObjectId.

Business rules:

- The new owner must exist, be active and have `emailVerified: true` (`404` / `403`).
- The current owner cannot be assigned again (`400`).
- A `Suspended` farm can only be transferred by a `superAdmin`.
- The transfer keeps `Farm.ownerId` and `FarmMember` consistent:
  1. the new owner's active membership is promoted to `Owner` (created if they were not a member),
  2. the previous owner's active membership is demoted to `Manager`,
  3. `Farm.ownerId` is updated.
- If the ownership write fails, membership roles are restored (best-effort compensation since not
  every MongoDB deployment supports transactions).

**Successful response** (200): the updated farm with the new owner populated.

---

## Farm ↔ FarmMember consistency

- Creating a farm automatically creates the creator's active `Owner` membership.
- Farms created before the FarmMember module are backfilled on server startup: every
  `Farm.ownerId` receives an active `Owner` membership row.
- The Owner membership can never be deactivated, deleted or re-roled through the farm member
  endpoints — ownership transfer is the only workflow that changes it.
- Inactive membership rows are retained as employment history; they do not grant farm access.

## Error statuses

| Status | Meaning |
|---|---|
| `400` | Invalid body, invalid date, no updatable fields, already-owned farm |
| `403` | Not an active farm member, insufficient farm role, unverified owner, duplicate setup farm/name, suspended farm |
| `404` | Farm or user not found |
| `409` | Reserved for membership conflicts (see `farmMember.md`) |
