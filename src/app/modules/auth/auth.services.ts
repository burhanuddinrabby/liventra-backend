import status from "http-status";
import AppError from "../../errors/AppError.js";
import type { TUser } from "./auth.interface.js";
import { UserModel } from "./auth.model.js";
import { createToken, generateUserId } from "./auth.utils.js";
import bcrypt from 'bcrypt';
import config from "../../config/index.js";
import type { SignOptions } from "jsonwebtoken";
import { uploadImageToCloudinary } from "../../utils/uploadImage.js";

// const createUserIntoDB = async (userData: TUser) => {
const createUserIntoDB = async (file:any,userData: TUser): Promise<TUser> => {
    userData.userId = await generateUserId();
    if(file){
        const imgName = `${userData?.fullName}-${userData?.userId}-img`;
        const filePath = file?.path;
        const image = await uploadImageToCloudinary(imgName, filePath);
        userData.profilePicture = image?.secure_url as string;
    } else {
        userData.profilePicture = userData?.profilePicture || '';
    }
    return userData;
    // const result = await UserModel.create(userData);
    // return result;
}

//login
const loginUser = async (loginMethod: string, password: string): Promise<{
    accessToken: string;
    refreshToken: string;
    emailVerified?: boolean;
    phoneVerified?: boolean;
}> => {
    let user;
    const byEmail = await UserModel.findOne({ phone: loginMethod });
    if (!byEmail) {
        const byPhone = await UserModel.findOne({ phone: loginMethod });
        if (!byPhone) {
            throw new AppError(status.NOT_FOUND, 'User not found!');
        }
        user = byPhone;
    } else {
        user = byEmail;
    }
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
        throw new AppError(status.FORBIDDEN, 'Wrong password!');
    }
    const jwtPayload = {
        userId: user.userId,
        role: user.systemRole as string,
    }
    //update last login time
    await UserModel.updateOne({ userId: user.userId }, { lastLogin: new Date() });

    const accessToken = createToken(jwtPayload, config.jwt_access_token as string, config.jwt_access_token_exp as SignOptions["expiresIn"]);

    const refreshToken = createToken(jwtPayload, config.jwt_refresh_token as string, config.jwt_refresh_token_exp as SignOptions["expiresIn"]);;

    return {
        accessToken,
        refreshToken,
        emailVerified: user.emailVerified,
        phoneVerified: user.phoneVerified
    }
}

export const UserServices = {
    createUserIntoDB,
    loginUser
}