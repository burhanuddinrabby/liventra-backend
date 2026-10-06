import type { Request, Response } from "express";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import status from "http-status";
import { UserServices } from "./auth.services.js";
import config from "../../config/index.js";

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
    const { email, password } = req.body;
    const { accessToken, refreshToken, emailVerified, phoneVerified } = await UserServices.loginUser(email, password);

    res.cookie('refreshToken', refreshToken, {
        secure: config.node_env === 'production',
        httpOnly: true,
        // sameSite: 'none',
        // maxAge: 1000 * 60 * 60 * 24 * 365
    });

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

const getProfile = catchAsync(async (req: Request, res: Response) => {
    const user = await UserServices.getProfile(req.user.userId);
    sendResponse(res, {
        statusCode: status.OK,
        success: true,
        message: "Profile fetched successfully!!",
        data: user
    });
});

const updateProfile = catchAsync(async (req: Request, res: Response) => {
    const user = await UserServices.updateProfile(req.user.userId, req.body);
    
    sendResponse(res, {
        statusCode: status.OK,
        success: true,
        message: "Profile updated successfully!!",
        data: user
    });
});

const updateProfilePicture = catchAsync(async (req: Request, res: Response) => {
    const user = await UserServices.updateProfilePicture(req.user.userId, req?.file);

    sendResponse(res, {
        statusCode: status.OK,
        success: true,
        message: "Profile picture updated successfully!!",
        data: user
    });
});

const changePassword = catchAsync(async (req: Request, res: Response) => {
    await UserServices.changePassword(req.user.userId, req.body);

    sendResponse(res, {
        statusCode: status.OK,
        success: true,
        message: "Password changed successfully!!"
    });
});

const getAllUsers = catchAsync(async (req: Request, res: Response) => {
    const { meta, users } = await UserServices.getAllUsers(req.query as Record<string, string>);

    sendResponse(res, {
        statusCode: status.OK,
        success: true,
        message: "Users retrieved successfully!!",
        meta,
        data: users
    });
});

const getUserById = catchAsync(async (req: Request, res: Response) => {
    const user = await UserServices.getUserById(req.params.id as string);
    sendResponse(res, {
        statusCode: status.OK,
        success: true,
        message: "User retrieved successfully!!",
        data: user
    });
});

export const UserController = {
    createUser,
    loginUser,
    getProfile,
    updateProfile,
    updateProfilePicture,
    changePassword,
    getAllUsers,
    getUserById
};