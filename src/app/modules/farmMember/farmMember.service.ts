import status from "http-status";
import { isValidObjectId } from "mongoose";
import type { HydratedDocument, Types } from "mongoose";
import AppError from "../../errors/AppError.js";
import QueryBuilder from "../../builder/QueryBuilder.js";
import { UserModel } from "../auth/auth.model.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { FarmModel } from "../farm/farm.model.js";
import { FarmMemberModel } from "./farmMember.model.js";
import { FarmMemberRoles } from "./farmMember.constants.js";
import {
  canManageFarmMembers,
  canManageMemberWithRole,
  canViewSensitiveMemberData,
  isAssignableFarmMemberRole,
  isFarmOwner,
} from "./farmMember.utils.js";
import type { TFarmMember, TFarmMemberRole } from "./farmMember.interface.js";

//fields exposed from the populated User — FarmMember never duplicates profile data
const USER_POPULATE_FIELDS =
  "userId fullName email phone profilePicture isActive isDeleted";

//client may sort by these only; keeps internal fields out of the sort clause
const MEMBER_SORT_FIELDS = new Set([
  "createdAt",
  "updatedAt",
  "joiningDate",
  "role",
  "isActive",
  "salary",
]);

type TCreateMemberPayload = {
  userId: string;
  role: TFarmMemberRole;
  nid?: string | null;
  joiningDate?: string | Date | null;
  salary?: number | string | null;
};

type TUpdateMemberPayload = {
  role?: TFarmMemberRole;
  nid?: string | null;
  joiningDate?: string | Date | null;
  salary?: number | string | null;
};

//a farm can be addressed by its public id (FARM-00001) or its ObjectId
const getFarmFilter = (farmId: string) => {
  const identifier = isValidObjectId(farmId)
    ? [{ _id: farmId }, { farmId: farmId }]
    : [{ farmId: farmId }];
  return { $or: identifier };
};

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseJoiningDate = (value: string | Date): Date => {
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(status.BAD_REQUEST, "Joining date is invalid!");
  }

  //employment cannot start in the future; allow "today" across timezones
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  if (date.getTime() > endOfToday.getTime()) {
    throw new AppError(
      status.BAD_REQUEST,
      "Joining date cannot be in the future!",
    );
  }
  return date;
};

const parseSalary = (value: number | string): number => {
  const salary = Number(value);
  if (!Number.isFinite(salary) || salary < 0) {
    throw new AppError(
      status.BAD_REQUEST,
      "Salary must be a non-negative number!",
    );
  }
  return salary;
};

const parseNid = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const nid = String(value).trim();
  return nid.length > 0 ? nid : undefined;
};

const parseMemberSort = (sort: unknown): string => {
  if (typeof sort !== "string" || sort.trim().length === 0) {
    return "-createdAt";
  }

  const fields = sort
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field.length > 0);

  for (const field of fields) {
    const name = field.startsWith("-") ? field.slice(1) : field;
    if (!MEMBER_SORT_FIELDS.has(name)) {
      throw new AppError(
        status.BAD_REQUEST,
        `Farm members cannot be sorted by '${name}'!`,
      );
    }
  }
  return fields.join(" ");
};

/**
 * Resolves the requester + target farm + the requester's ACTIVE membership.
 * This is the authorization boundary of every farm-scoped request (spec §21).
 *
 * Platform super admins and the Farm.ownerId account are treated as Owner even
 * when their Owner membership row is missing/inactive, so a legacy farm can never
 * lock its real owner out. The row itself is kept in sync by the Farm module.
 */
const resolveFarmAccess = async (farmId: string, requesterUserId: string) => {
  const user = await UserModel.findOne({
    userId: requesterUserId,
    isActive: true,
    isDeleted: false,
  }).select("_id userId systemRole");
  if (!user) {
    throw new AppError(
      status.FORBIDDEN,
      "Only an active user can access farm members!",
    );
  }

  const farm = await FarmModel.findOne(getFarmFilter(farmId)).select(
    "_id farmId farmName ownerId",
  );
  if (!farm) {
    throw new AppError(status.NOT_FOUND, "Farm not found!");
  }

  const membership = await FarmMemberModel.findOne({
    farmId: farm._id,
    userId: user._id,
    isActive: true,
  }).select("role isActive");

  const isSuperAdmin = user.systemRole === SystemRoles.SUPER_ADMIN;
  const isOwnerAccount = farm.ownerId.equals(user._id);
  if (!membership && !isSuperAdmin && !isOwnerAccount) {
    throw new AppError(
      status.FORBIDDEN,
      "You are not an active member of this farm!",
    );
  }

  return { user, farm, membership, isSuperAdmin, isOwnerAccount };
};

type TFarmAccessContext = Awaited<ReturnType<typeof resolveFarmAccess>>;

/** Effective farm role of the requester (super admin / owner account => Owner). */
const getActorRole = (
  access: TFarmAccessContext,
): TFarmMemberRole | undefined => {
  if (access.isSuperAdmin || access.isOwnerAccount) {
    return FarmMemberRoles.OWNER;
  }
  return access.membership?.role;
};

/** POST / PUT / toggle-active — Owner or Manager only. */
const requireMemberManager = (access: TFarmAccessContext): TFarmMemberRole => {
  const role = getActorRole(access);
  if (!role || !canManageFarmMembers(role)) {
    throw new AppError(
      status.FORBIDDEN,
      "Only the farm owner or a manager can manage farm members!",
    );
  }
  return role;
};

/** DELETE — Farm Owner only (spec table). */
const requireFarmOwner = (access: TFarmAccessContext): TFarmMemberRole => {
  const role = getActorRole(access);
  if (!role || !isFarmOwner(role)) {
    throw new AppError(
      status.FORBIDDEN,
      "Only the farm owner can remove a member from the farm!",
    );
  }
  return role;
};

/** The Farm.ownerId membership is immutable here — ownership transfer owns it. */
const isOwnerMembership = (
  access: TFarmAccessContext,
  member: HydratedDocument<TFarmMember>,
): boolean =>
  member.role === FarmMemberRoles.OWNER ||
  member.userId.equals(access.farm.ownerId);

const findMemberInFarm = async (
  farmObjectId: Types.ObjectId,
  memberId: string,
  withSensitiveFields: boolean,
) => {
  if (!isValidObjectId(memberId)) {
    throw new AppError(status.BAD_REQUEST, "Invalid farm member id!");
  }

  const query = FarmMemberModel.findOne({
    _id: memberId,
    farmId: farmObjectId,
  }).populate("userId", USER_POPULATE_FIELDS).populate("farmId");

  if (withSensitiveFields) {
    query.select("+nid +salary");
  }
  return query;
};

/**
 * Creates (or promotes) the ACTIVE Owner membership of a farm. Used by farm creation,
 * ownership transfer and the startup backfill so `Farm.ownerId` and `FarmMember` never
 * drift apart (Farm spec §8, FarmMember constraint 5).
 *
 * Inactive history rows are left untouched; a fresh active row is created when the
 * user has no active membership — same "re-join creates a new row" rule as elsewhere.
 */
const ensureOwnerMembership = async (
  farmObjectId: Types.ObjectId,
  ownerObjectId: Types.ObjectId,
  options: {
    joiningDate?: Date | undefined;
    assignedBy?: Types.ObjectId | undefined;
  } = {},
) => {
  return FarmMemberModel.findOneAndUpdate(
    { farmId: farmObjectId, userId: ownerObjectId, isActive: true },
    {
      $set: { role: FarmMemberRoles.OWNER },
      $setOnInsert: {
        farmId: farmObjectId,
        userId: ownerObjectId,
        joiningDate: options.joiningDate ?? new Date(),
        isActive: true,
        //who attached the owner (the owner itself during farm creation/backfill)
        assignedBy: options.assignedBy ?? ownerObjectId,
      },
    },
    {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  );
};

/**
 * Idempotent startup backfill: every existing farm gets an active Owner membership
 * row for its `Farm.ownerId`. Covers farms created before this module existed.
 * Returns the number of rows inserted/modified (0 once everything is in sync).
 */
const syncOwnedFarmMemberships = async (): Promise<number> => {
  const farms = await FarmModel.find().select("_id ownerId createdAt").lean();
  if (farms.length === 0) return 0;

  const now = new Date();
  const operations = farms.map((farm) => ({
    updateOne: {
      filter: { farmId: farm._id, userId: farm.ownerId, isActive: true },
      update: {
        $set: { role: FarmMemberRoles.OWNER },
        $setOnInsert: {
          farmId: farm._id,
          userId: farm.ownerId,
          joiningDate: farm.createdAt ?? now,
          isActive: true,
          assignedBy: farm.ownerId,
          createdAt: now,
          updatedAt: now,
        },
      },
      upsert: true,
    },
  }));

  //timestamps are disabled so an already-synced farm is not rewritten on every startup
  const result = await FarmMemberModel.bulkWrite(operations, {
    ordered: false,
    timestamps: false,
  });
  return result.upsertedCount + result.modifiedCount;
};

/**
 * Adds/invites an already registered user as a farm member.
 * Owner cannot be assigned here — that is the ownership-transfer workflow.
 */
const createMember = async (
  farmId: string,
  requesterUserId: string,
  payload: TCreateMemberPayload,
) => {
  const access = await resolveFarmAccess(farmId, requesterUserId);
  const actorRole = requireMemberManager(access);

  const role = payload.role;
  if (
    !role ||
    !Object.values(FarmMemberRoles).includes(role as TFarmMemberRole)
  ) {
    throw new AppError(status.BAD_REQUEST, "Invalid farm member role!");
  }
  if (!isAssignableFarmMemberRole(role)) {
    throw new AppError(
      status.FORBIDDEN,
      "The Owner role can only be assigned through the farm ownership transfer workflow!",
    );
  }
  if (!canManageMemberWithRole(actorRole, role)) {
    throw new AppError(
      status.FORBIDDEN,
      "A manager can only add Worker, Veterinarian or Accountant members!",
    );
  }

  //target user is selected by public userId (U-YY-NNNN) or ObjectId
  const targetUserFilter: Record<string, unknown> = isValidObjectId(
    payload.userId,
  )
    ? { $or: [{ userId: payload.userId }, { _id: payload.userId }] }
    : { userId: payload.userId };
  const targetUser = await UserModel.findOne({
    ...targetUserFilter,
    isActive: true,
    isDeleted: false,
  }).select("_id userId fullName");
  if (!targetUser) {
    throw new AppError(
      status.NOT_FOUND,
      "Target user not found or is not an active account!",
    );
  }

  if (targetUser._id.equals(access.farm.ownerId)) {
    throw new AppError(
      status.CONFLICT,
      "The farm owner is already associated with this farm!",
    );
  }

  //only ACTIVE membership is unique — a re-hired member gets a fresh history row
  const activeMembership = await FarmMemberModel.exists({
    farmId: access.farm._id,
    userId: targetUser._id,
    isActive: true,
  });
  if (activeMembership) {
    throw new AppError(
      status.CONFLICT,
      "This user is already an active member of this farm!",
    );
  }

  const memberData: TFarmMember = {
    userId: targetUser._id,
    farmId: access.farm._id,
    role,
    joiningDate: payload.joiningDate
      ? parseJoiningDate(payload.joiningDate)
      : new Date(),
    isActive: true,
    assignedBy: access.user._id,
  };

  const nid = parseNid(payload.nid);
  if (nid) memberData.nid = nid;
  //salary = 0 is valid (unpaid/owner-like roles), so only defaulted values are skipped
  if (payload.salary !== undefined && payload.salary !== null) {
    memberData.salary = parseSalary(payload.salary);
  }

  const created = await FarmMemberModel.create(memberData);

  return FarmMemberModel.findById(created._id)
    .select("+nid +salary")
    .populate("userId", USER_POPULATE_FIELDS);
};

/**
 * Member directory. Any ACTIVE member of the farm may read it; inactive history is
 * Owner/Manager only. nid + salary are only selected for management roles.
 */
const getFarmMembers = async (
  farmId: string,
  requesterUserId: string,
  query: Record<string, unknown>,
) => {
  const access = await resolveFarmAccess(farmId, requesterUserId);
  const actorRole = getActorRole(access);
  if (!actorRole) {
    throw new AppError(
      status.FORBIDDEN,
      "You are not an active member of this farm!",
    );
  }

  const canViewHistory = canManageFarmMembers(actorRole);
  const filter: Record<string, unknown> = { farmId: access.farm._id };

  //default = active staff directory; ?isActive=false exposes history to management
  const requestedActive =
    query.isActive === undefined
      ? "true"
      : String(query.isActive).toLowerCase();
  if (requestedActive !== "true" && requestedActive !== "false") {
    throw new AppError(
      status.BAD_REQUEST,
      "'isActive' must be either 'true' or 'false'!",
    );
  }
  if (requestedActive === "false" && !canViewHistory) {
    throw new AppError(
      status.FORBIDDEN,
      "Only the farm owner or a manager can view inactive members!",
    );
  }
  filter.isActive = requestedActive === "true";

  if (query.role !== undefined) {
    const role = String(query.role);
    if (!Object.values(FarmMemberRoles).includes(role as TFarmMemberRole)) {
      throw new AppError(status.BAD_REQUEST, "Invalid member role filter!");
    }
    filter.role = role;
  }

  //searchTerm matches the populated User identity, never raw membership fields
  const searchTerm =
    typeof query.searchTerm === "string" ? query.searchTerm.trim() : "";
  if (searchTerm) {
    const regex = new RegExp(escapeRegex(searchTerm), "i");
    const matchedUsers = await UserModel.find({
      $or: [
        { fullName: regex },
        { email: regex },
        { phone: regex },
        { userId: regex },
      ],
    })
      .select("_id")
      .lean();
    filter.userId = { $in: matchedUsers.map((user) => user._id) };
  }

  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 100);

  const baseQuery = FarmMemberModel.find(filter).populate(
    "userId",
    USER_POPULATE_FIELDS,
  );
  if (canViewSensitiveMemberData(actorRole)) {
    baseQuery.select("+nid +salary");
  }

  const memberQuery = new QueryBuilder<TFarmMember>(baseQuery, {
    page,
    limit,
    sort: parseMemberSort(query.sort),
  })
    .sort()
    .paginate();

  const [meta, members] = await Promise.all([
    memberQuery.countTotal(),
    memberQuery.modelQuery,
  ]);
  return { meta, members };
};

/** Single member profile — any active member; history + sensitive data restricted. */
const getMemberById = async (
  farmId: string,
  requesterUserId: string,
  memberId: string,
) => {
  const access = await resolveFarmAccess(farmId, requesterUserId);
  const actorRole = getActorRole(access);
  if (!actorRole) {
    throw new AppError(
      status.FORBIDDEN,
      "You are not an active member of this farm!",
    );
  }

  const member = await findMemberInFarm(
    access.farm._id,
    memberId,
    canViewSensitiveMemberData(actorRole),
  );
  if (!member) {
    throw new AppError(status.NOT_FOUND, "Farm member not found!");
  }
  if (!member.isActive && !canManageFarmMembers(actorRole)) {
    //non-management members may not inspect past employment records
    throw new AppError(status.NOT_FOUND, "Farm member not found!");
  }
  return member;
};

/** Updates role / salary / nid / joiningDate. Ownership is out of scope. */
const updateMember = async (
  farmId: string,
  requesterUserId: string,
  memberId: string,
  payload: TUpdateMemberPayload,
) => {
  const access = await resolveFarmAccess(farmId, requesterUserId);
  const actorRole = requireMemberManager(access);

  const member = await findMemberInFarm(access.farm._id, memberId, false);
  if (!member) {
    throw new AppError(status.NOT_FOUND, "Farm member not found!");
  }
  if (isOwnerMembership(access, member)) {
    throw new AppError(
      status.FORBIDDEN,
      "The farm owner's membership can only be changed through the farm ownership transfer workflow!",
    );
  }
  if (!canManageMemberWithRole(actorRole, member.role)) {
    throw new AppError(
      status.FORBIDDEN,
      "You are not allowed to modify this member!",
    );
  }

  const updates: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};

  if (payload.role !== undefined) {
    const nextRole = payload.role;
    if (!Object.values(FarmMemberRoles).includes(nextRole as TFarmMemberRole)) {
      throw new AppError(status.BAD_REQUEST, "Invalid farm member role!");
    }
    if (nextRole !== member.role) {
      if (!isAssignableFarmMemberRole(nextRole)) {
        throw new AppError(
          status.FORBIDDEN,
          "The Owner role can only be assigned through the farm ownership transfer workflow!",
        );
      }
      //a Manager cannot create peers (promote Worker -> Manager) or self-promote
      if (!canManageMemberWithRole(actorRole, nextRole)) {
        throw new AppError(
          status.FORBIDDEN,
          "A manager cannot assign this role to a member!",
        );
      }
      updates.role = nextRole;
    }
  }

  if (payload.joiningDate !== undefined && payload.joiningDate !== null) {
    updates.joiningDate = parseJoiningDate(payload.joiningDate);
  }

  if (payload.salary === null) {
    unset.salary = 1;
  } else if (payload.salary !== undefined) {
    updates.salary = parseSalary(payload.salary);
  }

  if (payload.nid === null) {
    unset.nid = 1;
  } else if (payload.nid !== undefined) {
    const nid = parseNid(payload.nid);
    if (nid) {
      updates.nid = nid;
    } else {
      //empty string clears an existing NID
      unset.nid = 1;
    }
  }

  if (Object.keys(updates).length === 0 && Object.keys(unset).length === 0) {
    throw new AppError(
      status.BAD_REQUEST,
      "No updatable member fields were provided!",
    );
  }

  const updateDocument: Record<string, unknown> = {};
  if (Object.keys(updates).length > 0) updateDocument.$set = updates;
  if (Object.keys(unset).length > 0) updateDocument.$unset = unset;

  return FarmMemberModel.findOneAndUpdate(
    { _id: member._id, farmId: access.farm._id },
    updateDocument,
    { new: true, runValidators: true },
  )
    .select("+nid +salary")
    .populate("userId", USER_POPULATE_FIELDS);
};

/**
 * Activates / deactivates membership. Historical rows and logs are preserved;
 * the owner membership can never be toggled (transfer ownership first).
 */
const toggleMemberActive = async (
  farmId: string,
  requesterUserId: string,
  memberId: string,
) => {
  const access = await resolveFarmAccess(farmId, requesterUserId);
  const actorRole = requireMemberManager(access);

  const member = await findMemberInFarm(access.farm._id, memberId, false);
  if (!member) {
    throw new AppError(status.NOT_FOUND, "Farm member not found!");
  }
  if (isOwnerMembership(access, member)) {
    throw new AppError(
      status.FORBIDDEN,
      "The farm owner's membership cannot be deactivated. Transfer ownership first!",
    );
  }
  if (!canManageMemberWithRole(actorRole, member.role)) {
    throw new AppError(
      status.FORBIDDEN,
      "You are not allowed to change this member's access!",
    );
  }

  const nextActive = !member.isActive;
  if (nextActive) {
    //a globally inactive/deleted user must not be turned back into an active operator
    const targetUser = await UserModel.findOne({
      _id: member.userId,
      isActive: true,
      isDeleted: false,
    }).select("_id");
    if (!targetUser) {
      throw new AppError(
        status.CONFLICT,
        "This member's user account is inactive or deleted, so the membership cannot be reactivated!",
      );
    }

    //reactivation must not create a second active membership (also guarded by the partial unique index)
    const duplicate = await FarmMemberModel.exists({
      farmId: access.farm._id,
      userId: member.userId,
      isActive: true,
      _id: { $ne: member._id },
    });
    if (duplicate) {
      throw new AppError(
        status.CONFLICT,
        "This user already has an active membership in this farm!",
      );
    }
  }

  return FarmMemberModel.findOneAndUpdate(
    { _id: member._id, farmId: access.farm._id },
    { $set: { isActive: nextActive } },
    { new: true, runValidators: true },
  )
    .select("+nid +salary")
    .populate("userId", USER_POPULATE_FIELDS);
};

/**
 * Removes a membership row. DELETE is intended for cleaning up accidental
 * invitations; a worker with operational history should be deactivated instead
 * (toggle-active), because those records must stay traceable.
 *
 * Once the operational modules land, this is the single place to check references
 * and fall back to `isActive: false` instead of deleting.
 */
const deleteMember = async (
  farmId: string,
  requesterUserId: string,
  memberId: string,
) => {
  const access = await resolveFarmAccess(farmId, requesterUserId);
  requireFarmOwner(access);

  const member = await findMemberInFarm(access.farm._id, memberId, false);
  if (!member) {
    throw new AppError(status.NOT_FOUND, "Farm member not found!");
  }
  if (isOwnerMembership(access, member)) {
    throw new AppError(
      status.FORBIDDEN,
      "The farm owner's membership cannot be removed. Transfer ownership first!",
    );
  }

  const removed = await FarmMemberModel.findOneAndDelete({
    _id: member._id,
    farmId: access.farm._id,
  });
  if (!removed) {
    throw new AppError(status.NOT_FOUND, "Farm member not found!");
  }
  return removed;
};

export const FarmMemberServices = {
  ensureOwnerMembership,
  syncOwnedFarmMemberships,
  createMember,
  getFarmMembers,
  getMemberById,
  updateMember,
  toggleMemberActive,
  deleteMember,
};
