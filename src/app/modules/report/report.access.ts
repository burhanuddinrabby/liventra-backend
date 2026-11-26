import status from "http-status";
import { Types } from "mongoose";
import AppError from "../../errors/AppError.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { UserModel } from "../auth/auth.model.js";
import { FarmStatuses } from "../farm/farm.constants.js";
import { FarmModel } from "../farm/farm.model.js";
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";
import type { TFarmMemberRole } from "../farmMember/farmMember.interface.js";
import { FarmMemberModel } from "../farmMember/farmMember.model.js";
import { FarmMemberServices } from "../farmMember/farmMember.service.js";

export type TReportAccess = {
  userObjectId: Types.ObjectId;
  userLabel: string;
  farmObjectId: Types.ObjectId;
  farmId: string;
  farmName: string;
  farmStatus: string;
  role: TFarmMemberRole;
};

/** Request-time access: active membership (super admin / owner account act as Owner). */
export const resolveReportAccess = async (farmId: string, requesterUserId: string): Promise<TReportAccess> => {
  const access = await FarmMemberServices.resolveFarmAccess(farmId, requesterUserId);
  const role = FarmMemberServices.getActorRole(access);
  if (!role) throw new AppError(status.FORBIDDEN, "You are not an active member of this farm!");
  const farm = await FarmModel.findById(access.farm._id).select("status farmId farmName").lean();
  const user = await UserModel.findById(access.user._id).select("fullName userId").lean();
  return {
    userObjectId: access.user._id,
    userLabel: user?.fullName ?? user?.userId ?? "Unknown user",
    farmObjectId: access.farm._id,
    farmId: access.farm.farmId,
    farmName: access.farm.farmName,
    farmStatus: farm?.status ?? FarmStatuses.ACTIVE,
    role,
  };
};

/**
 * Worker-time / download-time re-check: the current farm role of a user by their _id,
 * or null if they are no longer an active member. Super admin and the owner account are
 * treated as Owner. A member whose role was removed therefore loses access to old files.
 */
export const roleForUserInFarm = async (
  farmObjectId: Types.ObjectId,
  userObjectId: Types.ObjectId,
): Promise<TFarmMemberRole | null> => {
  const user = await UserModel.findOne({ _id: userObjectId, isActive: true, isDeleted: false })
    .select("systemRole")
    .lean();
  if (!user) return null;
  const farm = await FarmModel.findById(farmObjectId).select("ownerId").lean();
  if (!farm) return null;
  if (user.systemRole === SystemRoles.SUPER_ADMIN || farm.ownerId.equals(userObjectId)) {
    return FarmMemberRoles.OWNER;
  }
  const membership = await FarmMemberModel.findOne({ farmId: farmObjectId, userId: userObjectId, isActive: true })
    .select("role")
    .lean();
  return membership?.role ?? null;
};
