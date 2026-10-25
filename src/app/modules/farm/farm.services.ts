import status from "http-status";
import { isValidObjectId } from "mongoose";
import AppError from "../../errors/AppError.js";
import { UserModel } from "../auth/auth.model.js";
import { FarmModel } from "./farm.model.js";
import { FarmStatuses } from "./farm.constants.js";
import type { TFarm } from "./farm.interface.js";
import QueryBuilder from "../../builder/QueryBuilder.js";
import { generateFarmId } from "./farm.utils.js";
import { uploadImageToCloudinary } from "../../utils/uploadImage.js";

type TFarmPayload = Omit<TFarm, "farmId" | "ownerId" | "status"> & {
  establishedDate?: string | Date;
};

// eslint-disable-next-line no-unused-vars
const getFarmFilter = (farmId: string, ownerId?: string) => {
  const identifier = isValidObjectId(farmId)
    ? [{ _id: farmId }, { farmId: farmId }]
    : [{ farmId: farmId }];

  return ownerId ? { ownerId, $or: identifier } : { $or: identifier };
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
  const farmQuery = new QueryBuilder<TFarm>(FarmModel.find({ ownerId: user._id }).populate("ownerId", "userId fullName email phone"), query)
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

/* 
const getFarmById = async (
farmId: string,
ownerId?: string,
): Promise<TFarm> => {
const farm = await FarmModel.findOne(getFarmFilter(farmId, ownerId));
if (!farm) {
throw new AppError(status.NOT_FOUND, "Farm not found!");
}
return farm;
};

const updateFarm = async (
farmId: string,
ownerId: string,
payload: Partial<TFarmPayload>,
): Promise<TFarm> => {
const { establishedDate, ...updates } = payload;
const updated = await FarmModel.findOneAndUpdate(
getFarmFilter(farmId, ownerId),
{
  ...updates,
  ...(establishedDate === undefined
    ? {}
    : { establishedDate: new Date(establishedDate) }),
},
{ new: true, runValidators: true },
);
if (!updated) {
throw new AppError(status.NOT_FOUND, "Farm not found!");
}
return updated;
};

const updateFarmStatus = async (
farmId: string,
statusValue: string,
ownerId?: string,
): Promise<TFarm> => {
const updated = await FarmModel.findOneAndUpdate(
getFarmFilter(farmId, ownerId),
{ status: statusValue },
{ new: true, runValidators: true },
);
if (!updated) {
throw new AppError(status.NOT_FOUND, "Farm not found!");
}
return updated;
}; */

export const FarmServices = {
  createFarm,
  getMyFarms,
  /* 
  getFarmById,
  updateFarm,
  updateFarmStatus, */
};
