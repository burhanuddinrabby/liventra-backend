import type { Request, Response } from "express";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import status from "http-status";
import { UserServices } from "./auth.services.js";

const createUser = catchAsync(async (req: Request, res: Response) => {
    const { body } = req;
    const user = await UserServices.createUserIntoDB(req?.file, body);
    sendResponse(res, {
        statusCode: status.OK,
        success: true,
        message: "User created successfully!!",
        data: user
    });
});

const loginUser = catchAsync(async (req: Request, res: Response) => {
    //loginMethod can be email or phone (direct value from request body)
    const { loginMethod, password } = req.body;
    const { accessToken, refreshToken, emailVerified, phoneVerified } = await UserServices.loginUser(loginMethod, password);
    sendResponse(res, {
        statusCode: status.OK,
        success: true,
        message: "User logged in successfully!!",
        data: {
            accessToken,
            refreshToken,
            emailVerified,
            phoneVerified
        }
    });
});

export const UserController = {
    createUser,
    loginUser
};