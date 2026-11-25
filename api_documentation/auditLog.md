# Audit Log API (Model 24)

Who changed what, when and from where. Rows are written by the server only. There is no POST / PUT / PATCH / DELETE
route, and the model refuses every update and delete. Deleting a farm keeps its rows.

## Endpoints

| Method | Path | Who |
|---|---|---|
| GET | `/farms/:farmId/audit-logs` | Owner, Manager |
| GET | `/farms/:farmId/audit-logs/summary` | Owner, Manager |
| GET | `/farms/:farmId/audit-logs/meta` | Owner, Manager |
| GET | `/farms/:farmId/audit-logs/entity/:entityType/:entityId` | Owner, Manager |
| GET | `/farms/:farmId/audit-logs/user/:userId` (`_id`, `U-…` or `system`) | Owner, Manager |
| GET | `/farms/:farmId/audit-logs/:id` (`_id` or `LOG-000001`) | Owner, Manager |
| GET | `/admin/audit-logs`, `/admin/audit-logs/:id` | admin, superAdmin |

A superAdmin acts as Owner of every farm. A platform admin has no farm bypass; it uses `/admin/audit-logs`.
`:farmId` is the `_id` or `FARM-00001`. A row of another farm answers 404.

**Hidden fields:** Manager: `ipAddress`, `userAgent`, `browser`, `operatingSystem`, `location`. admin: `ipAddress`, `location`.

## Filters

`user` (`_id`, `U-…`, `system`), `entityType`, `entityId`, `action`, `module`, `status`, `deviceType`, `requestId`, `from`,
`to` (`YYYY-MM-DD`, UTC), `page`, `limit` (default 20, max 100). `/admin` also takes `farm` (`_id`, `FARM-…` or `none`).
Other query keys are ignored; an unknown enum value is 400. Default range 30 days, at most 366 days. The entity endpoint
without dates returns the whole history. Newest first.

`summary` → `{ total, today, failed, finance, deletions, exports }`. It follows the filters; `today` is the current UTC day;
`failed` = Failed + Rolled Back.

## Row

```json
{
  "_id": "…", "logNo": "LOG-000123",
  "farmId": { "_id": "…", "farmId": "FARM-00001", "farmName": "…" },
  "userId": { "_id": "…", "userId": "U-26-0001", "fullName": "…" },
  "entityType": "FarmMember", "entityId": "…", "action": "Update", "module": "Farm",
  "event": "Member Salary Changed",
  "oldData": { "salary": "[hidden]" }, "newData": { "salary": "[hidden]" }, "changedFields": ["salary"],
  "deviceType": "Desktop", "browser": "Edge", "operatingSystem": "Windows", "ipAddress": "…", "userAgent": "…",
  "requestId": "REQ-20261125-1a2b3c4d", "status": "Success", "createdAt": "…"
}
```

- `userId` is `null` for system jobs (`event` starts with `System:`) and unknown accounts. `farmId` is `null` for master data
  and account events, so sign-in rows appear only on `/admin/audit-logs`.
- Nested changes use dotted paths (`address.district`). Create: `oldData` null. Delete: `newData` null.
- `location` is reserved and stays empty.

| Enum | Values |
|---|---|
| module | Animal, Feed, Health, Inventory, Finance, Farm, Authentication, Administration |
| action | Create, Update, Delete, Archive, Login, Logout, Export, Import, Approve, Reject |
| status | `Success`, `Failed` (refused), `Rolled Back` (reverted after a failure) |

Entity types added to the Model 24 list: `FarmMember` (Farm), `Device`, `DeviceAssignment` (Administration), `Report`.

## What is recorded

- **Accounts:** register, login (success / failed), logout, password changed / reset, profile, picture, role, enable / disable, delete.
- **Farm:** create, update, logo, status, owner transfer, suspend, permanent delete. **Members:** add, role, salary, enable / disable, remove.
- **Animals:** register, profile, identification, location, status, media, lifecycle, archive, sale.
- Feed, health, breeding, inventory, finance and master data as before.
- **Refused writes:** a 403 on a farm write adds one `Failed` row ("Permission Denied"), at most one per minute for the same
  user, record type and action. Reads and validation errors are not recorded.
- A failed sign-in of an unknown account stores no email or phone (one row a minute per address).

Never recorded: reads, notification read state, sensor readings.

## Guarantees (server side)

- `recordAuditLog()` is best effort. Inside `executeAtomically(work, { trace, log })` it is part of the same transaction and
  a failed audit write reverts the change (undo steps on a standalone MongoDB). Used by expenses, incomes, animal sale,
  stock movements, treatments, vaccinations, feed recommendations, member and system-role changes; the owner transfer
  uses its own undo. `log` must hold only audit calls.
- A reverted change leaves no Success row, only one `Rolled Back` row written afterwards.
- `sanitizeForAudit()` removes passwords, OTPs, tokens, secrets, hashes and `rawPayload`; hides `salary` / `nid` values; cuts
  text at 500 characters and lists at 50 items. Pass changes through `diffForAudit(before, after)`.
- `logNo` comes from an atomic counter outside the transaction: unique, gaps possible.

## Realtime

After commit `audit.created` goes to subscribers of the farm (`realtime.md`) with only
`{ logId, logNo, entityType, entityId, action, module, status, createdAt }`.
