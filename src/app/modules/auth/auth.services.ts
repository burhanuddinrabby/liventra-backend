import status from "http-status";
import AppError from "../../errors/AppError.js";
import type { TUser } from "./auth.interface.js";
import { UserModel } from "./auth.model.js";
import { createToken, generateUserId } from "./auth.utils.js";
import bcrypt from 'bcrypt';
import config from "../../config/index.js";
import type { SignOptions } from "jsonwebtoken";
import { uploadImageToCloudinary } from "../../utils/uploadImage.js";
import QueryBuilder from "../../builder/QueryBuilder.js";

// const createUserIntoDB = async (userData: TUser) => {
const createUserIntoDB = async (file: any, userData: TUser): Promise<TUser> => {
    userData.userId = await generateUserId();
    if (file) {
        const imgName = `${userData?.fullName}-${userData?.userId}-img`;
        const filePath = file?.path;
        const image = await uploadImageToCloudinary(imgName, filePath);
        userData.profilePicture = image?.secure_url as string;
    } else {
        userData.profilePicture = userData?.profilePicture || '';
    }
    // return userData;
    const result = await UserModel.create(userData);
    return result;
}

//login
const loginUser = async (email: string, password: string): Promise<{
    accessToken: string;
    refreshToken: string;
    emailVerified?: boolean;
    phoneVerified?: boolean;
}> => {
    let user;
    const byEmail = await UserModel.findOne({ email });
    if (!byEmail) {
        const byPhone = await UserModel.findOne({ phone: email });
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

//get profile
const getProfile = async (userId: string): Promise<TUser> => {
    const user = await UserModel.findOne({ userId }).select('-password');
    if (!user) {
        throw new AppError(status.NOT_FOUND, 'User not found!');
    }
    return user;
}

//update basic personal information (fullName, gender, dateOfBirth, address)
const updateProfile = async (userId: string, payload: Partial<TUser>): Promise<TUser> => {
    const user = await UserModel.findOne({ userId });
    if (!user) {
        throw new AppError(status.NOT_FOUND, 'User not found!');
    }
    const { address, ...remaining } = payload;

    const modifiedData: Record<string, unknown> = { ...remaining };
    if (address && Object.keys(address).length) {
        for (const [key, value] of Object.entries(address)) {
            modifiedData[`address.${key}`] = value
        }
    }
    if (payload.dateOfBirth) {
        payload.dateOfBirth = new Date(payload.dateOfBirth as string | Date);
    }
    //if req user is not the actual user taken from token
    // if (user.userId !== payload.userId) {
    //     throw new AppError(status.FORBIDDEN, 'You are not authorized to update this profile!');
    // }
    const updated = await UserModel.findOneAndUpdate({ userId }, modifiedData, {
        new: true,
        // runValidators: true
    }).select('-password');
    if (!updated) {
        throw new AppError(status.NOT_FOUND, 'User not found, update failed!');
    }
    return updated;
}

//update or change profile picture
const updateProfilePicture = async (userId: string, file: any): Promise<TUser> => {
    const user = await UserModel.findOne({ userId });
    if (!user) {
        throw new AppError(status.NOT_FOUND, 'User not found!');
    }
    if (!file) {
        throw new AppError(status.BAD_REQUEST, 'No image file provided!');
    }
    const imgName = `${user.fullName}-${userId}-img`;
    const image = await uploadImageToCloudinary(imgName, file.path);
    const updated = await UserModel.findOneAndUpdate(
        { userId },
        { profilePicture: image?.secure_url as string },
        { new: true }
    ).select('-password');
    if (!updated) {
        throw new AppError(status.NOT_FOUND, 'User not found, update failed!');
    }
    return updated;
}

//get all users (paginated)
const getAllUsers = async (query: Record<string, unknown>) => {
    const searchFields = ['fullName', 'email', 'phone', 'userId'];
    const userQuery = new QueryBuilder(UserModel.find().select('-password'), query)
        .search(searchFields)
        .filter()
        .sort()
        .paginate()
        .fields();

    const meta = await userQuery.countTotal();
    const result = await userQuery.modelQuery.lean();

    // if (!result || result.length === 0) {
    //     throw new AppError(status.NOT_FOUND, 'No users found!');
    // }
    return {
        meta,
        users: result
    };
};

//get a single user's full details by userId
const getUserById = async (userId: string): Promise<TUser> => {
    const user = await UserModel.findOne({ userId }).select('-password');
    if (!user) {
        throw new AppError(status.NOT_FOUND, 'User not found!');
    }
    return user;
};

export const UserServices = {
    createUserIntoDB,
    loginUser,
    getProfile,
    updateProfile,
    updateProfilePicture,
    getAllUsers,
    getUserById
}