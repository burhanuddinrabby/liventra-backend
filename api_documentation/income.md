# Liventra Backend — Income API (Model 22) + profit / loss

Base: `/api/v1/farms/:farmId/incomes` (`:farmId` = `_id` or `FARM-00001`). `Authorization: Bearer <token>` required.
Numbers: `INC-YYYY-NNNNNN`.

Fields: `incomeNo, farmId, incomeCategory, amount, quantity, unit, unitPrice, incomeDate, paymentMethod, referenceType,
referenceId, customerName, customerPhone, invoiceNumber, description, status, createdBy, updatedBy, createdAt,
updatedAt` (+ `hasAttachment`).

- Categories: Milk Sale, Animal Sale, Calf Sale, Manure Sale, Breeding Service, Insurance Claim, Government Subsidy, Other
- Reference types: MilkRecord, Animal, Breeding, Manual
- Units: milk Liter/Kg · animal and calf Piece · manure Kg · breeding Service · insurance and subsidy none · Other any

## Access

| Action | Owner | Manager | Accountant | Worker / Veterinarian / other farms |
|---|:-:|:-:|:-:|:-:|
| Read (list, detail, reports, history, receipt) | ✓ | ✓ | ✓ | 403 |
| Record, receive, cancel a Pending entry, attach a receipt | ✓ | ✓ | ✓ | 403 |
| Correct financial values of / cancel a **Received** entry | ✓ | ✓ | 403 | 403 |
| Total different from quantity × price (`overrideReason`) | ✓ | 403 | 403 | 403 |
| Book an animal that is already Sold (`backfill`) | ✓ | ✓ | 403 | 403 |
| `DELETE` | always 403 | 403 | 403 | 403 |

- The role comes from the active `FarmMember` row, never from the request. A platform superAdmin without a
  membership may read only. Writes need an **Active** farm.
- Bodies are strict: `incomeNo`, `farmId`, `createdBy`, `updatedBy`, `attachment` and unknown keys answer 400.
- Every write is audited (`module: Finance`) without file paths. `updatedAt` is checked on every state change, so a
  double click can never settle or cancel twice (409).

## Life cycle

```text
Pending ──receive──▶ Received
   └──────cancel──────┴──▶ Cancelled (final, leaves every total, stays in the history)
```

Limits: amount ≤ 1,000,000,000 · quantity ≤ 1,000,000 · customerName ≤ 120 · invoiceNumber ≤ 60 · description ≤ 1000 ·
reason 3–200 · dates not in the future and at most 3650 days back.

## Shared endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/` | `{ items, totals }` + `meta`. Filters: `incomeCategory`, `status`, `paymentMethod`, `referenceType` (comma lists), `customerName`, `invoiceNumber`, `referenceId`, `hasAttachment`, `minAmount`, `maxAmount`, `searchTerm`, `from`, `to`, `sort` (`incomeDate`, `amount`, `createdAt`, `status`, `incomeCategory`, `-` = descending), `page`, `limit` (≤ 100). `totals` follow the filters: `settled`, `pending`, `recorded` (= both), `cancelled` |
| GET | `/meta` | enums and `permissions` of the caller |
| GET | `/summary?from&to` | default current month: totals, previous period, `outstandingAllTime`, `byCategory`, `byPaymentMethod`, `topParties`, `byMonth` (12) |
| GET | `/reference-options?referenceType=` | records that can be linked |
| GET | `/reconciliation` | read-only comparison with the operational records |
| GET | `/:id` | `_id` or `incomeNo`; adds `reference`, `notes`, `hasAttachment`, `recentChanges` |
| GET | `/:id/audit-logs` | paged history |
| PUT | `/:id` | changed fields only; `null` clears optional text. Financial fields need `reason` → `{ mode, changedFields, income }` |
| PATCH | `/:id/receive` | `{ paymentMethod, paymentDate?, remarks?, customerName? }` |
| PATCH | `/:id/cancel` | `{ reason }` → `{ entry, review }`; `review` names a linked record that must be checked by hand |
| GET / PUT / DELETE | `/:id/attachment` | private receipt. PUT is multipart field `attachment` (PDF/JPG/PNG/WebP by file signature, ≤ 5 MB). DELETE only while Pending. Stored in `uploads/finance`, streamed as a download, never public |
| DELETE | `/:id` | always 403 |

`description` returns the user's text; the server's payment / cancellation lines are returned in `notes`.
A similar entry (same date, amount, category) answers 409 "Possible duplicate"; resend with `confirmDuplicate: true`.

## Creation workflows (201, the income itself)

Common fields: `incomeDate?, paymentMethod?, customerName?, customerPhone?, invoiceNumber?, description?,
status? (Pending | Received), confirmDuplicate?`

| POST | Body | Rules |
|---|---|---|
| `/` | `incomeCategory` (Manure Sale, Insurance Claim, Government Subsidy, Other), `amount` **or** `quantity + unit + unitPrice` | other categories answer 400 and name their workflow |
| `/milk-sale` | `milkRecordId?, quantity, unit, unitPrice, amount?, overrideReason?` | a linked record must be saleable (not voided, rejected or in withdrawal) and can never be oversold, also under concurrent requests |
| `/animal-sale` | `animalId` (`_id` or code), `incomeCategory?` (Animal / Calf Sale), `amount, markAsSold?, backfill?` | income and `Animal → Sold` are saved together; one active sale per animal |
| `/breeding-service` | `breedingId` (`_id` or number), `amount` | one fee per breeding unless confirmed |

Cancelling an animal sale does **not** put the animal back; `review` says so.

## GET `/reconciliation`

`{ balanced, soldAnimalsWithoutIncome, incomesOfUnsoldAnimals, milkIssues }` (`issue`: voided, not-saleable, oversold).

## GET `/reference-options`

`MilkRecord`, `Animal` (`sold=true` for backfill) or `Breeding`; `searchTerm` supported.

## GET `/api/v1/farms/:farmId/finance/profit-loss?from&to`

Cash basis, Owner / Manager / Accountant: `{ basis, range, income, expense, netProfit (Received − Paid), projectedNet,
previousNetProfit, receivables, payables, incomeByCategory, expenseByCategory, byMonth[{ month, income, expense, net }] }`.
