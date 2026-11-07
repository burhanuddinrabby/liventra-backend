import type { Types } from "mongoose";
import type { FarmMemberRoles } from "./farmMember.constants.js";

export type TFarmMemberRole =
  (typeof FarmMemberRoles)[keyof typeof FarmMemberRoles];

/**
 * FarmMember is the User <-> Farm relationship, not a user profile.
 * Profile data (fullName, email, phone, ...) always comes from the User document.
 *
 * `userId` / `farmId` hold the referenced documents' ObjectIds (same convention as
 * Farm.ownerId). The public `User.userId` (U-YY-NNNN) and `Farm.farmId` (FARM-NNNNN)
 * strings are resolved to `_id` by the service layer before querying.
 *
 * NOTE: the business spec names the timestamp `updateAt`; the project standardizes on
 * Mongoose's `updatedAt` (every other model + QueryBuilder's default sort rely on it).
 */
export type TFarmMember = {
  userId: Types.ObjectId;
  farmId: Types.ObjectId;
  role: TFarmMemberRole;
  nid?: string;
  joiningDate: Date;
  salary?: number;
  isActive: boolean;
  assignedBy: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
};

/** `userId` after `populate("userId", ...)` — identity fields only. */
export type TFarmMemberUserSummary = {
  _id: Types.ObjectId;
  userId: string;
  fullName: string;
  email?: string;
  phone?: string;
  profilePicture?: string;
  isActive?: boolean;
  isDeleted?: boolean;
};

/** FarmMember document with its `userId` reference populated for directory responses. */
export type TFarmMemberWithUser = Omit<TFarmMember, "userId"> & {
  userId: TFarmMemberUserSummary;
};

/**
 * The authenticated requester's active membership in the target farm.
 * This is the authorization boundary every farm-scoped request must resolve first.
 */
export type TFarmMembership = Pick<
  TFarmMember,
  "userId" | "farmId" | "role" | "isActive"
> & {
  _id: Types.ObjectId;
};
