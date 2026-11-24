# Liventra Backend — Expense API (Model 21)

Base: `/api/v1/farms/:farmId/expenses` (`:farmId` = `_id` or `FARM-00001`). `Authorization: Bearer <token>` required.
Numbers: `EXP-YYYY-NNNNNN`.

Fields: `expenseNo, farmId, expenseCategory, amount, expenseDate, paymentMethod, referenceType, referenceId, paidTo,
invoiceNumber, description, status, createdBy, updatedBy, createdAt, updatedAt` (+ `hasAttachment`).

- Categories: Feed / Medicine / Vaccine Purchase, Salary, Veterinary Service, Electricity, Water, Transportation,
  Equipment, Repair, Maintenance, Miscellaneous
- Payment methods: Cash, Bank, Mobile Banking, Cheque, Card
- Reference types: InventoryTransaction, Treatment, Manual, Salary, Other

## Access

| Action | Owner | Manager | Accountant | Worker / Veterinarian / other farms |
|---|:-:|:-:|:-:|:-:|
| Read (list, detail, reports, history, receipt) | ✓ | ✓ | ✓ | 403 |
| Record, pay, cancel a Pending entry, attach a receipt | ✓ | ✓ | ✓ | 403 |
| Correct financial values of / cancel a **Paid** entry | ✓ | ✓ | 403 | 403 |
| Register a **new** stock item during a purchase | ✓ | ✓ | 403 | 403 |
| `DELETE` | always 403 | 403 | 403 | 403 |

- The role comes from the active `FarmMember` row, never from the request. A platform superAdmin without a
  membership may read only. Writes need an **Active** farm.
- Bodies are strict: `expenseNo`, `farmId`, `createdBy`, `updatedBy`, `attachment` and unknown keys answer 400.
- Every write is audited (`module: Finance`) without file paths. `updatedAt` is checked on every state change, so a
  double click can never settle or cancel twice (409).

## Life cycle

```text
Pending ──pay──▶ Paid
   └──────cancel──────┴──▶ Cancelled (final, leaves every total, stays in the history)
```

Limits: amount ≤ 1,000,000,000 · quantity ≤ 1,000,000 · paidTo ≤ 120 · invoiceNumber ≤ 60 · description ≤ 1000 ·
reason 3–200 · dates not in the future and at most 3650 days back.

## Shared endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/` | `{ items, totals }` + `meta`. Filters: `expenseCategory`, `status`, `paymentMethod`, `referenceType` (comma lists), `paidTo`, `invoiceNumber`, `referenceId`, `hasAttachment`, `minAmount`, `maxAmount`, `searchTerm`, `from`, `to`, `sort` (`expenseDate`, `amount`, `createdAt`, `status`, `expenseCategory`, `-` = descending), `page`, `limit` (≤ 100). `totals` follow the filters: `settled`, `pending`, `recorded` (= both), `cancelled` |
| GET | `/meta` | enums and `permissions` of the caller |
| GET | `/summary?from&to` | default current month: totals, previous period, `outstandingAllTime`, `byCategory`, `byPaymentMethod`, `topParties`, `byMonth` (12) |
| GET | `/reference-options?referenceType=` | records that can be linked |
| GET | `/reconciliation` | read-only comparison with the operational records |
| GET | `/:id` | `_id` or `expenseNo`; adds `reference`, `notes`, `hasAttachment`, `recentChanges` |
| GET | `/:id/audit-logs` | paged history |
| PUT | `/:id` | changed fields only; `null` clears optional text. Financial fields need `reason` → `{ mode, changedFields, expense }` |
| PATCH | `/:id/pay` | `{ paymentMethod, paymentDate?, remarks?, paidTo? }` |
| PATCH | `/:id/cancel` | `{ reason }` → `{ entry, review }`; `review` names a linked record that must be checked by hand |
| GET / PUT / DELETE | `/:id/attachment` | private receipt. PUT is multipart field `attachment` (PDF/JPG/PNG/WebP by file signature, ≤ 5 MB). DELETE only while Pending. Stored in `uploads/finance`, streamed as a download, never public |
| DELETE | `/:id` | always 403 |

`description` returns the user's text; the server's payment / cancellation lines are returned in `notes`.
A similar entry (same date, amount, category) answers 409 "Possible duplicate"; resend with `confirmDuplicate: true`.

## POST `/`

`{ expenseCategory?, amount?, referenceType?, referenceId?, expenseDate?, paymentMethod?, paidTo?, invoiceNumber?,
description?, status? (Pending | Paid), confirmDuplicate? }` → 201 `{ expense, warnings }`

- Paid needs `paymentMethod` and `paidTo`.
- `InventoryTransaction`: a Purchase of this farm that is not reversed and has no active expense; the **amount comes
  from the purchase** and the category must fit the item type. `Treatment`: Veterinary Service, Medicine Purchase,
  Transportation or Miscellaneous; its estimated cost is never booked automatically.
- `Salary` / `Manual` / `Other` take no `referenceId`.

## POST `/purchase`

`{ inventoryId | newItem{ itemType, unit, itemName?, referenceId?, category?, storageLocation?, minimumStock?,
reorderLevel?, maximumStock?, confirmDuplicate? }, quantity, unitPrice, expiryDate?, expenseCategory?, …common }`
→ 201 `{ expense, transactionNo, item, warnings }`. Stock, ledger row and expense are saved in **one transaction**.

## GET `/reconciliation`

`{ balanced, purchasesWithoutExpense, expensesOfReversedPurchases, amountMismatches }`. The amount of a
purchase-linked expense cannot be edited (409).

## GET `/reference-options`

`InventoryTransaction` (purchases not booked yet) or `Treatment`.
