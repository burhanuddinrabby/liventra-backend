# Devices (Model 25)

Base `/api/v1/farms/:farmId/devices`, Bearer token. `:id` is the `_id` or `DEV-000001`; a device of another farm = 404.
Read: Owner, Manager, Veterinarian, Worker. A superAdmin acts as Owner. Writes need an Active farm (403).

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/` | Owner, Manager | 201; starts Offline + Healthy |
| GET | `/` | read | active devices unless `isActive` says otherwise |
| GET | `/dashboard` | read | counts and short attention lists of active devices |
| GET | `/meta` | read | enums, removal reasons, companies of the farm, limits |
| GET | `/lookup?serial=` | read | this farm only |
| GET | `/:id` | read | + `notes`, `latestReading`, `usage`, `identityLocked` |
| PUT | `/:id` | Owner, Manager | partial; `null` clears; `{ mode: updated or unchanged, changedFields, device }` |
| PATCH | `/:id/status` | Owner, Manager | `{ connectionStatus?, healthStatus?, reason }` |
| PATCH | `/:id/deactivate` | Owner | `{ reason, removalReason? }` |
| PATCH | `/:id/reactivate` | Owner | becomes Offline |
| DELETE | `/:id` | Owner | 409 once it had an assignment or a reading |
| GET | `/:id/audit-logs` | Owner, Manager | newest first |

## Body
`company`, `model`, `serialNumber`, `deviceType`, `batteryType` (required); `communicationProtocol`, `firmwareVersion`,
`purchaseDate`, `installationDate`, `warrantyExpiry` (`YYYY-MM-DD`), `batteryLevel` (0–100), `notes` (≤ 1000). Strict:
unknown or server-managed fields = 400. Enum values are listed by `/meta`.

- Company + serial number is unique over all farms, in any letter case: 409 (the other farm is never named).
- Purchase and installation are not in the future; installation and warranty are not before purchase.
- `Not Applicable` battery: level must be empty (stored `null`). `null` = unknown, 0 = empty.
- Company, model, serial number and type are locked (409) after the first assignment or reading.
- Do not store passwords or API keys in `notes`.

## Status
- `connectionStatus`: Online (set by a sync only), Offline (no sync for 24 h), Disconnected, Maintenance. A user may set
  the last three; Online → Offline by a user = 409. Maintenance survives syncs and the job.
- `healthStatus`: Healthy, Warning, Critical, Faulty. The connectivity job never changes it.
- Deactivating sets Disconnected. An assigned device needs `removalReason` (409), which closes the assignment. An
  inactive device cannot be changed (409).

## List
Filters `deviceType`, `communicationProtocol`, `connectionStatus`, `healthStatus` (comma lists), `isActive`
(`true` default, `false`, `all`), `company`, `warranty`, `battery`, `assignment` (`assigned`, `free`), `searchTerm`,
`sort` (`createdAt`, `deviceCode`, `company`, `deviceType`, `lastSyncAt`, `batteryLevel`, `warrantyExpiry`, `-` =
descending), `page`, `limit` (20, max 100). Unknown values = 400.

Derived per row: `warrantyState` (Active, Expiring ≤ 30 days, Expired, Unknown), `warrantyDaysLeft`, `batteryState`
(Critical ≤ 10, Low ≤ 20, Normal, Unknown), `currentAssignment`.

## Jobs and hooks
`device.connectivity` (hourly) and `device.warranty` (daily) need `JOBS_ENABLED=true`; see `notification.md`.
`device.links.ts` holds the hooks for DeviceAssignment (plan 6) and SensorData (plan 7). Until then `currentAssignment`
and `latestReading` are `null` and `recordDeviceSync()` has no caller.
