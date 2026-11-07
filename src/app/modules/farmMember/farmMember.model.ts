import { model, Schema } from "mongoose";
import { FarmMemberRoles } from "./farmMember.constants.js";
import type { TFarmMember } from "./farmMember.interface.js";

const farmMemberSchema = new Schema<TFarmMember>(
  {
    // relationship identity — a membership never moves to another user or farm;
    // re-joining after leaving creates a fresh record instead
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    farmId: {
      type: Schema.Types.ObjectId,
      ref: "Farm",
      required: true,
      immutable: true,
    },
    role: {
      type: String,
      enum: Object.values(FarmMemberRoles),
      required: true,
    },
    // sensitive personal data — excluded from queries unless explicitly selected
    nid: { type: String, trim: true, select: false },
    joiningDate: { type: Date, required: true, default: Date.now },
    // sensitive financial data — excluded from queries unless explicitly selected
    salary: { type: Number, min: 0, select: false },
    isActive: { type: Boolean, required: true, default: true },
    // who invited/added this member (accountability)
    assignedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

// A user may have only ONE active membership per farm. Inactive rows are kept so
// past employment stays traceable, which is why this is a partial unique index.
farmMemberSchema.index(
  { farmId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);

// Member directory: active staff of one farm, optionally narrowed by role.
farmMemberSchema.index({ farmId: 1, isActive: 1, role: 1 });

// "Which farms does this user belong to?" — used by cross-farm authorization checks.
farmMemberSchema.index({ userId: 1, isActive: 1 });

export const FarmMemberModel = model<TFarmMember>(
  "FarmMember",
  farmMemberSchema,
);
