import { Router } from "express";
import { userRouter } from "../modules/auth/auth.route.js";
import { farmRouter } from "../modules/farm/farm.route.js";

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
];

moduleRoutes.forEach((route) => router.use(route.path, route.route));

export default router;
