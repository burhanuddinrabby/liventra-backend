# Liventra Backend — Reports API (Model 28)

Base URL: `http://localhost:5000`

All endpoints require `Authorization: Bearer <accessToken>`. Response envelope and error shape are the
same as every other module (`{ success, message, data, meta? }` / `{ success: false, message, errorSources }`).

A **Report** is one report-generation request and its generated output file. The engine is
*request → background generation → private file → expiry*. The report metadata is kept as history;
the file is private, time-limited, and **never** served statically.

All routes are farm-scoped: `/api/v1/farms/:farmId/reports` where `:farmId` is the farm `_id` or `FARM-00001`.

> **Build status:** the engine is complete; of the 15 report types only **Milk** is implemented so far
> (the rest return `400 "… report is not available yet."`). New types are added as files under
> `src/app/modules/report/report.types/` and registered in that folder's `index.ts`.

## Model (final schema, Model 28 "updated")

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | the record id used in every `:id` route |
| `reportNo` | String | `REP-YYYY-NNNNN`, unique per farm + year (atomic counter, never reused) |
| `farmId` | ObjectId | immutable; every source query is scoped to it |
| `reportType` | enum | `Farm Summary \| Animal \| Feed \| Milk \| Weight \| Health \| Vaccination \| Treatment \| Inventory \| Expense \| Income \| Finance \| Audit Log \| Device \| Sensor` |
| `reportFormat` | enum | `PDF \| Excel \| CSV \| JSON` |
| `reportName` | String | 1–150 chars, trimmed, immutable |
| `dateRange` | `{ from, to }` | UTC calendar-day bounds; queries are **half-open** (`>= from`, `< day after to`) |
| `filters` | Object | the **effective, allowlisted** filters used — never raw query syntax |
| `generatedBy` | ObjectId (User) | the requester; kept even if their membership is later removed |
| `fileUrl` | String \| null | private relative storage key — **NEVER returned by the API** |
| `fileSize` | Number \| null | bytes, set on completion |
| `status` | enum | `Generating \| Completed \| Failed \| Expired` (default `Generating`) |
| `expiresAt` | Date \| null | set on completion (retention: 7 days) |
| `createdAt` | Date | request time (no `updatedAt` on purpose) |

Indexes: unique `{farmId, reportNo}`, `{farmId, createdAt}`, `{farmId, reportType, createdAt}`,
`{status, expiresAt}`, `{generatedBy, createdAt}`.

Every API view adds a computed **`downloadable`** (`true` only while a Completed file is still available)
and, on list/detail, a **`generatedByName`**. `fileUrl` is never present.

## Lifecycle

```
Generating ──> Completed ──> Expired
     └────────> Failed
```

- A new report starts **Generating**. Only the worker and jobs change status, with conditional updates.
- **Retry** is a *new* report with the same parameters, re-checked against today's permissions; the failed one stays.
- **Stuck:** a report left `Generating` over 15 min with no live worker → `Failed` (periodic job, and all orphans at server start).
- **Expiry:** an hourly job deletes the file, then sets `Expired` (idempotent). A missing file at download → `410` + `Expired`.
- A finished file is never regenerated on download.

## Worker (in-process queue)

- At most **2** reports run at once, **1 per user**, **20 waiting per farm**. Claims live in a technical
  `ReportJob` collection taken atomically — Redis is not needed.
- Reads use cursors + `.lean()` and one `asOf` time per report. Row limits: **50,000** (Excel/CSV/JSON),
  **2,000** (PDF); file ≤ **25 MB**; ≤ **5 min**. Over the limit → refused before start when countable.
- Files are written to `<id>.tmp`, then renamed; a failure leaves no half file. Every error is caught and
  logged with the report number; the user only ever sees "failed".

## Permissions (checked at request, in the worker, and again at download)

| Type | Owner | Manager | Accountant | Vet | Worker |
|---|---|---|---|---|---|
| Farm Summary | ✅ | ✅ | | | |
| Animal, Weight | ✅ | ✅ | | ✅ | |
| Milk, Feed | ✅ | ✅ | | | ✅ PDF/CSV, ≤ 31 days |
| Health, Vaccination, Treatment | ✅ | ✅ | | ✅ | |
| Inventory | ✅ | ✅ | ✅ | | |
| Expense, Income, Finance | ✅ | ✅ | ✅ | | |
| Audit Log | ✅ | | | | |
| Device, Sensor | ✅ | ✅ | | ✅ | |

- **Workers and Vets** see only their own reports; the others see all reports of the types they may generate.
- **Prices** are omitted from reports a Vet or Worker requests.
- A member who lost the role **cannot** download an old file (re-checked at download).

## Endpoints

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/meta` | report types, formats and filters this role may use; `canGenerate`, retention, rate limit |
| POST | `/preview-count` | rows a given request would include (no file) |
| POST | `/` | `202` + `{ reportId, reportNo, status }` (async) |
| GET | `/` | history; filters `type`, `format`, `status`, `generatedBy`, `from`, `to`, paging |
| GET | `/:id` | one report's metadata |
| GET | `/:id/download` | authenticated stream, safe file name, `no-store`, `nosniff`; audited as **Export** |
| POST | `/:id/retry` | Failed only → a new report |
| DELETE | `/:id` | **always 403** (reports are history; they expire) |

### Validation (POST `/` and `/preview-count`)

- `reportName` 1–150. `dateRange` required, `from <= to`, not in the future, ≤ 366 days (Sensor 31, Audit Log 92,
  Worker-limited types 31).
- A **strict** filter schema per type; ids must belong to the farm; **any key starting with `$` or containing `.`
  is refused** with `400`.
- The same request by the same user within **60 s** returns the existing report (double-click guard).
  **10** reports per user per hour.
- Suspended/Setup/Inactive farms may **view and download** but not generate.

### Milk filters

`animalIds` (array of farm animal ids), `session` (`Morning|Afternoon|Evening|Night`), `quality`
(`Excellent|Good|Average|Poor|Rejected`). Voided milk is excluded; totals sum recorded sessions only
(a missing session is never counted as 0).

### Example — request

```json
POST /api/v1/farms/FARM-00001/reports
{
  "reportType": "Milk",
  "reportFormat": "PDF",
  "reportName": "October Milk",
  "dateRange": { "from": "2026-10-01", "to": "2026-10-31" },
  "filters": { "animalIds": ["66a000000000000000000001"], "session": "Morning" }
}
```

```json
202 Accepted
{ "success": true, "message": "Report generation has been queued.",
  "data": { "reportId": "…", "reportNo": "REP-2026-00042", "status": "Generating" } }
```

### Example — list item (note: no `fileUrl`)

```json
{ "_id": "…", "reportNo": "REP-2026-00042", "farmId": "…", "reportType": "Milk",
  "reportFormat": "PDF", "reportName": "October Milk",
  "dateRange": { "from": "2026-10-01T00:00:00.000Z", "to": "2026-10-31T00:00:00.000Z" },
  "filters": { "animalIds": ["…"], "session": "Morning" },
  "generatedBy": "…", "generatedByName": "Owner Burhan", "fileSize": 16384,
  "status": "Completed", "expiresAt": "…", "createdAt": "…", "downloadable": true }
```

## Renderers

One neutral `ReportDocument { title, meta[], summary[], tables[], notes[] }` feeds four renderers:
- **PDF** (pdfkit + Hind Siliguri (Latin + Bengali in one face), embedded as Type0 subsets — Bangla conjuncts shape correctly): header
  with farm, range, generated by, page x / y; limited columns.
- **Excel** (exceljs): a Summary sheet + one sheet per table, **real** dates and numbers, frozen header.
- **CSV**: one main flat table, **UTF-8 BOM** so Bangla opens correctly in Excel.
- **JSON**: structured.
- CSV / Excel **text** cells starting with `=`, `+`, `-`, `@`, tab or CR get a leading `'` (formula-injection
  guard). Numbers and dates stay typed.

## Storage

Disk driver behind a small `reportStorage` interface (an S3 driver can be added without other changes).
Files live under `uploads/reports/<farmId>/` — **git-ignored**, never served statically; the download route
streams them after the same farm + role check as the record, with the stored key validated to stay inside the
farm's own folder (as in `finance.utils.ts`).

## Integration

- **Notifications:** `Report Ready` / `Report Failed` to the requester only (`Manual`, no reference id; the
  message carries the reportNo).
- **Audit:** `Create` on request, `Export` on download, entity `Report`, module `Administration`.
- **Farm deletion:** `Report` and `ReportJob` are in `FARM_DATA_SOURCES`; the reports folder is removed.
- **Jobs** (`report.stuck` every 5 min, `report.expiry` hourly) are in the scheduler; the in-process worker
  and startup stuck-recovery run regardless of `JOBS_ENABLED`.
