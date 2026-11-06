import status from "http-status";
import { isValidObjectId } from "mongoose";
import AppError from "../../errors/AppError.js";
import { UserModel } from "../auth/auth.model.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { FarmModel } from "./farm.model.js";
import { FarmStatuses } from "./farm.constants.js";
import type { TFarm, TFarmStatus } from "./farm.interface.js";
import QueryBuilder from "../../builder/QueryBuilder.js";
import { generateFarmId } from "./farm.utils.js";
import { uploadImageToCloudinary } from "../../utils/uploadImage.js";

type TFarmPayload = Omit<TFarm, "farmId" | "ownerId" | "status"> & {
  establishedDate?: string | Date;
};

const getFarmFilter = (farmId: string, ownerId?: string) => {
  //example: farmId = "FARM-00001" or "64b8f8c8e4b0f1a2b3c4d5e6"
  const identifier = isValidObjectId(farmId)
    ? [{ _id: farmId }, { farmId: farmId }]
    : [{ farmId: farmId }];

  return ownerId ? { ownerId, $or: identifier } : { $or: identifier };
  //example: { ownerId: "123", $or: [{ _id: "123" }, { farmId: "FARM-00001" }] }
};

const createFarm = async (ownerId: string, file: any, payload: TFarmPayload): Promise<TFarm> => {
  const owner = await UserModel.findOne({ userId: ownerId, isActive: true, isDeleted: false, }).select("userId emailVerified phoneVerified");
  if (!owner) {
    throw new AppError(status.FORBIDDEN, "Only an active user can create a farm!",);
  }

  //owner email not verified, throw error
  if (!owner.emailVerified) {
    throw new AppError(status.FORBIDDEN, "Only a verified user can create a farm! Please verify your email.",);
  }
  //if owner has already a farm with status SETUP, throw error
  const existingFarm = await FarmModel.findOne({ ownerId: owner._id, status: FarmStatuses.SETUP });
  if (existingFarm) {
    throw new AppError(status.FORBIDDEN, "You already have a farm in setup status. Please complete the setup or deactivate it before creating a new farm.",);
  }
  //if owner has already a farm with same farmName, throw error
  const existingFarmWithName = await FarmModel.findOne({ ownerId: owner._id, farmName: payload.farmName });
  if (existingFarmWithName) {
    throw new AppError(status.FORBIDDEN, "You already have a farm with the same name. Please choose a different name.",);
  }

  if (file) {
    const imgName = `${payload?.farmName}-${ownerId}-img`;
    const filePath = file?.path;
    const image = await uploadImageToCloudinary(imgName, filePath);
    payload.logo = image?.secure_url as string;
  } else {
    payload.logo = payload?.logo || '';
  }

  //example : FARM-00001
  const farmId = await generateFarmId();
  const farmData = {
    ...payload,
    farmId,
    ownerId: owner._id,
    ...(payload.establishedDate
      ? { establishedDate: new Date(payload.establishedDate) }
      : {}),
    status: FarmStatuses.SETUP,
  }
  const result = await FarmModel.create(farmData);
  return result;
};

const getMyFarms = async (ownerId: string, query: Record<string, unknown>) => {
  //populate ownerId to get owner info, but only select userId and name
  const user = await UserModel.findOne({ userId: ownerId, isActive: true, isDeleted: false, }).select("userId name email phone");
  if (!user) {
    throw new AppError(status.FORBIDDEN, "Only an active user can get farms!",);
  }
  const farmQuery = new QueryBuilder<TFarm>(FarmModel.find({ ownerId: user._id }).populate("ownerId", "userId fullName email phone profilePicture"), query)
    .search(["farmName", "farmId", "phone", "email"])
    .filter()
    .sort()
    .paginate()
    .fields();

  //find owner info, set to response
  const [meta, farms] = await Promise.all([
    farmQuery.countTotal(),
    farmQuery.modelQuery
  ]);
  return { meta, farms };
};

const getFarmForMember = async (farmId: string, requesterUserId: string) => {
  const user = await UserModel.findOne({ userId: requesterUserId, isActive: true, isDeleted: false }).select("_id");
  if (!user) {
    throw new AppError(status.FORBIDDEN, "Only an active user can access a farm profile!",);
  }

  const farm = await FarmModel.findOne(getFarmFilter(farmId));
  if (!farm) {
    throw new AppError(status.NOT_FOUND, "Farm not found!");
  }

  // The owner is currently the only farm member (the FarmMember module is not implemented yet).
  // When it lands, replace this with an active-membership lookup scoped to farm._id + user._id.
  if (!farm.ownerId.equals(user._id)) {
    throw new AppError(status.FORBIDDEN, "You are not a member of this farm!",);
  }

  return farm;
};

const getFarmById = async (farmId: string, requesterUserId: string): Promise<TFarm> => {
  const farm = await getFarmForMember(farmId, requesterUserId);
  //attach owner profile metadata for the dashboard
  await farm.populate("ownerId", "userId fullName email phone profilePicture");
  return farm;
};

//fields a farm member is allowed to edit; identity (farmId/ownerId), status and logo are handled elsewhere
const UPDATABLE_FARM_FIELDS = [
  "farmName",
  "farmType",
  "address",
  "location",
  "phone",
  "email",
  "establishedDate",
  "totalArea",
  "capacity",
  "description",
] as const;

//validateRequest discards the parsed body, so unknown keys are still present here — whitelist them out
const pickFarmUpdates = (payload: Record<string, unknown>) => {
  const updates: Record<string, unknown> = {};
  for (const field of UPDATABLE_FARM_FIELDS) {
    if (payload[field] !== undefined) {
      updates[field] = payload[field];
    }
  }
  return updates;
};

const updateFarm = async (
  farmId: string,
  requesterUserId: string,
  payload: Record<string, unknown>,
): Promise<TFarm> => {
  const farm = await getFarmForMember(farmId, requesterUserId);

  if (farm.status === FarmStatuses.ARCHIVED) {
    throw new AppError(status.FORBIDDEN, "This farm is suspended and cannot be updated!",);
  }

  const updates = pickFarmUpdates(payload);
  if (Object.keys(updates).length === 0) {
    throw new AppError(status.BAD_REQUEST, "No updatable farm fields were provided!",);
  }

  //renaming to a name the owner already uses on another farm is rejected, same as creation
  if (typeof updates.farmName === "string") {
    updates.farmName = updates.farmName.trim();
  }
  if (typeof updates.farmName === "string" && updates.farmName !== farm.farmName) {
    const existingFarmWithName = await FarmModel.findOne({
      ownerId: farm.ownerId,
      farmName: updates.farmName,
      _id: { $ne: farm._id },
    });
    if (existingFarmWithName) {
      throw new AppError(status.FORBIDDEN, "You already have a farm with the same name. Please choose a different name.",);
    }
  }

  if (updates.establishedDate !== undefined) {
    updates.establishedDate = new Date(updates.establishedDate as string | Date);
  }

  const updated = await FarmModel.findOneAndUpdate(
    { _id: farm._id },
    { $set: updates },
    { new: true, runValidators: true },
  );
  if (!updated) {
    throw new AppError(status.NOT_FOUND, "Farm not found!");
  }

  await updated.populate("ownerId", "userId fullName email phone profilePicture");
  return updated;
};

const updateFarmLogo = async (
  farmId: string,
  requesterUserId: string,
  file?: Express.Multer.File,
  logoUrl?: string,
): Promise<TFarm> => {
  const farm = await getFarmForMember(farmId, requesterUserId);

  if (farm.status === FarmStatuses.ARCHIVED) {
    throw new AppError(status.FORBIDDEN, "This farm is suspended and cannot be updated!",);
  }

  let logo = logoUrl;
  if (file) {
    //cloudinary public_id must not contain path separators
    const safeFarmName = farm.farmName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const imgName = `${safeFarmName}-${requesterUserId}-logo`;
    const image = await uploadImageToCloudinary(imgName, file.path);
    logo = image?.secure_url as string;
  }

  if (!logo) {
    throw new AppError(status.BAD_REQUEST, "A logo file or a logo URL is required!",);
  }

  const updated = await FarmModel.findByIdAndUpdate(
    farm._id,
    { $set: { logo } },
    { new: true, runValidators: true },
  );
  if (!updated) {
    throw new AppError(status.NOT_FOUND, "Farm not found!");
  }

  await updated.populate("ownerId", "userId fullName email phone profilePicture");
  return updated;
};

//platform administrators only — every farm across the system, paginated/filterable
const getAllFarms = async (query: Record<string, unknown>) => {
  const farmQuery = new QueryBuilder<TFarm>(
    FarmModel.find().populate("ownerId", "userId fullName email phone"),
    query,
  )
    .search(["farmName", "farmId", "phone", "email"])
    .filter()
    .sort()
    .paginate()
    .fields();

  const [meta, farms] = await Promise.all([
    farmQuery.countTotal(),
    farmQuery.modelQuery
  ]);
  return { meta, farms };
};

const updateFarmStatus = async (farmId: string, statusValue: TFarmStatus,): Promise<TFarm> => {
  const farm = await FarmModel.findOne(getFarmFilter(farmId));
  if (!farm) {
    throw new AppError(status.NOT_FOUND, "Farm not found!");
  }

  const updated = await FarmModel.findOneAndUpdate(
    { _id: farm._id },
    { $set: { status: statusValue } },
    { new: true, runValidators: true },
  );
  if (!updated) {
    throw new AppError(status.NOT_FOUND, "Farm not found!");
  }

  await updated.populate("ownerId", "userId fullName email phone");
  return updated;
};

const transferFarmOwnership = async (farmId: string, requesterUserId: string, newOwnerIdentifier: string): Promise<TFarm> => {
  const requester = await UserModel.findOne({ userId: requesterUserId, isActive: true, isDeleted: false }).select("_id systemRole");
  if (!requester) {
    throw new AppError(status.FORBIDDEN, "Only an active user can transfer farm ownership!",);
  }

  const farm = await FarmModel.findOne(getFarmFilter(farmId));
  if (!farm) {
    throw new AppError(status.NOT_FOUND, "Farm not found!");
  }

  const isSuperAdmin = requester.systemRole === SystemRoles.SUPER_ADMIN;
  if (!isSuperAdmin && !farm.ownerId.equals(requester._id)) {
    throw new AppError(status.FORBIDDEN, "Only the farm owner or a super admin can transfer ownership!",);
  }

  if (farm.status === FarmStatuses.ARCHIVED && !isSuperAdmin) {
    throw new AppError(status.FORBIDDEN, "This farm is suspended and cannot be updated!",);
  }

  const newOwnerFilter = isValidObjectId(newOwnerIdentifier)
    ? { $or: [{ userId: newOwnerIdentifier }, { _id: newOwnerIdentifier }] }
    : { userId: newOwnerIdentifier };
  const newOwner = await UserModel.findOne({
    ...newOwnerFilter,
    isActive: true,
    isDeleted: false,
  }).select("_id emailVerified");
  if (!newOwner) {
    throw new AppError(status.NOT_FOUND, "New owner not found or is not an active user!",);
  }
  if (!newOwner.emailVerified) {
    throw new AppError(status.FORBIDDEN, "The new owner must verify their email before receiving farm ownership!",);
  }
  if (newOwner._id.equals(farm.ownerId)) {
    throw new AppError(status.BAD_REQUEST, "This user already owns the farm!",);
  }

  //ownerId is immutable in the schema, so the transfer must explicitly opt in to overwrite it
  const updated = await FarmModel.findOneAndUpdate(
    { _id: farm._id },
    { $set: { ownerId: newOwner._id } },
    { new: true, runValidators: true, overwriteImmutable: true },
  );
  if (!updated) {
    throw new AppError(status.NOT_FOUND, "Farm not found!");
  }

  //NOTE: the FarmMember module does not exist yet. Once it lands, this transfer must also
  //demote the previous owner's membership and promote the new owner's to Owner, inside a
  //transaction with the ownerId change above.
  await updated.populate("ownerId", "userId fullName email phone profilePicture");
  return updated;
};

export const FarmServices = {
  createFarm,
  getMyFarms,
  getFarmById,
  updateFarm,
  updateFarmLogo,
  getAllFarms,
  updateFarmStatus,
  transferFarmOwnership,
};
