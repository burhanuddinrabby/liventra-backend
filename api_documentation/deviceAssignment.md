# Device Assignments (Model 26)

Which device was on which animal, and when. One row = one period. Closed periods are never rewritten.
Base `/api/v1/farms/:farmId/device-assignments`, Bearer token. `:id` is the `_id` or `ASN-000001`. `deviceId` accepts
a device `_id` or `DEV-000001`, `animalId` an animal `_id` or `AN-000001`, both of the **same farm** (another farm = 404).
Read: Owner, Manager, Veterinarian, Worker (Accountant 403). Write and pickers: Owner, Manager. A superAdmin acts as
Owner. Writes need an Active farm (403).

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/` | Owner, Manager | assign; 201 |
| GET | `/` | read | list + `meta.byStatus` |
| GET | `/meta` | read | enums, limits, `permissions { role, canWrite, canDeactivateOldDevice }` |
| GET | `/eligible-devices` | Owner, Manager | free devices that can be assigned (max 50) |
| GET | `/eligible-animals` | Owner, Manager | Active animals + their `activeDevices` (max 50) |
| GET | `/:id` | read | + `readings { count, lastRecordedAt }`, `cancellable` |
| POST | `/:id/reassign` | Owner, Manager | same device → another animal; 201 `{ closed, assignment }` |
| POST | `/:id/replace` | Owner, Manager | same animal → another device; 201 `{ closed, assignment }` |
| PATCH | `/:id/remove` | Owner, Manager | ends the period |
| PATCH | `/:id/cancel` | Owner, Manager | a mistake: under 24 h and without readings |
| PATCH | `/:id/remarks` | Owner, Manager | the only editable field, any status |
| DELETE | `/:id` | — | **always 403**: cancel or remove instead |

Also: `GET /farms/:farmId/devices/:id/assignments` (history of one device, newest first, paged) and
`GET /farms/:farmId/animals/:animalId/devices` (`{ animal, current, previous }`), both for the read roles.

## Model
`assignmentNo` (`ASN-000001`, atomic counter, immutable), `farmId`, `deviceId`, `animalId`, `assignedDate`,
`assignmentReason`, `assignedBy` (immutable); `removedDate`, `removalReason`, `removedBy`, `status`, `remarks` (≤ 1000).

- `status`: Active, Removed, Cancelled. `assignmentReason`: New Installation, Replacement, Device Upgrade,
  Reassignment, Testing. `removalReason`: Maintenance, Battery Failure, Device Fault, Replacement, Lost, Manual Removal,
  Animal Sold, Animal Dead.
- Indexes `{farmId, status}`, `{animalId, status}`, `{deviceId, assignedDate: -1}`, and a **partial unique `{deviceId}`
  where status is Active**: one open period per device. Two parallel assigns of one device → one 201, one 409.
- Derived per row: `durationDays`, `cancelUntil` (created + 24 h), `withinCancelWindow`. Rows are populated: device
  (code, type, company, model, serial, connection, health, battery, isActive), animal (code, name, tag, gender,
  lifeStatus), `assignedBy` / `removedBy` (`userId`, `fullName`).

## Rules
- The device must be active, not in Maintenance and not Faulty; the animal must be Active (409).
- Dates (`assignedDate`, `date`, `removedDate`) are ISO date-times or `YYYY-MM-DD`; blank = now; future = 400. A start is
  not before the device's `installationDate` and not before its last `removedDate` (no overlapping periods, 400). An end
  is not before the start and not before the last reading of the period (plan 7 hook, 400).
- A device that was ever Removed cannot be a `New Installation` (400); the default reason is Reassignment for such a
  device and New Installation otherwise. `POST /` accepts New Installation, Reassignment, Testing only.
- **Second device of the same type** on one animal: 409 whose message names `confirmSameType`; resend with
  `confirmSameType: true`. A like-for-like replacement (same type) does not ask.
- Every rule is checked again inside the transaction. Reassign and replace close the old row and open the new one at
  the same moment in one transaction: a failure in the second step leaves the old row Active (and writes a Rolled Back
  audit row).
- Bodies are strict: `assignedBy`, `removedBy`, `status`, `farmId`, `assignmentNo` = 400.

## Bodies
- Assign: `{ deviceId, animalId, assignedDate?, assignmentReason?, remarks?, confirmSameType? }`.
- Reassign: `{ animalId, date?, remarks?, confirmSameType? }`. The old row ends as Manual Removal with the remark
  `Reassigned to <animal> (<ASN>)`; the new one is a Reassignment.
- Replace: `{ mode: replacement | upgrade, deviceId, removalReason?, oldDeviceAction?: none | faulty | deactivate, date?,
  remarks?, confirmSameType? }`. `replacement` needs `removalReason` (Device Fault, Battery Failure, Lost) and opens a
  Replacement; `upgrade` ends the old row as Replacement and opens a Device Upgrade. `faulty` sets the old device's
  health to Faulty; `deactivate` (Owner only, 403) sets it inactive + Disconnected.
- Remove: `{ removalReason, removedDate?, remarks?, deviceToMaintenance? }`. Reasons: Maintenance, Battery Failure,
  Device Fault, Replacement, Lost, Manual Removal (remarks required, ≥ 3). `deviceToMaintenance` only with Maintenance:
  the device goes to Maintenance.
- Cancel: `{ remarks }` (≥ 3). 409 after 24 h or once the period has readings. Sets Cancelled, `removedDate`/`removedBy`,
  `removalReason: null` and appends `Cancelled: <remarks>`.
- Remarks: `{ remarks }`, `null` clears.

## List
Filters `deviceId`, `animalId`, `status`, `assignmentReason`, `removalReason`, `deviceType` (comma lists),
`dateField` (`assignedDate` default, `removedDate`) with `from` / `to` (`YYYY-MM-DD`), `searchTerm` (ASN, device code
or serial, animal code / name / tag), `sort` (`assignedDate`, `removedDate`, `assignmentNo`, `createdAt`; `-` =
descending; default `-assignedDate`), `page`, `limit` (20, max 100). Unknown values = 400.

## Animal life cycle
Every change of `Animal.lifeStatus` closes the animal's Active rows in the same transaction
(`closeAssignmentsForAnimal()` in `deviceAssignment.utils.ts`): lifecycle, archive and the animal sale in
`income.services.ts` (`markAsSold`).

| New life status | removalReason | Remark |
|---|---|---|
| Sold | Animal Sold | — |
| Dead | Animal Dead | — |
| Transferred | Manual Removal | `Released: the animal was transferred.` |
| Archived | Manual Removal | `Released: the animal was archived.` |

The lifecycle and archive responses carry `releasedDevices` (`assignmentNo`, `deviceId`, `deviceCode`, `deviceType`, `removalReason`).
Reactivating the animal restores nothing. Animal Sold / Animal Dead are never accepted from a user (400).

## Devices
- Deactivating an assigned device needs a manual `removalReason` and closes the period (`Device deactivated: …`).
- Company, model, serial and type are locked once the device has any assignment row (Cancelled included); a device with
  any assignment row cannot be deleted (409).
- A permanent farm deletion removes its assignments (`FARM_DATA_SOURCES`).

## Audit
Every write is one atomic step with its audit rows (`entityType: DeviceAssignment`; the old device in a replace and a
maintenance hand-off also write a `Device` row). Events: Device Assigned, Device Reassigned, Device Replaced, Device
Upgraded, Device Removed, Assignment Cancelled, Assignment Remarks Updated, Device Released (Animal …), Device Removed
(Device Deactivated).

## Plan 7 hooks
`device.links.ts` reads the raw `sensordatas` collection: `readingsOfAssignment()` (count + last reading of one period,
used by cancel and by the removal-date check) and `countReadingsOfDevice()` / `latestReadingOf()`. They return 0 / `null`
until SensorData exists.
