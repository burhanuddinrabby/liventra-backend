import status from "http-status";
import AppError from "../../errors/AppError.js";
import type { TUser } from "./auth.interface.js";
import { UserModel } from "./auth.model.js";
import { createToken, generateUserId } from "./auth.utils.js";
import bcrypt from 'bcrypt';
import config from "../../config/index.js";
import type { SignOptions } from "jsonwebtoken";
import { uploadImageToCloudinary } from "../../utils/uploadImage.js";
import { sendMails } from "../../utils/sendMail.js";
import QueryBuilder from "../../builder/QueryBuilder.js";
import crypto from 'crypto';

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

//forgot password: email a time-limited reset link (only the token hash is stored)
const forgotPassword = async (email: string): Promise<void> => {
    const user = await UserModel.findOne({ email });
    //no-op for unknown/inactive accounts so the response can't be used to probe registered emails
    if (!user) {
        throw new AppError(status.NOT_FOUND, 'User not found!');
    }
    if (!user.isActive || user.isDeleted) {
        throw new AppError(status.FORBIDDEN, 'Account is inactive or deleted!');
    }

    const RESET_TOKEN_TTL = '10m';
    const RESET_TOKEN_EXP_MS = 10 * 60 * 1000;

    //signed with the refresh secret so a leaked reset link token can never pass the access-token auth middleware
    const resetToken = createToken(
        { userId: user.userId, role: user.systemRole as string, type: 'password-reset' },
        config.jwt_refresh_token as string,
        RESET_TOKEN_TTL as SignOptions["expiresIn"]
    );

    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    //findOneAndUpdate — pre('save') re-hashes user.password on every save
    await UserModel.findOneAndUpdate(
        { userId: user.userId },
        {
            passwordResetToken: hashedToken,
            passwordResetTokenExpiry: new Date(Date.now() + RESET_TOKEN_EXP_MS)
        }
    );

    const resetLink = `${config.reset_ui_link}?token=${resetToken}`;
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
            <h2 style="color: #111827;">Reset your password</h2>
            <p style="color: #374151;">Hello ${user.fullName},</p>
            <p style="color: #374151;">
                We received a request to reset the password for <strong>${user.email}</strong>.
                Click the button below to choose a new password. The link is valid for <strong>10 minutes</strong>.
            </p>
            <p style="margin: 28px 0;">
                <a href="${resetLink}"
                   style="background-color: #16a34a; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; display: inline-block;">
                    Reset Password
                </a>
            </p>
            <p style="color: #6b7280; font-size: 13px;">
                If the button doesn't work, copy and paste this link into your browser:<br/>
                <a href="${resetLink}" style="color: #2563eb; word-break: break-all;">${resetLink}</a>
            </p>
            <p style="color: #6b7280; font-size: 13px;">
                If you didn't request this, you can safely ignore this email — your password will not change.
            </p>
        </div>
    `;
    await sendMails.sendPassResetMail(user.email, html);
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
const updateProfilePicture = async (userId: string, file: any, url: string | undefined): Promise<TUser> => {
    const user = await UserModel.findOne({ userId });
    if (!user) {
        throw new AppError(status.NOT_FOUND, 'User not found!');
    }
    if (file) {
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
    if (url) {
        const updated = await UserModel.findOneAndUpdate(
            { userId },
            { profilePicture: url },
            { new: true }
        ).select('-password');
        if (!updated) {
            throw new AppError(status.NOT_FOUND, 'User not found, update failed!');
        }
        return updated;
    }
    throw new AppError(status.BAD_REQUEST, 'No file or URL provided for profile picture update!');
}

//change password (after validating current password)
const changePassword = async (userId: string, payload: { currentPassword: string; newPassword: string }): Promise<void> => {
    const user = await UserModel.findOne({ userId });
    if (!user) {
        throw new AppError(status.NOT_FOUND, 'User not found!');
    }
    const isCurrentPasswordValid = await bcrypt.compare(payload.currentPassword, user.password);
    if (!isCurrentPasswordValid) {
        throw new AppError(status.FORBIDDEN, 'Current password is incorrect!');
    }
    //pre-save hook hashes the password
    user.password = payload.newPassword;
    await user.save();
}

//update system-level role (user, admin, superAdmin)
const updateSystemRole = async (userId: string, systemRole: string): Promise<TUser> => {
    const updated = await UserModel.findOneAndUpdate(
        { userId },
        { systemRole },
        { new: true }
    ).select('-password');
    if (!updated) {
        throw new AppError(status.NOT_FOUND, 'User not found!');
    }
    return updated;
}

//activate / deactivate an account
const toggleActive = async (userId: string): Promise<TUser> => {
    const user = await UserModel.findOne({ userId });
    if (!user) {
        throw new AppError(status.NOT_FOUND, 'User not found!');
    }
    const updated = await UserModel.findOneAndUpdate(
        { userId },
        { isActive: !user.isActive },
        { new: true }
    ).select('-password');
    if (!updated) {
        throw new AppError(status.NOT_FOUND, 'User not found, update failed!');
    }
    return updated;
}

//soft delete a user account
const deleteUser = async (userId: string): Promise<TUser> => {
    const updated = await UserModel.findOneAndUpdate(
        { userId },
        { isActive: false, isDeleted: true },
        { new: true }
    ).select('-password');
    if (!updated) {
        throw new AppError(status.NOT_FOUND, 'User not found!');
    }
    return updated;
}

//get all users (paginated)
const getAllUsers = async (query: Record<string, unknown>) => {
    const searchFields = ['fullName', 'email', 'phone', 'userId'];
    const userQuery = new QueryBuilder(UserModel.find({
        isDeleted: false
    }).select('-password'), query)
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
    forgotPassword,
    getProfile,
    updateProfile,
    updateProfilePicture,
    changePassword,
    updateSystemRole,
    toggleActive,
    deleteUser,
    getAllUsers,
    getUserById
}