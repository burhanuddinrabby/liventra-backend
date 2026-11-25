# Notifications (Model 23)

Base `/api/v1`, Bearer token on every route. A user only ever sees **their own rows**, and only of farms they can open
right now. There is no DELETE.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/notifications` | any | all farms, newest first; filters below |
| GET | `/notifications/unread-count` | any | `{ total, critical, farms: [{ _id, farmId, farmName, unread, critical }] }`; `critical` = open Critical rows, read or not |
| GET | `/farms/:farmId/notifications` | member | same list, one farm |
| GET | `/farms/:farmId/notifications/:id` | recipient | `_id` or `NOT-2026-000001`; someone else's id = 404 |
| PATCH | `…/:id/read`, `…/:id/unread` | recipient | unread clears `readAt` |
| PATCH | `…/read-all` | member | `{ updated }` |
| PATCH | `…/:id/archive` | Owner, Manager | Critical: Owner only, and it archives the row of **every** recipient. Archived again = 200, Expired = 409 |
| POST | `…/announcements` | Owner, Manager | Active farm only |

Filters: `status` (default `Active`, rows past `expiresAt` hidden; `Archived`, `Expired`), `isRead`, `type`, `priority`,
`referenceType`, `farmId` (first route), `page`, `limit` (20, max 100). Unknown values = 400.

Announcement body: `title` (≤ 120), `message` (≤ 1000), `roles` (≥ 1), `priority` (`Low | Medium | High`, default
`Medium`), `expiresAt` (`YYYY-MM-DD`, that day included, ≤ 90 days, default 30). 201 `{ …, recipients }`; 422 nobody has
the roles; 429 more than 10 in an hour on the farm.

## Events

`title` is fixed English text and the event key. O Owner, M Manager, V Veterinarian, W Worker. Only active members with
an active account, on an Active farm.

| Title | When | Type / priority | To |
|---|---|---|---|
| Vaccination Due Soon / Due Tomorrow / Overdue | ≤ 7 / 1 day before, past | Reminder Medium / High, Warning High | O M V |
| Treatment Follow-up Due | ≤ 1 day before | Reminder High | O M V |
| Medicine Withdrawal Active | episode with a withdrawal period | Warning High | O M W |
| Contagious Disease Detected | open episode of a contagious disease | Alert Critical | O M V |
| Pregnancy Check Due | ≤ 3 days before; reference `Animal` | Reminder Medium | O M V |
| Pregnancy Confirmed / Birth Recorded | on confirmation / calving | Success Medium | O M V |
| Calving Soon / In 3 Days / Overdue | ≤ 14 / ≤ 3 days before, past | Reminder Medium / High, Warning Critical | O M V W |
| Feed Recommendation Ready | plan confirmed | Reminder Medium | O M W |
| Low Stock / Out of Stock | stock state | Alert High / Critical | O M |
| Item Expiring Soon / This Week / Expired | ≤ 30 / ≤ 7 days, past; item has stock | Warning Medium / High / High | O M |

- Timed rows expire one day after the due day (overdue ones after 30). One row per recipient, record, stage and due
  date; a new date expires the old row and tells again.
- Stock and disease rows are not repeated while the state lasts, even when archived; they can come again after it ended.
- Completing, cancelling or deleting the record expires its open rows. Days are UTC, like on the other screens.

## Realtime
`notification.created` `{ notificationId, farmId, type, priority }` and `notification.updated` `{}` go to the user's own
room after the write. Hints only: refetch through REST.

## Jobs (need `JOBS_ENABLED=true`)
`notification.reminders` (hourly), `notification.expire` (hourly, :05), `inventory.sync` (daily 00:15: item statuses and
stock alerts). Without jobs only the hooks of the business modules create rows.

## Code
`modules/notification/`: `producers` (reads saved records; hooks run after commit and never throw), `delivery`
(recipients, duplicate guard, realtime), `services` (REST). Audit rows: announcements and archiving.
