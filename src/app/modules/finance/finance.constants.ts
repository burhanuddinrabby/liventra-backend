import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";

// Shared by Expense (Model 21) and Income (Model 22). Payment methods follow the final
// DB schema (Bank / Card), which outranks the "Bank Transfer" wording in DO.md.
export const PaymentMethods = {
  CASH: "Cash",
  BANK: "Bank",
  MOBILE_BANKING: "Mobile Banking",
  CHEQUE: "Cheque",
  CARD: "Card",
} as const;

const { OWNER, MANAGER, ACCOUNTANT } = FarmMemberRoles;

/**
 * Finance permissions (DO.md route table). Workers and Veterinarians have no access at
 * all: amounts, salaries and customers are private. Settled (Paid / Received) entries
 * are stricter: an Accountant may not correct or cancel money that already moved.
 */
export const FinancePermissions = {
  READ: [OWNER, MANAGER, ACCOUNTANT],
  WRITE: [OWNER, MANAGER, ACCOUNTANT],
  CORRECT_SETTLED: [OWNER, MANAGER],
  //final schema: amount = quantity × unitPrice, "Only Owner can manually override"
  OVERRIDE_AMOUNT: [OWNER],
  //registering a brand-new stock item keeps the inventory module's own rule
  NEW_STOCK_ITEM: [OWNER, MANAGER],
  //reaches DELETE, which always answers 403 (cancel instead)
  DELETE: [OWNER],
} as const;

export const MAX_AMOUNT = 1_000_000_000;
export const MAX_QUANTITY = 1_000_000;
export const MAX_UNIT_PRICE = 1_000_000_000;
export const MAX_PARTY = 120;
export const MAX_INVOICE = 60;
export const MAX_DESCRIPTION = 1000;
//user text + the payment / cancellation notes the server appends
export const MAX_STORED_DESCRIPTION = 4000;
export const MAX_REASON = 200;
export const MAX_LIST_LIMIT = 100;
export const MAX_BACKDATE_DAYS = 3650;
export const FUTURE_TOLERANCE_HOURS = 24;
export const RECONCILIATION_LIMIT = 50;
export const REFERENCE_OPTION_LIMIT = 50;

//receipts
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

//"[Paid 2026-08-20] …" lines written by the server into `description` (no note field in the schema)
export const TRAIL_LINE = /^\[(Paid|Received|Cancelled) \d{4}-\d{2}-\d{2}\]/;

//approximate density of cow milk, used to compare kg sales with liter production
export const MILK_KG_PER_LITER = 1.03;

//amount may differ from quantity × unitPrice by rounding only
export const AMOUNT_TOLERANCE = 0.05;

export const SERVER_MANAGED_FIELDS = [
  "_id",
  "farmId",
  "expenseNo",
  "incomeNo",
  "attachment",
  "createdBy",
  "updatedBy",
  "createdAt",
  "updatedAt",
] as const;
