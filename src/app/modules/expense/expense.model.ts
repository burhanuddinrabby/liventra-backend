import { model, Schema } from "mongoose";
import type { Types } from "mongoose";
import { MAX_INVOICE, MAX_PARTY, MAX_STORED_DESCRIPTION, PaymentMethods } from "../finance/finance.constants.js";
import { ExpenseCategories, ExpenseReferenceTypes, ExpenseStatuses } from "./expense.constants.js";

// Expense (Model 21): money spent by a farm. Never hard-deleted.
export type TExpense = {
  expenseNo: string;
  farmId: Types.ObjectId;
  expenseCategory: string;
  amount: number;
  //business day (UTC midnight); createdAt is when it was entered
  expenseDate: Date;
  paymentMethod: string;
  referenceType: string;
  referenceId: Types.ObjectId | null;
  paidTo?: string | null;
  invoiceNumber?: string | null;
  description?: string | null;
  //private server path, only streamed by GET /:id/attachment
  attachment?: string | null;
  status: string;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
};

const expenseSchema = new Schema<TExpense>(
  {
    expenseNo: { type: String, required: true, unique: true, immutable: true, trim: true, uppercase: true },
    farmId: { type: Schema.Types.ObjectId, ref: "Farm", required: true, immutable: true },
    expenseCategory: { type: String, enum: Object.values(ExpenseCategories), required: true },
    amount: { type: Number, required: true, min: [0.01, "amount must be greater than 0"] },
    expenseDate: { type: Date, required: true },
    paymentMethod: { type: String, enum: Object.values(PaymentMethods), required: true },
    referenceType: {
      type: String,
      enum: Object.values(ExpenseReferenceTypes),
      required: true,
      default: ExpenseReferenceTypes.MANUAL,
      immutable: true,
    },
    referenceId: { type: Schema.Types.ObjectId, default: null, immutable: true },
    paidTo: { type: String, trim: true, maxlength: MAX_PARTY, default: null },
    invoiceNumber: { type: String, trim: true, maxlength: MAX_INVOICE, default: null },
    description: { type: String, trim: true, maxlength: MAX_STORED_DESCRIPTION, default: null },
    attachment: { type: String, default: null },
    status: { type: String, enum: Object.values(ExpenseStatuses), required: true, default: ExpenseStatuses.PENDING },
    createdBy: { type: Schema.Types.ObjectId, ref: "FarmMember", required: true, immutable: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "FarmMember", default: null },
  },
  { timestamps: true },
);

expenseSchema.index({ farmId: 1, expenseDate: -1 });
expenseSchema.index({ farmId: 1, expenseCategory: 1, expenseDate: -1 });
expenseSchema.index({ farmId: 1, status: 1, expenseDate: -1 });
expenseSchema.index({ farmId: 1, referenceType: 1, referenceId: 1 });

export const ExpenseModel = model<TExpense>("Expense", expenseSchema);
