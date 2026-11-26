import express, { type NextFunction, type Request, type Response } from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { FarmController } from "./farm.controller.js";
import { farmValidations } from "./farm.validations.js";
import { upload } from "../../utils/uploadImage.js";
import { farmMemberRouter } from "../farmMember/farmMember.route.js";
import { animalRouter } from "../animal/animal.route.js";
import {
  animalFeedRecommendationRouter,
  feedRecommendationRouter,
} from "../feedRecommendation/feedRecommendation.route.js";
import { animalFeedRecordRouter, feedRecordRouter } from "../feedRecord/feedRecord.route.js";
import { animalMilkRecordRouter, milkRecordRouter } from "../milkRecord/milkRecord.route.js";
import { animalWeightRecordRouter, weightRecordRouter } from "../weightRecord/weightRecord.route.js";
import { animalVaccinationRouter, vaccinationRouter } from "../vaccination/vaccination.route.js";
import { animalTreatmentRouter, treatmentRouter } from "../treatment/treatment.route.js";
import { animalBreedingRouter, breedingRouter } from "../breeding/breeding.route.js";
import { animalPregnancyRouter, pregnancyRouter } from "../pregnancy/pregnancy.route.js";
import { inventoryRouter, inventoryTransactionRouter } from "../inventory/inventory.route.js";
import { auditLogRouter } from "../auditLog/auditLog.route.js";
import { farmNotificationRouter } from "../notification/notification.route.js";
import { deviceRouter } from "../device/device.route.js";
import { expenseRouter } from "../expense/expense.route.js";
import { financeRouter, incomeRouter } from "../income/income.route.js";

const farmRouter = express.Router();
const authenticatedRoles = [
  SystemRoles.SUPER_ADMIN,
  SystemRoles.ADMIN,
  SystemRoles.USER,
];

// POST /api/v1/farms
farmRouter.post(
  "/",
  auth(...authenticatedRoles),
  upload.single("logo"), (req: Request, res: Response, next: NextFunction) => {
    req.body = JSON.parse(req?.body?.data);
    next();
  },
  validateRequest(farmValidations.createFarmValidation),
  FarmController.createFarm,
);
// GET /api/v1/farms — platform administrators only: all registered farms, paginated
farmRouter.get(
  "/",
  auth(SystemRoles.ADMIN, SystemRoles.SUPER_ADMIN),
  FarmController.getAllFarms,
);

// GET /api/v1/farms/my-farms — every farm where the user has an active membership, with their role
farmRouter.get("/my-farms", auth(...authenticatedRoles), FarmController.getMyFarms);

// /api/v1/farms/:farmId/members — FarmMember module (mergeParams gives it :farmId)
farmRouter.use("/:farmId/members", farmMemberRouter);

// /api/v1/farms/:farmId/feed-recommendations — FeedRecommendation module (mergeParams gives it :farmId)
farmRouter.use("/:farmId/feed-recommendations", feedRecommendationRouter);
// animal timeline; mounted before the animal router so it is matched first
farmRouter.use("/:farmId/animals/:animalId/feed-recommendations", animalFeedRecommendationRouter);

// /api/v1/farms/:farmId/feed-records — FeedRecord module (actual feeding + inventory deduction)
farmRouter.use("/:farmId/feed-records", feedRecordRouter);
// animal feeding history; mounted before the animal router so it is matched first
farmRouter.use("/:farmId/animals/:animalId/feed-records", animalFeedRecordRouter);

// /api/v1/farms/:farmId/milk-records — MilkRecord module (actual milk production per session)
farmRouter.use("/:farmId/milk-records", milkRecordRouter);
// animal milk history; mounted before the animal router so it is matched first
farmRouter.use("/:farmId/animals/:animalId/milk-records", animalMilkRecordRouter);

// /api/v1/farms/:farmId/weight-records — WeightRecord module (growth + ADG chain)
farmRouter.use("/:farmId/weight-records", weightRecordRouter);
// animal growth trajectory; mounted before the animal router so it is matched first
farmRouter.use("/:farmId/animals/:animalId/weight-records", animalWeightRecordRouter);

// /api/v1/farms/:farmId/vaccinations — Vaccination module (schedules, doses, compliance)
farmRouter.use("/:farmId/vaccinations", vaccinationRouter);
// animal immunization history; mounted before the animal router so it is matched first
farmRouter.use("/:farmId/animals/:animalId/vaccinations", animalVaccinationRouter);

// /api/v1/farms/:farmId/treatments — Treatment module (clinical episodes, withdrawal, medicine stock)
farmRouter.use("/:farmId/treatments", treatmentRouter);
// animal treatment history; mounted before the animal router so it is matched first
farmRouter.use("/:farmId/animals/:animalId/treatments", animalTreatmentRouter);

// /api/v1/farms/:farmId/breedings — Breeding module (heat / insemination events, pregnancy-check results)
farmRouter.use("/:farmId/breedings", breedingRouter);
// animal breeding history; mounted before the animal router so it is matched first
farmRouter.use("/:farmId/animals/:animalId/breedings", animalBreedingRouter);

// /api/v1/farms/:farmId/pregnancies — Pregnancy module (gestation lifecycle, calving, outcomes)
farmRouter.use("/:farmId/pregnancies", pregnancyRouter);
// animal pregnancy history; mounted before the animal router so it is matched first
farmRouter.use("/:farmId/animals/:animalId/pregnancies", animalPregnancyRouter);

// Inventory (Model 19) — farm stock items; nested so farmId is always explicit
farmRouter.use("/:farmId/inventory", inventoryRouter);
// Inventory_Transaction (Model 20) — the farm's append-only stock ledger
farmRouter.use("/:farmId/inventory-transactions", inventoryTransactionRouter);

farmRouter.use("/:farmId/audit-logs", auditLogRouter);
farmRouter.use("/:farmId/notifications", farmNotificationRouter);
farmRouter.use("/:farmId/devices", deviceRouter);
//finance: expenses, incomes and the profit / loss report
farmRouter.use("/:farmId/expenses", expenseRouter);
farmRouter.use("/:farmId/incomes", incomeRouter);
farmRouter.use("/:farmId/finance", financeRouter);

// /api/v1/farms/:farmId/animals — Animal module (mergeParams gives it :farmId)
farmRouter.use("/:farmId/animals", animalRouter);

// GET /api/v1/farms/:farmId — any active member of the targeted farm
farmRouter.get(
  "/:farmId",
  auth(...authenticatedRoles),
  FarmController.getFarmById,
);

// PUT /api/v1/farms/:farmId — farm owner or manager only
farmRouter.put(
  "/:farmId",
  auth(...authenticatedRoles),
  validateRequest(farmValidations.updateFarmValidation),
  FarmController.updateFarm,
);

// PATCH /api/v1/farms/:farmId/logo — multipart "logo" file and/or a logo URL in the body
farmRouter.patch(
  "/:farmId/logo",
  auth(...authenticatedRoles),
  upload.single("logo"),
  validateRequest(farmValidations.updateFarmLogoValidation),
  FarmController.updateFarmLogo,
);

// PATCH /api/v1/farms/:farmId/status — platform administrators only
farmRouter.patch(
  "/:farmId/status",
  auth(SystemRoles.ADMIN, SystemRoles.SUPER_ADMIN),
  validateRequest(farmValidations.statusValidation),
  FarmController.updateFarmStatus,
);

// POST /api/v1/farms/:farmId/transfer-ownership — farm owner or super admin only
farmRouter.post(
  "/:farmId/transfer-ownership",
  auth(...authenticatedRoles),
  validateRequest(farmValidations.transferOwnershipValidation),
  FarmController.transferFarmOwnership,
);

// GET /api/v1/farms/:farmId/deletion-impact — farm owner or admin/superAdmin (checked in the service)
farmRouter.get(
  "/:farmId/deletion-impact",
  auth(...authenticatedRoles),
  FarmController.getFarmDeletionImpact,
);

// DELETE /api/v1/farms/:farmId?mode=suspend|permanent — farm owner or admin/superAdmin.
// suspend (default) sets status Suspended; permanent removes a Suspended farm and all its data.
farmRouter.delete(
  "/:farmId",
  auth(...authenticatedRoles),
  FarmController.deleteFarm,
);
/*

// PATCH /api/v1/farms/:id/deactivate
farmRouter.patch(
  "/:id/deactivate",
  auth(...authenticatedRoles),
  FarmController.deactivateFarm,
);

// PATCH /api/v1/farms/:id/reactivate
farmRouter.patch(
  "/:id/reactivate",
  auth(...authenticatedRoles),
  FarmController.reactivateFarm,
); */

export { farmRouter };


/*

PATCH   /api/v1/farms/:farmId/logo   Owner/Manager    Uploads or updates the farm logo URL used in UI dashboards and exported PDF reports.

GET    /api/v1/farms   Admin / SuperAdmin    System admin endpoint to query/list all registered farms across the platform with pagination.

PATCH   /api/v1/farms/:farmId/status   Admin / SuperAdmin    Updates administrative status (Active, Inactive, Suspended).

POST    /api/v1/farms/:farmId/transfer-ownership   Owner / SuperAdmin    Reassigns ownerId and synchronizes the corresponding FarmMember roles.

*/