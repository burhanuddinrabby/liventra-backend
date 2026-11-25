import status from "http-status";
import { isValidObjectId } from "mongoose";
import AppError from "../errors/AppError.js";
import { SystemRoles } from "../modules/auth/auth.constants.js";
import { UserModel } from "../modules/auth/auth.model.js";
import { FarmStatuses } from "../modules/farm/farm.constants.js";
import { FarmModel } from "../modules/farm/farm.model.js";
import { FarmMemberRoles } from "../modules/farmMember/farmMember.constants.js";
import type { TFarmMemberRole } from "../modules/farmMember/farmMember.interface.js";
import { FarmMemberModel } from "../modules/farmMember/farmMember.model.js";

/**
 * Farm access for NEW modules: same rules as `resolveFarmAccess` in farmMember.service.ts.
 * A platform superAdmin and the Farm.ownerId account act as Owner; a platform admin gets
 * no bypass. Imports models only, so any service may use it without an import cycle.
 */
export const resolveFarm = async (farmId: string, requesterId: string) => {
  const user = await UserModel.findOne({
    userId: requesterId,
    isActive: true,
    isDeleted: false,
  }).select("_id userId fullName systemRole");
  if (!user) {
    throw new AppError(status.FORBIDDEN, "Only an active user can access this farm!");
  }

  //a farm is addressed by its public id (FARM-00001) or its ObjectId
  const farm = await FarmModel.findOne({
    $or: isValidObjectId(farmId) ? [{ _id: farmId }, { farmId }] : [{ farmId }],
  }).select("_id farmId farmName ownerId status");
  if (!farm) {
    throw new AppError(status.NOT_FOUND, "Farm not found!");
  }

  let role: TFarmMemberRole | undefined;
  if (user.systemRole === SystemRoles.SUPER_ADMIN || farm.ownerId.equals(user._id)) {
    role = FarmMemberRoles.OWNER;
  } else {
    const membership = await FarmMemberModel.findOne({
      farmId: farm._id,
      userId: user._id,
      isActive: true,
    }).select("role");
    role = membership?.role;
  }
  if (!role) {
    throw new AppError(status.FORBIDDEN, "You are not an active member of this farm!");
  }

  return { user, farm, role };
};

export type TFarmContext = Awaited<ReturnType<typeof resolveFarm>>;

export const requireRole = (
  access: TFarmContext,
  roles: readonly TFarmMemberRole[],
  message = "You are not allowed to perform this action!",
): void => {
  if (!roles.includes(access.role)) {
    throw new AppError(status.FORBIDDEN, message);
  }
};

/** Setup, Inactive and Suspended farms are read-only. */
export const requireWritableFarm = (access: TFarmContext): void => {
  if (access.farm.status !== FarmStatuses.ACTIVE) {
    throw new AppError(
      status.FORBIDDEN,
      `This farm is ${String(access.farm.status).toLowerCase()} and cannot be changed!`,
    );
  }
};
