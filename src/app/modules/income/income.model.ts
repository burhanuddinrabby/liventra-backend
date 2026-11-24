import { model, Schema } from "mongoose";
import type { Types } from "mongoose";
import { MAX_INVOICE, MAX_PARTY, MAX_STORED_DESCRIPTION, PaymentMethods } from "../finance/finance.constants.js";
import { IncomeCategories, IncomeReferenceTypes, IncomeStatuses, IncomeUnits } from "./income.constants.js";

// Income (Model 22): money earned by a farm. Never hard-deleted.
export type TIncome = {
  incomeNo: string;
  farmId: Types.ObjectId;
  incomeCategory: string;
  amount: number;
  //business day (UTC midnight); createdAt is when it was entered
  incomeDate: Date;
  paymentMethod: string;
  referenceType: string;
  referenceId: Types.ObjectId | null;
  //snapshots of the customer at sale time
  customerName?: string | null;
  customerPhone?: string | null;
  invoiceNumber?: string | null;
  quantity?: number | null;
  unit?: string | null;
  unitPrice?: number | null;
  description?: string | null;
  //private server path, only streamed by GET /:id/attachment
  attachment?: string | null;
  status: string;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
};

const incomeSchema = new Schema<TIncome>(
  {
    incomeNo: { type: String, required: true, unique: true, immutable: true, trim: true, uppercase: true },
    farmId: { type: Schema.Types.ObjectId, ref: "Farm", required: true, immutable: true },
    incomeCategory: { type: String, enum: Object.values(IncomeCategories), required: true },
    amount: { type: Number, required: true, min: [0.01, "amount must be greater than 0"] },
    incomeDate: { type: Date, required: true },
    paymentMethod: { type: String, enum: Object.values(PaymentMethods), required: true },
    referenceType: {
      type: String,
      enum: Object.values(IncomeReferenceTypes),
      required: true,
      default: IncomeReferenceTypes.MANUAL,
      immutable: true,
    },
    referenceId: { type: Schema.Types.ObjectId, default: null, immutable: true },
    customerName: { type: String, trim: true, maxlength: MAX_PARTY, default: null },
    customerPhone: { type: String, trim: true, maxlength: 20, default: null },
    invoiceNumber: { type: String, trim: true, maxlength: MAX_INVOICE, default: null },
    quantity: { type: Number, min: 0, default: null },
    unit: { type: String, enum: [...Object.values(IncomeUnits), null], default: null },
    unitPrice: { type: Number, min: 0, default: null },
    description: { type: String, trim: true, maxlength: MAX_STORED_DESCRIPTION, default: null },
    attachment: { type: String, default: null },
    status: { type: String, enum: Object.values(IncomeStatuses), required: true, default: IncomeStatuses.PENDING },
    createdBy: { type: Schema.Types.ObjectId, ref: "FarmMember", required: true, immutable: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "FarmMember", default: null },
  },
  { timestamps: true },
);

incomeSchema.index({ farmId: 1, incomeDate: -1 });
incomeSchema.index({ farmId: 1, incomeCategory: 1, incomeDate: -1 });
incomeSchema.index({ farmId: 1, status: 1, incomeDate: -1 });
incomeSchema.index({ farmId: 1, referenceType: 1, referenceId: 1 });

export const IncomeModel = model<TIncome>("Income", incomeSchema);
