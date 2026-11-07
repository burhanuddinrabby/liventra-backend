# Liventra Backend — Farm Members API (Model 03)

Base URL: `http://localhost:5000`

All endpoints require `Authorization: Bearer <accessToken>` and are nested under a farm:

```text
/api/v1/farms/:farmId/members
```

`:farmId` accepts the public farm id (`FARM-00001`) or the farm ObjectId.
`:memberId` is the **FarmMember** `_id`.

Common response envelope (via `sendResponse`):

```json
{ "success": true, "message": "<string>", "data": { } }
```

List endpoints also return a `meta` object. Errors come from `globalErrorHandler`:

```json
{ "success": false, "message": "<string>", "errorSources": [ { "errorPath": "", "errorMessage": "<string>" } ] }
```

## Farm-level roles

`Owner | Manager | Worker | Veterinarian | Accountant`

| Capability | Owner | Manager | Worker | Veterinarian | Accountant |
|---|---:|---:|---:|---:|---:|
| Read member directory / profile | ✅ | ✅ | ✅ | ✅ | ✅ |
| See `nid` / `salary` | ✅ | ✅ | ❌ | ❌ | ❌ |
| View inactive history | ✅ | ✅ | ❌ | ❌ | ❌ |
| Add / update / toggle members | ✅ | limited | ❌ | ❌ | ❌ |
| Remove a membership (DELETE) | ✅ | ❌ | ❌ | ❌ | ❌ |

- A **Manager** can only act on `Worker`, `Veterinarian` and `Accountant` members. They can never
  touch the Owner, another Manager, or their own record, and can never assign the `Manager`/`Owner` role.
- **`Owner` is never assignable through this API.** The single owner is `Farm.ownerId` and only the
  `POST /api/v1/farms/:farmId/transfer-ownership` workflow changes it.
- `superAdmin` acts with Owner privileges on any farm, but still cannot remove/deactivate the Owner
  membership.
- `nid` and `salary` are stored with `select: false` and are only returned to Owner/Manager.
- An inactive membership keeps its row for history, but loses all farm access immediately.

---

### 1. Add / invite a member

- **URL**: `POST /api/v1/farms/:farmId/members`
- **Access**: Farm Owner / Manager
- **Headers**: `Content-Type: application/json`

```json
{
  "userId": "U-26-0002",
  "role": "Worker",
  "nid": "19901234567890123",
  "joiningDate": "2026-01-05",
  "salary": 15000
}
```

- `userId` — public user id (`U-YY-NNNN`) or User ObjectId. The target user must exist and be active.
- `role` — `Manager | Worker | Veterinarian | Accountant` (`Owner` is rejected with `403`).
- `nid` — optional, 10/13/17 digits.
- `joiningDate` — optional ISO date, defaults to now, cannot be in the future.
- `salary` — optional, number ≥ 0, BDT. `0` is valid.

**Successful response** (201):

```json
{
  "success": true,
  "message": "Farm member added successfully!",
  "data": {
    "_id": "6720f1c2a1b2c3d4e5f60712",
    "userId": {
      "_id": "6710a1c2a1b2c3d4e5f60700",
      "userId": "U-26-0002",
      "fullName": "Karim Rahman",
      "email": "karim@example.com",
      "phone": "01712345678",
      "profilePicture": "https://res.cloudinary.com/.../karim.jpg",
      "isActive": true,
      "isDeleted": false
    },
    "farmId": "6710a1c2a1b2c3d4e5f60799",
    "role": "Worker",
    "nid": "19901234567890123",
    "joiningDate": "2026-01-05T00:00:00.000Z",
    "salary": 15000,
    "isActive": true,
    "assignedBy": "6710a1c2a1b2c3d4e5f60711",
    "createdAt": "2026-11-07T08:00:00.000Z",
    "updatedAt": "2026-11-07T08:00:00.000Z"
  }
}
```

Business rules:

- A user can have only **one active membership per farm** (`409 Conflict` on duplicates).
- Re-adding a former employee creates a new history row (their old inactive row is preserved).
- A Manager cannot add a Manager; only the Owner can.

---

### 2. List farm members

- **URL**: `GET /api/v1/farms/:farmId/members`
- **Access**: Any active farm member
- **Query parameters**:

| Param | Description |
|---|---|
| `searchTerm` | Matches the member's User `fullName`, `email`, `phone` or `userId` |
| `role` | Exact farm role filter (`Manager`, `Worker`, `Veterinarian`, `Accountant`, `Owner`) |
| `isActive` | `true` (default) = active directory. `false` = inactive history (Owner/Manager only) |
| `sort` | Comma-separated: `createdAt`, `updatedAt`, `joiningDate`, `role`, `isActive`, `salary` (prefix `-` = desc, default `-createdAt`) |
| `page` / `limit` | Pagination, default `1` / `10`, max limit `100` |

**Successful response** (200):

```json
{
  "success": true,
  "message": "Farm members retrieved successfully!",
  "meta": { "page": 1, "limit": 10, "totalEntries": 4, "totalPage": 1 },
  "data": [
    {
      "_id": "6720f1c2a1b2c3d4e5f60712",
      "userId": { "userId": "U-26-0002", "fullName": "Karim Rahman", "email": "karim@example.com" },
      "farmId": "6710a1c2a1b2c3d4e5f60799",
      "role": "Worker",
      "joiningDate": "2026-01-05T00:00:00.000Z",
      "salary": 15000,
      "isActive": true,
      "assignedBy": "6710a1c2a1b2c3d4e5f60711"
    }
  ]
}
```

`nid` / `salary` are omitted for non-management readers.

---

### 3. Get a single member

- **URL**: `GET /api/v1/farms/:farmId/members/:memberId`
- **Access**: Any active farm member (inactive records and `nid`/`salary` are management-only)

**Successful response** (200): a single member object as in the list (with `nid`/`salary` for
Owner/Manager). A non-management member receives `404` for an inactive record.

---

### 4. Update member details

- **URL**: `PUT /api/v1/farms/:farmId/members/:memberId`
- **Access**: Farm Owner / Manager

```json
{
  "role": "Veterinarian",
  "nid": "1234567890123",
  "joiningDate": "2026-02-01",
  "salary": 18000
}
```

- All fields optional; at least one updatable field is required (`400` otherwise).
- `salary: null` and `nid: null` (or `""`) clear the stored value.
- Same date/salary/role rules as creation.
- The Owner membership is immutable here (`403`); use ownership transfer instead.

**Successful response** (200): the updated member object.

---

### 5. Toggle member access

- **URL**: `PATCH /api/v1/farms/:farmId/members/:memberId/toggle-active`
- **Access**: Farm Owner / Manager
- **Request body**: none

Flips `isActive`. Deactivation revokes farm access immediately while preserving all historical
records; reactivation restores access. Reactivation is rejected (`409`) when the member's User
account is inactive/deleted or another active membership already exists.

**Successful response** (200): the updated member object.

---

### 6. Remove a member

- **URL**: `DELETE /api/v1/farms/:farmId/members/:memberId`
- **Access**: Farm Owner (and `superAdmin`)

Removes the FarmMember row — intended for cleaning up accidental invitations. Workers with
operational history should be deactivated (`PATCH .../toggle-active`) instead so their records stay
traceable. The Owner membership can never be removed.

**Successful response** (200):

```json
{
  "success": true,
  "message": "Farm member removed successfully!",
  "data": { "_id": "6720f1c2a1b2c3d4e5f60712", "role": "Worker", "isActive": true }
}
```

---

## Ownership transfer side effects

`POST /api/v1/farms/:farmId/transfer-ownership` keeps `Farm.ownerId` and FarmMember in sync:

1. the new owner's active membership is promoted to `Owner` (created if they were not a member);
2. the previous owner's active membership is demoted to `Manager`;
3. `Farm.ownerId` is updated.

Farm creation automatically creates the owner's active `Owner` membership. A startup backfill also
adds the missing row for farms created before this module existed.

## Error statuses

| Status | Meaning |
|---|---|
| `400` | Invalid body / id / date / sort field, no updatable fields |
| `403` | Not an active farm member, insufficient farm role, Owner-role escalation attempt |
| `404` | Farm, member or target user not found |
| `409` | Duplicate active membership, reactivation conflict, owner already associated |
