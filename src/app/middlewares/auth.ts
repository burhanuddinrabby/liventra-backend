// import status from "http-status";
// import AppError from "../errors/AppError.js";
// import catchAsync from "../utils/catchAsync.js";
// import jwt, { JwtPayload } from 'jsonwebtoken';
// import config from "../config/index.js";

import status from "http-status";
import AppError from "../errors/AppError.js";
import catchAsync from "../utils/catchAsync.js";
import config from "../config/index.js";
import type { JwtPayload } from "jsonwebtoken";
import jwt from "jsonwebtoken";
import { UserModel } from "../modules/auth/auth.model.js";

const auth = (...roles: string[]) => {
    return catchAsync(async (req, res, next) => {
        const token = req.headers.authorization?.split(" ")[1]
        if (!token) {
            throw new AppError(status.FORBIDDEN, 'You\'re not authorized!')
        }

        let decoded;
        try {
            decoded = jwt.verify(token, config.jwt_access_token as string) as JwtPayload;
        // eslint-disable-next-line no-unused-vars
        } catch (error) {
            throw new AppError(status.UNAUTHORIZED, 'You\'re not authorized!');
        }

        // const isUserExist = await isUserExistVerification(decoded.id);

        // if (isUserExist?.passwordChangedAt) {
        //     const tokenIsExpired = await UserModel.isJWTIssuedBeforePasswordChanged(isUserExist?.passwordChangedAt, decoded.iat as number)
        //     if (tokenIsExpired) {
        //         throw new AppError(status.FORBIDDEN, 'You\'re not authorized!');
        //     }
        // }

        const user = await UserModel.findOne({ userId: decoded.userId });
        if (!user || !user.isActive) {
            throw new AppError(status.NOT_FOUND, '-User not found or inactive!');
        }
        if (roles.length > 0 && !roles.includes(user?.systemRole ?? '')) {
            throw new AppError(status.FORBIDDEN, 'You\'re not authorized!');
        }
        req.user = decoded;
        next();
    })
}

export default auth;