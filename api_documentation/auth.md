# Liventra Backend — Auth / Users API

Base URL: `http://localhost:5000`

Common response envelope (via `sendResponse`):

```json
{ "success": true, "message": "<string>", "data": { } }
```

List endpoints also return a `meta` object. Errors come from `globalErrorHandler`:

```json
{ "success": false, "message": "<string>", "errorSources": [ { "errorPath": "", "errorMessage": "<string>" } ] }
```

Roles: `user`, `admin`, `superAdmin` (see `SystemRoles` in `src/app/modules/auth/auth.constants.ts`).

---

### 1. Register User

- **URL**: `POST /api/v1/users/register-user`
- **Method**: POST
- **Headers**: `Content-Type: multipart/form-data` (no auth)
- **Request Body**: multipart form-data
  - `file` — *optional* image file (uploaded to Cloudinary; becomes `profilePicture`)
  - `data` — **required** JSON string with the user fields (parsed with `JSON.parse` in `auth.route.ts`):

```json
{
  "fullName": "Rakib Hasan",
  "phone": "01712345678",
  "email": "rakib@example.com",
  "password": "secret123",
  "gender": "male",
  "dateOfBirth": "1995-04-12",
  "address": {
    "village": "Rampur",
    "postOffice": "Rampur Bazar",
    "upazila": "Sadar",
    "district": "Cumilla",
    "country": "Bangladesh"
  }
}
```

Required: `fullName`, `phone`, `email`, `password` (min 8), `address.upazila`, `address.district`, `address.country`. Optional: `profilePicture`, `gender`, `dateOfBirth`, `emailVerified`, `phoneVerified`, `isActive`, `systemRole`, `lastLogin`, `isDeleted`.

- **Successful response** (200):

```json
{
  "success": true,
  "message": "User created successfully!!",
  "data": {
    "_id": "6507f1c2a1b2c3d4e5f60712",
    "userId": "U-26-0001",
    "fullName": "Rakib Hasan",
    "phone": "01712345678",
    "email": "rakib@example.com",
    "password": "$2b$10$XkJ9f3aPz0Qm7hL2wR4eOu5cD8sY1nB6vT0mA3pQ9rS2kF7jH4xZ1e",
    "profilePicture": "https://res.cloudinary.com/demo/image/upload/v123/U-26-0001-img.jpg",
    "gender": "male",
    "dateOfBirth": "1995-04-12T00:00:00.000Z",
    "address": {
      "village": "Rampur",
      "postOffice": "Rampur Bazar",
      "upazila": "Sadar",
      "district": "Cumilla",
      "country": "Bangladesh"
    },
    "emailVerified": false,
    "phoneVerified": false,
    "isActive": true,
    "systemRole": "user",
    "isDeleted": false,
    "createdAt": "2026-10-07T08:00:00.000Z",
    "updatedAt": "2026-10-07T08:00:00.000Z",
    "__v": 0
  }
}
```


---

### 2. Login

- **URL**: `POST /api/v1/users/login`
- **Method**: POST
- **Headers**: `Content-Type: application/json` (no auth)
- **Request Body** (`email` may be an email **or** a phone number):

```json
{
  "email": "rakib@example.com or phone number",
  "password": "secret123"
}
```

- **Successful response** (200) — also sets `Set-Cookie: refreshToken=<jwt>; HttpOnly` (non-`Secure` in development):

```json
{
  "success": true,
  "message": "User logged in successfully!!",
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "emailVerified": true,
    "phoneVerified": false
  }
}
```

---

<h2 id="get-my-profile">3. Get My Profile</h2>

- **URL**: `GET /api/v1/users/profile`
- **Method**: GET
- **Headers**: `Authorization: Bearer <accessToken>` (any role: `user`, `admin`, `superAdmin`)
- **Request Body**: none
- **Successful response** (200):

```json
{
  "success": true,
  "message": "Profile fetched successfully!!",
  "data": {
    "_id": "6507f1c2a1b2c3d4e5f60712",
    "userId": "U-26-0001",
    "fullName": "Rakib Hasan",
    "phone": "01712345678",
    "email": "rakib@example.com",
    "profilePicture": "https://res.cloudinary.com/demo/image/upload/v123/U-26-0001-img.jpg",
    "gender": "male",
    "dateOfBirth": "1995-04-12T00:00:00.000Z",
    "address": {
      "village": "Rampur",
      "postOffice": "Rampur Bazar",
      "upazila": "Sadar",
      "district": "Cumilla",
      "country": "Bangladesh"
    },
    "emailVerified": true,
    "phoneVerified": false,
    "isActive": true,
    "systemRole": "user",
    "lastLogin": "2026-10-07T09:15:30.000Z",
    "isDeleted": false,
    "createdAt": "2026-10-07T08:00:00.000Z",
    "updatedAt": "2026-10-07T09:15:30.000Z",
    "__v": 0
  }
}
```

---

### 4. Update My Profile

- **URL**: `PUT /api/v1/users/profile`
- **Method**: PUT
- **Headers**: `Authorization: Bearer <accessToken>` (any role), `Content-Type: application/json`
- **Request Body**: at least one key is required (`refine` rejects `{}`); all optional:

```json
{
  "fullName": "Rakib Hasan",
  "gender": "male",
  "dateOfBirth": "1995-04-12",
  "address": {
    "village": "Rampur",
    "upazila": "Sadar",
    "district": "Cumilla",
    "country": "Bangladesh"
  }
}
```

- **Successful response** (200) — updated document without `password` (same shape as [#3](#get-my-profile), `"message": "Profile updated successfully!!"`).

---

### 5. Update Profile Picture

- **URL**: `PATCH /api/v1/users/profile-picture`
- **Method**: PATCH
- **Headers**: `Authorization: Bearer <accessToken>` (any role)
- **Request Body**: either
  1. `multipart/form-data` with a `'file'` image (uploaded to Cloudinary), **or**
  2. `Content-Type: application/json` with a direct URL:

```json
// for direct url (user will send direct url link of the image)
{
  "url": "https://res.cloudinary.com/demo/image/upload/v123/avatar.jpg"
}
```

Sending neither returns 400 `"No file or URL provided for profile picture update!"`.

- **Successful response** (200):

```json
{
  "success": true,
  "message": "Profile picture updated successfully!!",
  "data": {
    "_id": "6507f1c2a1b2c3d4e5f60712",
    "userId": "U-26-0001",
    "fullName": "Rakib Hasan",
    "profilePicture": "https://res.cloudinary.com/demo/image/upload/v124/new-avatar.jpg",
    "systemRole": "user",
    "isActive": true,
    "isDeleted": false,
    "emailVerified": true,
    "phoneVerified": false,
    "phone": "01712345678",
    "email": "rakib@example.com",
    "createdAt": "2026-10-07T08:00:00.000Z",
    "updatedAt": "2026-10-07T10:02:11.000Z",
    "__v": 0
  }
}
```

---

### 6. Change Password

- **URL**: `PUT /api/v1/users/change-password`
- **Method**: PUT
- **Headers**: `Authorization: Bearer <accessToken>` (any role), `Content-Type: application/json`
- **Request Body** (`newPassword` min 8 and must differ from `currentPassword`):

```json
{
  "currentPassword": "secret123",
  "newPassword": "newSecret456"
}
```

- **Successful response** (200) — no `data` field:

```json
{
  "success": true,
  "message": "Password changed successfully!!"
}
```

---

### 7. List Users (paginated)

- **URL**: `GET /api/v1/users`
- **Method**: GET
- **Headers**: `Authorization: Bearer <accessToken>` (`admin` or `superAdmin`)
- **Request Body**: none. Query params (all optional):

| Param | Example | Meaning |
|---|---|---|
| `searchTerm` | `rakib` | case-insensitive regex over `fullName`, `email`, `phone`, `userId` |
| `page` | `2` | default `1` |
| `limit` | `5` | default `10` |
| `sort` | `-createdAt` | comma-separated, `-` = descending; default `-createdAt` |
| `fields` | `fullName,email` | projection; default excludes `__v` |
| *others* | `systemRole=admin` | exact-match filters on any user field (e.g. `isActive`, `gender`, `email`) |

- **Successful response** (200):

```json
{
  "success": true,
  "message": "Users retrieved successfully!!",
  "meta": {
    "page": 1,
    "limit": 10,
    "totalEntries": 2,
    "totalPage": 1
  },
  "data": [
    {
      "_id": "6507f1c2a1b2c3d4e5f60712",
      "userId": "U-26-0001",
      "fullName": "Rakib Hasan",
      "phone": "01712345678",
      "email": "rakib@example.com",
      "profilePicture": "https://res.cloudinary.com/demo/image/upload/v123/U-26-0001-img.jpg",
      "gender": "male",
      "dateOfBirth": "1995-04-12T00:00:00.000Z",
      "address": {
        "village": "Rampur",
        "postOffice": "Rampur Bazar",
        "upazila": "Sadar",
        "district": "Cumilla",
        "country": "Bangladesh"
      },
      "emailVerified": true,
      "phoneVerified": false,
      "isActive": true,
      "systemRole": "user",
      "lastLogin": "2026-10-07T09:15:30.000Z",
      "isDeleted": false,
      "createdAt": "2026-10-07T08:00:00.000Z",
      "updatedAt": "2026-10-07T09:15:30.000Z"
    }
  ]
}
```

---

### 8. Get User By ID

- **URL**: `GET /api/v1/users/:id`
- **Method**: GET
- **Headers**: `Authorization: Bearer <accessToken>` (`admin` or `superAdmin`)
- **Request Body**: none. `:id` is the `userId` (e.g. `U-26-0001`), not `_id`.
- **Successful response** (200) — full document without `password` (same shape as [#3](#get-my-profile), `"message": "User retrieved successfully!!"`).
<h2 id="quick_links">Quick links</h2>
---

### 9. Update System Role

- **URL**: `PATCH /api/v1/users/:id/system-role`
- **Method**: PATCH
- **Headers**: `Authorization: Bearer <accessToken>` (**`superAdmin` only**), `Content-Type: application/json`
- **Request Body** (must be one of `user`, `admin`, `superAdmin`):

```json
{
  "systemRole": "admin"
}
```

- **Successful response** (200):

```json
{
  "success": true,
  "message": "System role updated successfully!!",
  "data": {
    "_id": "6507f1c2a1b2c3d4e5f60712",
    "userId": "U-26-0001",
    "fullName": "Rakib Hasan",
    "phone": "01712345678",
    "email": "rakib@example.com",
    "profilePicture": "https://res.cloudinary.com/demo/image/upload/v123/U-26-0001-img.jpg",
    "gender": "male",
    "dateOfBirth": "1995-04-12T00:00:00.000Z",
    "address": {
      "village": "Rampur",
      "postOffice": "Rampur Bazar",
      "upazila": "Sadar",
      "district": "Cumilla",
      "country": "Bangladesh"
    },
    "emailVerified": true,
    "phoneVerified": false,
    "isActive": true,
    "systemRole": "admin",
    "lastLogin": "2026-10-07T09:15:30.000Z",
    "isDeleted": false,
    "createdAt": "2026-10-07T08:00:00.000Z",
    "updatedAt": "2026-10-07T10:20:00.000Z",
    "__v": 0
  }
}
```

---

### 10. Toggle Active Status

- **URL**: `PATCH /api/v1/users/:id/toggle-active`
- **Method**: PATCH
- **Headers**: `Authorization: Bearer <accessToken>` (`admin` or `superAdmin`)
- **Request Body**: none — flips `isActive` of the user identified by `:id`.
- **Successful response** (200) — same document shape as #9; the `isActive` value is flipped, e.g.:

```json
{
  "success": true,
  "message": "User active status updated successfully!!",
  "data": {
    "_id": "6507f1c2a1b2c3d4e5f60712",
    "userId": "U-26-0001",
    "fullName": "Rakib Hasan",
    "systemRole": "admin",
    "isActive": false,
    "isDeleted": false,
    "emailVerified": true,
    "phoneVerified": false,
    "phone": "01712345678",
    "email": "rakib@example.com",
    "createdAt": "2026-10-07T08:00:00.000Z",
    "updatedAt": "2026-10-07T11:05:42.000Z",
    "__v": 0
  }
}
```

---

### 11. Delete User (soft delete)

- **URL**: `DELETE /api/v1/users/:id`
- **Method**: DELETE
- **Headers**: `Authorization: Bearer <accessToken>` (`admin` or `superAdmin`)
- **Request Body**: none — sets `isDeleted: true` and `isActive: false`; the document is kept.
- **Successful response** (200):

```json
{
  "success": true,
  "message": "User deleted successfully!!",
  "data": {
    "_id": "6507f1c2a1b2c3d4e5f60712",
    "userId": "U-26-0001",
    "fullName": "Rakib Hasan",
    "systemRole": "admin",
    "isActive": false,
    "isDeleted": true,
    "emailVerified": true,
    "phoneVerified": false,
    "phone": "01712345678",
    "email": "rakib@example.com",
    "createdAt": "2026-10-07T08:00:00.000Z",
    "updatedAt": "2026-10-07T11:10:00.000Z",
    "__v": 0
  }
}
```

---

## Notes

- Soft-deleted users are hidden from all `find`/`findOne` queries (schema pre-hook), so `GET /users`, login, and profile lookups will not return them.
- Every endpoint above returns **200** on success (controllers use `status.OK`), including register.
- Common failures: 400 (missing file/url, Zod validation), 403 (wrong password / missing or insufficient role), 404 (unknown `userId`), 401/403 (bad or expired token).
