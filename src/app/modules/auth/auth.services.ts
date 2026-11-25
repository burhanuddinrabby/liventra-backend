import status from "http-status";
import AppError from "../../errors/AppError.js";
import type { TUser } from "./auth.interface.js";
import { UserModel } from "./auth.model.js";
import { createToken, generateUserId, verifyToken } from "./auth.utils.js";
import { EMAIL_OTP_LENGTH, EMAIL_OTP_MAX_ATTEMPTS, EMAIL_OTP_TTL_MS, VerificationPurposes } from "./auth.constants.js";
import { EmailVerificationOtpModel } from "./auth.model.js";
import bcrypt from 'bcrypt';
import config from "../../config/index.js";
import type { SignOptions } from "jsonwebtoken";
import { uploadImageToCloudinary } from "../../utils/uploadImage.js";
import { sendMails } from "../../utils/sendMail.js";
import QueryBuilder from "../../builder/QueryBuilder.js";
import crypto from 'crypto';
import { AuditActions, AuditEntityTypes, AuditModules, AuditStatuses } from "../auditLog/auditLog.constants.js";
import type { TAuditAction } from "../auditLog/auditLog.interface.js";
import { diffForAudit } from "../auditLog/auditLog.sanitize.js";
import { allowAuditOnce, recordAuditLog } from "../auditLog/auditLog.utils.js";
import type { TAuditContext, TRecordAuditInput } from "../auditLog/auditLog.utils.js";
import { executeAtomically } from "../feedRecord/feedRecord.utils.js";
import { disconnectUser } from "../../realtime/realtime.js";

type TAccount = { _id: TRecordAuditInput["entityId"]; userId: string };

//account history has no farm; `actor` is set when the request carries no token (register, login, reset)
const accountEvent = (
    context: TAuditContext | undefined,
    account: TAccount | null,
    action: TAuditAction,
    event: string,
    more: Partial<TRecordAuditInput> = {},
    actor?: string,
): TRecordAuditInput => ({
    context: actor ? { ...context, actorUserId: actor } : context,
    entityType: AuditEntityTypes.USER,
    entityId: account?._id ?? null,
    action,
    module: AuditModules.AUTHENTICATION,
    event,
    ...more,
});

//validateRequest discards the parsed body, so unknown keys still arrive here. Only these fields may
//come from a client; role, verification and account-status fields are always set by the server.
const REGISTER_FIELDS = ['fullName', 'phone', 'email', 'password', 'profilePicture', 'gender', 'dateOfBirth', 'address'] as const;
const PROFILE_FIELDS = ['fullName', 'gender', 'dateOfBirth', 'address'] as const;
const ADDRESS_FIELDS = ['village', 'postOffice', 'upazila', 'district', 'country'] as const;

const pickFields = (source: object | undefined, allowed: readonly string[]): Record<string, unknown> =>
    Object.fromEntries(Object.entries(source ?? {}).filter(([key, value]) => allowed.includes(key) && value !== undefined));

// const createUserIntoDB = async (userData: TUser) => {
const createUserIntoDB = async (file: any, payload: TUser, context?: TAuditContext): Promise<TUser> => {
    const userData = {
        ...pickFields(payload, REGISTER_FIELDS),
        address: pickFields(payload.address, ADDRESS_FIELDS),
    } as unknown as TUser;
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
    await recordAuditLog(accountEvent(context, result, AuditActions.CREATE, 'User Registered', {
        newData: { userId: result.userId, fullName: result.fullName, systemRole: result.systemRole },
    }, result.userId));
    return result;
}

//login
const loginUser = async (email: string, password: string, context?: TAuditContext): Promise<{
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
            //the typed email / phone is never stored; one row a minute per address
            if (allowAuditOnce(`login:${context?.ipAddress ?? ''}`)) {
                await recordAuditLog(accountEvent(context, null, AuditActions.LOGIN, 'Login Failed', {
                    status: AuditStatuses.FAILED,
                    newData: { reason: 'Unknown account' },
                }));
            }
            throw new AppError(status.NOT_FOUND, 'User not found!');
        }
        user = byPhone;
    } else {
        user = byEmail;
    }
    const isValid = await bcrypt.compare(password, user.password);
    const refused = (reason: string) => recordAuditLog(accountEvent(context, user, AuditActions.LOGIN, 'Login Failed', {
        status: AuditStatuses.FAILED,
        newData: { reason },
    }, user.userId));
    if (!isValid) {
        await refused('Wrong password');
        throw new AppError(status.FORBIDDEN, 'Wrong password!');
    }
    //after the password check, so it cannot be used to probe accounts
    if (!user.isActive || user.isDeleted) {
        await refused('Account disabled');
        throw new AppError(status.FORBIDDEN, 'Account is inactive or deleted!');
    }
    const jwtPayload = {
        userId: user.userId,
        role: user.systemRole as string,
    }
    //update last login time
    await UserModel.updateOne({ userId: user.userId }, { lastLogin: new Date() });
    await recordAuditLog(accountEvent(context, user, AuditActions.LOGIN, 'Login Successful', {}, user.userId));

    const accessToken = createToken(jwtPayload, config.jwt_access_token as string, config.jwt_access_token_exp as SignOptions["expiresIn"]);

    const refreshToken = createToken(jwtPayload, config.jwt_refresh_token as string, config.jwt_refresh_token_exp as SignOptions["expiresIn"]);;

    return {
        accessToken,
        refreshToken,
        emailVerified: user.emailVerified,
        phoneVerified: user.phoneVerified
    }
}

//the JWT stays valid until it expires; this records the sign-out (the controller clears the cookie)
const logoutUser = async (userId: string, context?: TAuditContext): Promise<void> => {
    const user = await UserModel.findOne({ userId }).select('_id userId').lean();
    await recordAuditLog(accountEvent(context, user, AuditActions.LOGOUT, 'Logout'));
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

//reset password using the token from the forgot-password email link (one-time use)
const resetPassword = async (payload: { token: string; newPassword: string }, context?: TAuditContext): Promise<void> => {
    let decoded;
    try {
        decoded = verifyToken(payload.token, config.jwt_refresh_token as string);
    } catch {
        throw new AppError(status.UNAUTHORIZED, 'Invalid or expired reset token!');
    }
    if (decoded.type !== 'password-reset') {
        throw new AppError(status.UNAUTHORIZED, 'Invalid reset token!');
    }

    const hashedToken = crypto.createHash('sha256').update(payload.token).digest('hex');
    const user = await UserModel.findOne({ passwordResetToken: hashedToken });
    if (!user) {
        throw new AppError(status.NOT_FOUND, 'Password reset token is invalid or already used!');
    }
    if (!user.passwordResetTokenExpiry || user.passwordResetTokenExpiry.getTime() < Date.now()) {
        throw new AppError(status.UNAUTHORIZED, 'Password reset token has expired, please request a new link!');
    }
    if (!user.isActive || user.isDeleted) {
        throw new AppError(status.FORBIDDEN, 'Account is inactive or deleted!');
    }
    const isSamePassword = await bcrypt.compare(payload.newPassword, user.password);
    if (isSamePassword) {
        throw new AppError(status.BAD_REQUEST, 'New password must be different from the current password!');
    }

    //pre-save hook hashes the password
    user.password = payload.newPassword;
    await user.save();
    //token is single-use
    await UserModel.updateOne(
        { userId: user.userId },
        { $unset: { passwordResetToken: 1, passwordResetTokenExpiry: 1 } }
    );
    await recordAuditLog(accountEvent(context, user, AuditActions.UPDATE, 'Password Reset', {}, user.userId));
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
const updateProfile = async (userId: string, payload: Partial<TUser>, context?: TAuditContext): Promise<TUser> => {
    const user = await UserModel.findOne({ userId });
    if (!user) {
        throw new AppError(status.NOT_FOUND, 'User not found!');
    }
    const { address, ...remaining } = pickFields(payload, PROFILE_FIELDS);

    const modifiedData: Record<string, unknown> = { ...remaining };
    for (const [key, value] of Object.entries(pickFields(address as object | undefined, ADDRESS_FIELDS))) {
        modifiedData[`address.${key}`] = value;
    }
    if (!Object.keys(modifiedData).length) {
        throw new AppError(status.BAD_REQUEST, 'No data provided to update!');
    }
    //if req user is not the actual user taken from token
    // if (user.userId !== payload.userId) {
    //     throw new AppError(status.FORBIDDEN, 'You are not authorized to update this profile!');
    // }
    const updated = await UserModel.findOneAndUpdate({ userId }, { $set: modifiedData }, {
        returnDocument: 'after',
        // runValidators: true
    }).select('-password');
    if (!updated) {
        throw new AppError(status.NOT_FOUND, 'User not found, update failed!');
    }
    const sent = (source: object) => Object.fromEntries(Object.entries(source).filter(([key]) => key === 'address' ? !!address : key in remaining));
    const changes = diffForAudit(sent(user.toObject()), sent(updated.toObject()));
    if (changes.changedFields.length) {
        await recordAuditLog(accountEvent(context, updated, AuditActions.UPDATE, 'Profile Updated', changes));
    }
    return updated;
}

//update or change profile picture
const updateProfilePicture = async (userId: string, file: any, url: string | undefined, context?: TAuditContext): Promise<TUser> => {
    const audited = (previous: TAccount & { profilePicture?: string | undefined }, next: string) =>
        recordAuditLog(accountEvent(context, previous, AuditActions.UPDATE, 'Profile Picture Updated', {
            oldData: { profilePicture: previous.profilePicture ?? null },
            newData: { profilePicture: next },
            changedFields: ['profilePicture'],
        }));
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
            { returnDocument: 'after' }
        ).select('-password');
        if (!updated) {
            throw new AppError(status.NOT_FOUND, 'User not found, update failed!');
        }
        await audited(user, updated.profilePicture ?? '');
        return updated;
    }
    if (url) {
        const updated = await UserModel.findOneAndUpdate(
            { userId },
            { profilePicture: url },
            { returnDocument: 'after' }
        ).select('-password');
        if (!updated) {
            throw new AppError(status.NOT_FOUND, 'User not found, update failed!');
        }
        await audited(user, updated.profilePicture ?? '');
        return updated;
    }
    throw new AppError(status.BAD_REQUEST, 'No file or URL provided for profile picture update!');
}

//change password (after validating current password)
const changePassword = async (userId: string, payload: { currentPassword: string; newPassword: string }, context?: TAuditContext): Promise<void> => {
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
    await recordAuditLog(accountEvent(context, user, AuditActions.UPDATE, 'Password Changed'));
}

//an account change and its audit row commit or fail together
const changeAccount = (user: TAccount, changes: Record<string, unknown>, entry: TRecordAuditInput) =>
    executeAtomically(async (session, undo) => {
        const previous = await UserModel.findOne({ userId: user.userId }).select(Object.keys(changes).join(' ')).session(session).lean();
        const updated = await UserModel.findOneAndUpdate(
            { userId: user.userId },
            changes,
            { returnDocument: 'after', ...(session ? { session } : {}) }
        ).select('-password');
        if (!updated || !previous) {
            throw new AppError(status.NOT_FOUND, 'User not found!');
        }
        const { _id, ...fields } = previous as unknown as Record<string, unknown>;
        undo.push(() => UserModel.updateOne({ _id }, { $set: fields }));
        return updated;
    }, {
        trace: entry,
        log: () => recordAuditLog(entry),
    });

//update system-level role (user, admin, superAdmin)
const updateSystemRole = async (userId: string, systemRole: string, context?: TAuditContext): Promise<TUser> => {
    const user = await UserModel.findOne({ userId }).select('_id userId systemRole').lean();
    if (!user) {
        throw new AppError(status.NOT_FOUND, 'User not found!');
    }
    const updated = await changeAccount(user, { systemRole }, accountEvent(context, user, AuditActions.UPDATE, 'System Role Changed', {
        oldData: { systemRole: user.systemRole },
        newData: { systemRole },
        changedFields: ['systemRole'],
    }));
    //live rooms were granted with the old role; the client reconnects and is checked again
    disconnectUser(updated._id);
    return updated;
}

//activate / deactivate an account
const toggleActive = async (userId: string, context?: TAuditContext): Promise<TUser> => {
    const user = await UserModel.findOne({ userId }).select('_id userId isActive').lean();
    if (!user) {
        throw new AppError(status.NOT_FOUND, 'User not found!');
    }
    const isActive = !user.isActive;
    const updated = await changeAccount(user, { isActive }, accountEvent(context, user, AuditActions.UPDATE, isActive ? 'User Enabled' : 'User Disabled', {
        oldData: { isActive: user.isActive },
        newData: { isActive },
        changedFields: ['isActive'],
    }));
    if (!updated.isActive) disconnectUser(updated._id);
    return updated;
}

//soft delete a user account
const deleteUser = async (userId: string, context?: TAuditContext): Promise<TUser> => {
    const user = await UserModel.findOne({ userId }).select('_id userId isActive isDeleted').lean();
    if (!user) {
        throw new AppError(status.NOT_FOUND, 'User not found!');
    }
    const updated = await changeAccount(user, { isActive: false, isDeleted: true }, accountEvent(context, user, AuditActions.DELETE, 'User Deleted', {
        oldData: { isActive: user.isActive, isDeleted: user.isDeleted },
        newData: null,
    }));
    disconnectUser(updated._id);
    return updated;
}

//6-digit numeric code, always zero-padded
const generateEmailOtp = (): string =>
    crypto.randomInt(0, 10 ** EMAIL_OTP_LENGTH).toString().padStart(EMAIL_OTP_LENGTH, '0');

//the code is never persisted in plain form: sha256 bound to purpose + email, compared with timingSafeEqual
const hashEmailOtp = (email: string, otp: string): string =>
    crypto.createHash('sha256')
        .update(`${VerificationPurposes.EMAIL}:${email.toLowerCase()}:${otp}`)
        .digest('hex');

const constantTimeEquals = (a: string, b: string): boolean => {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

const getVerifiableUser = async (email: string): Promise<TUser> => {
    const user = await UserModel.findOne({ email });
    if (!user) {
        throw new AppError(status.NOT_FOUND, 'User not found!');
    }
    if (!user.isActive || user.isDeleted) {
        throw new AppError(status.FORBIDDEN, 'Account is inactive or deleted!');
    }
    if (user.emailVerified) {
        throw new AppError(status.BAD_REQUEST, 'Email is already verified!');
    }
    return user;
};

const sendEmailVerificationOtp = async (user: TUser): Promise<void> => {
    //one pending code per email — a resend always invalidates the previous one
    await EmailVerificationOtpModel.deleteMany({
        email: user.email,
        purpose: VerificationPurposes.EMAIL
    });

    const otp = generateEmailOtp();
    await EmailVerificationOtpModel.create({
        email: user.email,
        code: hashEmailOtp(user.email, otp),
        purpose: VerificationPurposes.EMAIL,
        attempts: 0,
        isVerified: false,
        expiresAt: new Date(Date.now() + EMAIL_OTP_TTL_MS)
    });

    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
            <h2 style="color: #111827;">Verify your email</h2>
            <p style="color: #374151;">Hello ${user.fullName},</p>
            <p style="color: #374151;">
                Use the code below to verify <strong>${user.email}</strong>. It is valid for <strong>2 minutes</strong>.
            </p>
            <p style="margin: 28px 0; font-size: 32px; letter-spacing: 10px; font-weight: bold; color: #16a34a; text-align: center;">
                ${otp}
            </p>
            <p style="color: #6b7280; font-size: 13px;">
                If you didn't request this, you can safely ignore this email.
            </p>
        </div>
    `;
    await sendMails.sendVerificationOtpMail(user.email, html);
}

//send a fresh 6-digit code (2 min TTL) when no otp is given, verify it otherwise
const verifyEmail = async (payload: { email: string; otp?: string }): Promise<{ message: string; data: { emailVerified: boolean } }> => {
    //find the user which needs to be verified, throw if not found or already verified
    const user = await getVerifiableUser(payload.email);

    if (!payload.otp) {
        //if no otp is provided, send a fresh one and return a message indicating that
        await sendEmailVerificationOtp(user);
        return {
            message: `Verification code sent to ${user.email}!`,
            data: { emailVerified: false }
        };
    }

    //if otp is provided, verify it against the stored hash and mark the account verified if successful
    const otpRecord = await EmailVerificationOtpModel.findOne({
        email: user.email,
        purpose: VerificationPurposes.EMAIL,
        isVerified: false,
        expiresAt: { $gt: new Date() }
    });
    if (!otpRecord) {
        throw new AppError(status.NOT_FOUND, 'Verification code is invalid or expired, please request a new one!');
    }

    if (!constantTimeEquals(otpRecord.code, hashEmailOtp(user.email, payload.otp))) {
        //if the code is wrong, increment the attempts and expire the record if max attempts (5) reached
        const attempts = otpRecord.attempts + 1;
        const exhausted = attempts >= EMAIL_OTP_MAX_ATTEMPTS;
        //a burnt code is expired on the spot so it can't be brute-forced any further
        await EmailVerificationOtpModel.updateOne(
            { email: user.email, purpose: VerificationPurposes.EMAIL, isVerified: false },
            { attempts, ...(exhausted ? { expiresAt: new Date() } : {}) }
        );
        if (exhausted) {
            throw new AppError(status.TOO_MANY_REQUESTS, 'Too many invalid attempts, please request a new code!');
        }
        throw new AppError(status.UNAUTHORIZED, `Invalid verification code! ${EMAIL_OTP_MAX_ATTEMPTS - attempts} attempt(s) remaining.`);
    }

    //success: consume the otp (single-use, expired immediately) and flag the account verified
    await EmailVerificationOtpModel.updateOne(
        { email: user.email, purpose: VerificationPurposes.EMAIL, isVerified: false },
        { isVerified: true, expiresAt: new Date(), attempts: otpRecord.attempts + 1 }
    );
    //findOneAndUpdate — .save() would re-hash the password via the pre('save') hook
    await UserModel.updateOne({ email: user.email }, { emailVerified: true });

    return {
        message: 'Email verified successfully!!',
        data: { emailVerified: true }
    };
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
    logoutUser,
    forgotPassword,
    resetPassword,
    getProfile,
    updateProfile,
    updateProfilePicture,
    changePassword,
    updateSystemRole,
    toggleActive,
    deleteUser,
    getAllUsers,
    getUserById,
    verifyEmail
}