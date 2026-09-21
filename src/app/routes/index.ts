import { Router } from "express";
import { userRouter } from "../modules/auth/auth.route.js";

const router = Router();

type TRoute = {
    path: string;
    route: any
}

const moduleRoutes: TRoute[] = [
    // const moduleRoutes = [
    {
        path: '/users',
        route: userRouter
    },
]

moduleRoutes.forEach(route => router.use(route.path, route.route));

export default router;