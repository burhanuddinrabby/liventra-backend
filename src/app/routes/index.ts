import { Router } from "express";
import { userRouter } from "../modules/auth/auth.route.js";
import { adminAuditLogRouter } from "../modules/auditLog/auditLog.route.js";
import { breedRouter } from "../modules/breed/breed.route.js";
import { farmRouter } from "../modules/farm/farm.route.js";
import { feedIngredientRouter } from "../modules/feedIngredient/feedIngredient.route.js";
import { feedFormulaRouter } from "../modules/feedFormula/feedFormula.route.js";
import { vaccineRouter } from "../modules/vaccine/vaccine.route.js";
import { diseaseRouter } from "../modules/disease/disease.route.js";
import { notificationRouter } from "../modules/notification/notification.route.js";
import { medicineRouter } from "../modules/medicine/medicine.route.js";

const router = Router();

type TRoute = {
  path: string;
  route: any;
};

const moduleRoutes: TRoute[] = [
  // const moduleRoutes = [
  {
    path: "/users",
    route: userRouter,
  },
  {
    path: "/farms",
    route: farmRouter,
  },
  {
    path: "/breeds",
    route: breedRouter,
  },
  {
    path: "/feed-ingredients",
    route: feedIngredientRouter,
  },
  {
    path: "/feed-formulas",
    route: feedFormulaRouter,
  },
  {
    path: "/vaccines",
    route: vaccineRouter,
  },
  {
    path: "/diseases",
    route: diseaseRouter,
  },
  {
    path: "/medicines",
    route: medicineRouter,
  },
  {
    path: "/notifications",
    route: notificationRouter,
  },
  {
    path: "/admin/audit-logs",
    route: adminAuditLogRouter,
  },
];

moduleRoutes.forEach((route) => router.use(route.path, route.route));

export default router;
