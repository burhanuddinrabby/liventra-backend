import status from "http-status";
import { isValidObjectId } from "mongoose";
import type { Model, Types } from "mongoose";
import { DeviceModel } from "../device/device.model.js";
import { DeviceAssignmentModel } from "../deviceAssignment/deviceAssignment.model.js";
import { NotificationModel } from "../notification/notification.model.js";
import AppError from "../../errors/AppError.js";
import { UserModel } from "../auth/auth.model.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { FarmModel } from "./farm.model.js";
import { FarmStatuses } from "./farm.constants.js";
import type { TFarm, TFarmStatus } from "./farm.interface.js";
import QueryBuilder from "../../builder/QueryBuilder.js";
import { generateFarmId } from "./farm.utils.js";
import { uploadImageToCloudinary } from "../../utils/uploadImage.js";
import { FarmMemberModel } from "../farmMember/farmMember.model.js";
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";
import { FarmMemberServices } from "../farmMember/farmMember.service.js";
import type { TFarmMemberRole } from "../farmMember/farmMember.interface.js";
import { AnimalModel } from "../animal/animal.model.js";
import { FeedRecommendationModel } from "../feedRecommendation/feedRecommendation.model.js";
import { FeedRecordModel } from "../feedRecord/feedRecord.model.js";
import { MilkRecordModel } from "../milkRecord/milkRecord.model.js";
import { WeightRecordModel } from "../weightRecord/weightRecord.model.js";
import { VaccinationModel } from "../vaccination/vaccination.model.js";
import { TreatmentModel } from "../treatment/treatment.model.js";
import { BreedingModel } from "../breeding/breeding.model.js";
import { PregnancyModel } from "../pregnancy/pregnancy.model.js";
import { InventoryModel, InventoryTransactionModel } from "../inventory/inventory.model.js";
import { ExpenseModel } from "../expense/expense.model.js";
import { IncomeModel } from "../income/income.model.js";
import { removeFarmAttachments } from "../finance/finance.utils.js";
import { closeFarmRooms, removeUserFromFarm } from "../../realtime/realtime.js";
import { recordAuditLog, recordRolledBack, type TAuditContext, type TRecordAuditInput } from "../auditLog/auditLog.utils.js";
import { diffForAudit } from "../auditLog/auditLog.sanitize.js";
import { AuditActions, AuditEntityTypes, AuditModules } from "../auditLog/auditLog.constants.js";

type TFarmPayload = Omit<TFarm, "farmId" | "ownerId" | "status"> & {
  establishedDate?: string | Date;
};

const farmEvent = (
  context: TAuditContext | undefined,
  farmObjectId: Types.ObjectId,
  event: string,
  more: Partial<TRecordAuditInput> = {},
): TRecordAuditInput => ({
  context,
  farmId: farmObjectId,
  entityType: AuditEntityTypes.FARM,
  entityId: farmObjectId,
  action: AuditActions.UPDATE,
  module: AuditModules.FARM,
  event,
  ...more,
});

const getFarmFilter = (farmId: string, ownerId?: string) => {
  //example: farmId = "FARM-00001" or "64b8f8c8e4b0f1a2b3c4d5e6"
  const identifier = isValidObjectId(farmId)
    ? [{ _id: farmId }, { farmId: farmId }]
    : [{ farmId: farmId }];

  return ownerId ? { ownerId, $or: identifier } : { $or: identifier };
  //example: { ownerId: "123", $or: [{ _id: "123" }, { farmId: "FARM-00001" }] }
};

const createFarm = async (ownerId: string, file: any, payload: TFarmPayload, context?: TAuditContext): Promise<TFarm> => {
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

  //ownership consistency: the owner must also exist as an active FarmMember (Farm spec §8)
  try {
    await FarmMemberServices.ensureOwnerMembership(result._id, owner._id, {
      joiningDate: result.createdAt,
      assignedBy: owner._id,
    });
  } catch (error) {
    //compensating workflow — never leave an ownerless operational farm (Farm spec edge case 1)
    await FarmModel.deleteOne({ _id: result._id }).catch(() => undefined);
    throw error;
  }

  await recordAuditLog(farmEvent(context, result._id, "Farm Created", {
    action: AuditActions.CREATE,
    newData: { farmId, farmName: result.farmName, farmType: result.farmType, status: result.status },
  }));
  return result;
};

//populated refs become objects — reduce them back to their id for comparisons
const ownerIdOf = (owner: unknown): string => {
  if (owner && typeof owner === "object" && "_id" in owner) {
    return String((owner as { _id: unknown })._id);
  }
  return String(owner);
};

const getMyFarms = async (ownerId: string, query: Record<string, unknown>) => {
  const user = await UserModel.findOne({ userId: ownerId, isActive: true, isDeleted: false }).select("_id userId");
  if (!user) {
    throw new AppError(status.FORBIDDEN, "Only an active user can get farms!",);
  }

  //a user can belong to multiple farms with a different role in each, so "my farms"
  //is every farm where the user has an ACTIVE membership (owner included).
  const memberships = await FarmMemberModel.find({ userId: user._id, isActive: true })
    .select("farmId role")
    .lean();
  const roleByFarm = new Map<string, TFarmMemberRole>(
    memberships.map((membership) => [String(membership.farmId), membership.role]),
  );

  const farmQuery = new QueryBuilder<TFarm>(
    FarmModel.find({
      $or: [
        { ownerId: user._id },
        { _id: { $in: memberships.map((membership) => membership.farmId) } },
      ],
    }).populate("ownerId", "userId fullName email phone profilePicture"),
    query,
  )
    .search(["farmName", "farmId", "phone", "email"])
    .filter()
    .sort()
    .paginate()
    .fields();

  //lean so the requester's farm-specific role can be attached to each record
  const [meta, farms] = await Promise.all([
    farmQuery.countTotal(),
    farmQuery.modelQuery.lean(),
  ]);

  const farmRows = farms as unknown as Array<TFarm & { _id: unknown }>;
  const farmsWithRole = farmRows.map((farm) => ({
    ...farm,
    membershipRole:
      roleByFarm.get(String(farm._id)) ??
      (ownerIdOf(farm.ownerId) === String(user._id) ? FarmMemberRoles.OWNER : undefined),
  }));
  return { meta, farms: farmsWithRole };
};

const FARM_MANAGEMENT_ROLES: TFarmMemberRole[] = [
  FarmMemberRoles.OWNER,
  FarmMemberRoles.MANAGER,
];

const getFarmForMember = async (
  farmId: string,
  requesterUserId: string,
  allowedRoles?: TFarmMemberRole[],
) => {
  const user = await UserModel.findOne({ userId: requesterUserId, isActive: true, isDeleted: false }).select("_id");
  if (!user) {
    throw new AppError(status.FORBIDDEN, "Only an active user can access a farm profile!",);
  }

  const farm = await FarmModel.findOne(getFarmFilter(farmId));
  if (!farm) {
    throw new AppError(status.NOT_FOUND, "Farm not found!");
  }

  //any ACTIVE membership grants read access; Farm.ownerId is authoritative for legacy
  //farms whose Owner membership row has not been backfilled yet.
  const membership = await FarmMemberModel.findOne({
    farmId: farm._id,
    userId: user._id,
    isActive: true,
  }).select("role");
  const role = farm.ownerId.equals(user._id)
    ? FarmMemberRoles.OWNER
    : membership?.role;

  if (!role) {
    throw new AppError(status.FORBIDDEN, "You are not an active member of this farm!",);
  }
  if (allowedRoles && !allowedRoles.includes(role)) {
    throw new AppError(status.FORBIDDEN, "You are not allowed to modify this farm!",);
  }

  return farm;
};

const getFarmById = async (farmId: string, requesterUserId: string): Promise<TFarm> => {
  const farm = await getFarmForMember(farmId, requesterUserId);
  //attach owner profile metadata for the dashboard
  await farm.populate("ownerId", "userId fullName email phone profilePicture");
  return farm;
};

//fields a farm owner/manager is allowed to edit; identity (farmId/ownerId), status and logo are handled elsewhere
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
  context?: TAuditContext,
): Promise<TFarm> => {
  const farm = await getFarmForMember(farmId, requesterUserId, FARM_MANAGEMENT_ROLES);

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
    { returnDocument: 'after', runValidators: true },
  );
  if (!updated) {
    throw new AppError(status.NOT_FOUND, "Farm not found!");
  }

  const touched = (source: object) => Object.fromEntries(Object.entries(source).filter(([key]) => key in updates));
  const changes = diffForAudit(touched(farm.toObject()), touched(updated.toObject()));
  if (changes.changedFields.length) await recordAuditLog(farmEvent(context, farm._id, "Farm Updated", changes));

  await updated.populate("ownerId", "userId fullName email phone profilePicture");
  return updated;
};

const updateFarmLogo = async (
  farmId: string,
  requesterUserId: string,
  file?: Express.Multer.File,
  logoUrl?: string,
  context?: TAuditContext,
): Promise<TFarm> => {
  const farm = await getFarmForMember(farmId, requesterUserId, FARM_MANAGEMENT_ROLES);

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
    { returnDocument: 'after', runValidators: true },
  );
  if (!updated) {
    throw new AppError(status.NOT_FOUND, "Farm not found!");
  }

  await recordAuditLog(farmEvent(context, farm._id, "Farm Logo Updated", {
    oldData: { logo: farm.logo ?? null },
    newData: { logo },
    changedFields: ["logo"],
  }));

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

const updateFarmStatus = async (farmId: string, statusValue: TFarmStatus, context?: TAuditContext): Promise<TFarm> => {
  const farm = await FarmModel.findOne(getFarmFilter(farmId));
  if (!farm) {
    throw new AppError(status.NOT_FOUND, "Farm not found!");
  }

  const updated = await FarmModel.findOneAndUpdate(
    { _id: farm._id },
    { $set: { status: statusValue } },
    { returnDocument: 'after', runValidators: true },
  );
  if (!updated) {
    throw new AppError(status.NOT_FOUND, "Farm not found!");
  }

  if (farm.status !== statusValue) {
    await recordAuditLog(farmEvent(context, farm._id, "Farm Status Changed", {
      oldData: { status: farm.status },
      newData: { status: statusValue },
      changedFields: ["status"],
    }));
  }

  await updated.populate("ownerId", "userId fullName email phone");
  return updated;
};

const transferFarmOwnership = async (farmId: string, requesterUserId: string, newOwnerIdentifier: string, context?: TAuditContext): Promise<TFarm> => {
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

  //snapshot active memberships first — Mongo transactions are not available on every
  //deployment, so a failed ownership write is compensated manually (Farm spec §12)
  const previousOwnerMembership = await FarmMemberModel.findOne({
    farmId: farm._id,
    userId: farm.ownerId,
    isActive: true,
  })
    .select("role isActive")
    .lean();
  const nextOwnerMembership = await FarmMemberModel.findOne({
    farmId: farm._id,
    userId: newOwner._id,
    isActive: true,
  })
    .select("role isActive")
    .lean();

  const transfer = farmEvent(context, farm._id, "Farm Ownership Transferred", {
    oldData: { ownerId: farm.ownerId },
    newData: { ownerId: newOwner._id },
    changedFields: ["ownerId"],
  });
  let updated;
  try {
    //1. new owner becomes the ACTIVE Owner member (created if they never joined the farm)
    await FarmMemberServices.ensureOwnerMembership(farm._id, newOwner._id, {
      assignedBy: requester._id,
    });
    //2. old owner keeps a normal membership role (spec: Old Owner -> Manager)
    if (previousOwnerMembership) {
      await FarmMemberModel.updateOne(
        { _id: previousOwnerMembership._id },
        { $set: { role: FarmMemberRoles.MANAGER } },
        { runValidators: true },
      );
    }
    //3. ownerId is immutable in the schema, so the transfer must opt in to overwrite it
    updated = await FarmModel.findOneAndUpdate(
      { _id: farm._id },
      { $set: { ownerId: newOwner._id } },
      { returnDocument: 'after', runValidators: true, overwriteImmutable: true },
    );
    if (!updated) {
      throw new AppError(status.NOT_FOUND, "Farm not found!");
    }
    //4. no transfer without its audit row
    await recordAuditLog({ ...transfer, session: null });
  } catch (error) {
    //best-effort compensation: restore owner and both membership roles as they were before step 1
    await FarmModel.updateOne(
      { _id: farm._id },
      { $set: { ownerId: farm.ownerId } },
      { overwriteImmutable: true },
    ).catch(() => undefined);
    if (previousOwnerMembership) {
      await FarmMemberModel.updateOne(
        { _id: previousOwnerMembership._id },
        {
          $set: {
            role: previousOwnerMembership.role,
            isActive: previousOwnerMembership.isActive,
          },
        },
      ).catch(() => undefined);
    }
    if (nextOwnerMembership) {
      await FarmMemberModel.updateOne(
        { _id: nextOwnerMembership._id },
        {
          $set: {
            role: nextOwnerMembership.role,
            isActive: nextOwnerMembership.isActive,
          },
        },
      ).catch(() => undefined);
    } else {
      await FarmMemberModel.deleteOne({
        farmId: farm._id,
        userId: newOwner._id,
        isActive: true,
        role: FarmMemberRoles.OWNER,
      }).catch(() => undefined);
    }
    await recordRolledBack(transfer);
    throw error;
  }

  //the old owner's live access was granted as Owner
  removeUserFromFarm(farm.ownerId, farm._id);
  await updated.populate("ownerId", "userId fullName email phone profilePicture");
  return updated;
};

//----- delete: suspend (soft, default) or permanent (only for an already Suspended farm) -----

export const FarmDeleteModes = {
  SUSPEND: "suspend",
  PERMANENT: "permanent",
} as const;

/**
 * Every farm-scoped collection removed by a permanent delete, in delete order
 * (leaf records first, memberships last). Audit logs are intentionally kept as
 * the platform's evidence trail; the deletion itself is audited.
 */
const FARM_DATA_SOURCES = [
  { key: "expenses", model: ExpenseModel },
  { key: "incomes", model: IncomeModel },
  { key: "feedRecords", model: FeedRecordModel },
  { key: "milkRecords", model: MilkRecordModel },
  { key: "weightRecords", model: WeightRecordModel },
  { key: "vaccinations", model: VaccinationModel },
  { key: "treatments", model: TreatmentModel },
  { key: "pregnancies", model: PregnancyModel },
  { key: "breedings", model: BreedingModel },
  { key: "feedRecommendations", model: FeedRecommendationModel },
  { key: "inventoryTransactions", model: InventoryTransactionModel },
  { key: "inventories", model: InventoryModel },
  { key: "notifications", model: NotificationModel },
  { key: "deviceAssignments", model: DeviceAssignmentModel },
  { key: "devices", model: DeviceModel },
  { key: "animals", model: AnimalModel },
  { key: "members", model: FarmMemberModel },
] as const;

type TFarmDataKey = (typeof FARM_DATA_SOURCES)[number]["key"];
export type TFarmDataCounts = Record<TFarmDataKey, number> & { total: number };

//loose model type so the heterogeneous Mongoose models can share one loop
const farmScopedModel = (model: unknown) => model as Model<{ farmId: Types.ObjectId }>;

const countFarmData = async (farmObjectId: Types.ObjectId): Promise<TFarmDataCounts> => {
  const counts = await Promise.all(
    FARM_DATA_SOURCES.map((source) =>
      farmScopedModel(source.model).countDocuments({ farmId: farmObjectId }),
    ),
  );
  const result = { total: 0 } as TFarmDataCounts;
  FARM_DATA_SOURCES.forEach((source, index) => {
    const count = counts[index] ?? 0;
    result[source.key] = count;
    result.total += count;
  });
  return result;
};

/**
 * Who may suspend / permanently delete a farm:
 *  - platform admin or superAdmin (any farm)
 *  - the farm's owner account (Farm.ownerId) — their own farm only
 * Managers and other members never can.
 */
const getFarmForDeletion = async (farmId: string, requesterUserId: string) => {
  const requester = await UserModel.findOne({ userId: requesterUserId, isActive: true, isDeleted: false }).select("_id systemRole");
  if (!requester) {
    throw new AppError(status.FORBIDDEN, "Only an active user can delete a farm!");
  }

  const farm = await FarmModel.findOne(getFarmFilter(farmId));
  if (!farm) {
    throw new AppError(status.NOT_FOUND, "Farm not found!");
  }

  const isPlatformAdmin =
    requester.systemRole === SystemRoles.ADMIN || requester.systemRole === SystemRoles.SUPER_ADMIN;
  if (!isPlatformAdmin && !farm.ownerId.equals(requester._id)) {
    throw new AppError(status.FORBIDDEN, "Only the farm owner or a platform admin can delete this farm!");
  }

  return farm;
};

//GET /farms/:farmId/deletion-impact — what a permanent delete would remove (owner / admins)
const getFarmDeletionImpact = async (farmId: string, requesterUserId: string) => {
  const farm = await getFarmForDeletion(farmId, requesterUserId);
  const counts = await countFarmData(farm._id);
  return {
    _id: farm._id,
    farmId: farm.farmId,
    farmName: farm.farmName,
    status: farm.status,
    counts,
    //business rule: only a Suspended farm may be permanently deleted
    canPermanentDelete: farm.status === FarmStatuses.ARCHIVED,
  };
};

/**
 * DELETE /farms/:farmId?mode=suspend|permanent
 *  - suspend (default): status → Suspended. The farm becomes read-only; only a
 *    platform admin can reactivate it (PATCH /:farmId/status).
 *  - permanent: removes the farm and all of its farm-scoped data from the
 *    database. Allowed only when the farm is already Suspended (409 otherwise).
 *    Children are deleted first and the Farm document last, so a failure part-way
 *    leaves the farm in place and the same request can simply be retried.
 */
const deleteFarm = async (
  farmId: string,
  requesterUserId: string,
  modeValue: unknown,
  context: TAuditContext,
) => {
  const mode = modeValue === undefined || modeValue === "" ? FarmDeleteModes.SUSPEND : String(modeValue);
  if (mode !== FarmDeleteModes.SUSPEND && mode !== FarmDeleteModes.PERMANENT) {
    throw new AppError(status.BAD_REQUEST, "mode must be either 'suspend' or 'permanent'!");
  }

  const farm = await getFarmForDeletion(farmId, requesterUserId);

  if (mode === FarmDeleteModes.SUSPEND) {
    if (farm.status === FarmStatuses.ARCHIVED) {
      throw new AppError(status.BAD_REQUEST, "This farm is already suspended!");
    }
    const updated = await FarmModel.findOneAndUpdate(
      { _id: farm._id },
      { $set: { status: FarmStatuses.ARCHIVED } },
      { returnDocument: "after", runValidators: true },
    );
    if (!updated) {
      throw new AppError(status.NOT_FOUND, "Farm not found!");
    }
    await recordAuditLog({
      context,
      farmId: farm._id,
      entityType: AuditEntityTypes.FARM,
      entityId: farm._id,
      action: AuditActions.ARCHIVE,
      module: AuditModules.FARM,
      event: "Farm Suspended",
      oldData: { status: farm.status },
      newData: { status: FarmStatuses.ARCHIVED },
      changedFields: ["status"],
    });
    await updated.populate("ownerId", "userId fullName email phone");
    return { mode: "suspended" as const, farm: updated, deleted: null };
  }

  if (farm.status !== FarmStatuses.ARCHIVED) {
    throw new AppError(
      status.CONFLICT,
      "Only a suspended farm can be permanently deleted. Suspend the farm first.",
    );
  }

  //InventoryTransaction rows are "never delete" ledger evidence for a living farm;
  //a permanent farm delete is the one explicit exception.
  const deleted = { total: 0 } as TFarmDataCounts;
  for (const source of FARM_DATA_SOURCES) {
    const result = await farmScopedModel(source.model).deleteMany({ farmId: farm._id });
    deleted[source.key] = result.deletedCount ?? 0;
    deleted.total += deleted[source.key];
  }

  //receipt files of the deleted expenses / incomes
  await removeFarmAttachments(farm._id);

  const oldData = farm.toObject() as unknown as Record<string, unknown>;
  await FarmModel.deleteOne({ _id: farm._id });
  closeFarmRooms(farm._id);

  await recordAuditLog({
    context,
    farmId: farm._id,
    entityType: AuditEntityTypes.FARM,
    entityId: farm._id,
    action: AuditActions.DELETE,
    module: AuditModules.FARM,
    event: "Farm Permanently Deleted",
    oldData,
    newData: { deletedRecords: deleted },
  });

  return { mode: "deleted" as const, farm: null, deleted };
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
  getFarmDeletionImpact,
  deleteFarm,
};
