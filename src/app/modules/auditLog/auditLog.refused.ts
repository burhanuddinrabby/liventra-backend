import type { Request } from "express";
import { isValidObjectId } from "mongoose";
import { FarmModel } from "../farm/farm.model.js";
import { AuditActions, AuditEntityTypes, AuditModules, AuditStatuses } from "./auditLog.constants.js";
import type { TAuditAction, TAuditEntityType, TAuditModule } from "./auditLog.interface.js";
import { allowAuditOnce, auditContextFromRequest, recordAuditLog } from "./auditLog.utils.js";

type TTarget = [TAuditEntityType, TAuditModule];

const { ANIMAL, FEED, HEALTH, INVENTORY, FINANCE, FARM } = AuditModules;

const TARGETS: Record<string, TTarget> = {
  members: [AuditEntityTypes.FARM_MEMBER, FARM],
  animals: [AuditEntityTypes.ANIMAL, ANIMAL],
  "feed-recommendations": [AuditEntityTypes.FEED_RECOMMENDATION, FEED],
  "feed-records": [AuditEntityTypes.FEED_RECORD, FEED],
  "milk-records": [AuditEntityTypes.MILK_RECORD, ANIMAL],
  "weight-records": [AuditEntityTypes.WEIGHT_RECORD, ANIMAL],
  vaccinations: [AuditEntityTypes.VACCINATION, HEALTH],
  treatments: [AuditEntityTypes.TREATMENT, HEALTH],
  breedings: [AuditEntityTypes.BREEDING, ANIMAL],
  pregnancies: [AuditEntityTypes.PREGNANCY, ANIMAL],
  inventory: [AuditEntityTypes.INVENTORY, INVENTORY],
  "inventory-transactions": [AuditEntityTypes.INVENTORY_TRANSACTION, INVENTORY],
  expenses: [AuditEntityTypes.EXPENSE, FINANCE],
  incomes: [AuditEntityTypes.INCOME, FINANCE],
  notifications: [AuditEntityTypes.NOTIFICATION, FARM],
  devices: [AuditEntityTypes.DEVICE, FARM],
};

const ACTIONS: Record<string, TAuditAction> = {
  POST: AuditActions.CREATE,
  PUT: AuditActions.UPDATE,
  PATCH: AuditActions.UPDATE,
  DELETE: AuditActions.DELETE,
};

/**
 * One `Failed` row when farm access refuses a write (403). Reads and validation errors are
 * not recorded; a repeated attempt is written once a minute per user, entity and action.
 */
export const recordRefusedWrite = async (req: Request): Promise<void> => {
  try {
    const action = ACTIONS[req.method];
    const match = /^\/api\/v1\/farms\/([^/?]+)([^?]*)/.exec(req.originalUrl);
    //req.user is set only after the token was accepted
    if (!action || !match || !req.user?.userId) return;

    //a nested path names its record last: animals/<id>/treatments
    let [entityType, module]: TTarget = [AuditEntityTypes.FARM, FARM];
    let entityId: string | null = null;
    for (const part of (match[2] ?? "").split("/").filter(Boolean)) {
      const target = TARGETS[part];
      if (target) {
        [entityType, module] = target;
        entityId = null;
      } else if (isValidObjectId(part) && part.length === 24) {
        entityId = part;
      } else if (part === "preview") {
        return;
      }
    }

    const farmRef = decodeURIComponent(match[1] ?? "");
    const farm = await FarmModel.findOne(
      isValidObjectId(farmRef) ? { $or: [{ _id: farmRef }, { farmId: farmRef }] } : { farmId: farmRef },
    )
      .select("_id")
      .lean();
    if (!farm) return;
    if (!allowAuditOnce(`refused:${req.user.userId}:${String(farm._id)}:${entityType}:${action}`)) return;

    await recordAuditLog({
      context: auditContextFromRequest(req),
      farmId: farm._id,
      entityType,
      entityId: entityId ?? (entityType === AuditEntityTypes.FARM ? farm._id : null),
      action,
      module,
      event: "Permission Denied",
      status: AuditStatuses.FAILED,
    });
  } catch (error) {
    console.error("Failed to record a refused write:", error);
  }
};
