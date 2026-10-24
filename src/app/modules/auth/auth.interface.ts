/* eslint-disable no-unused-vars */
import { Model } from "mongoose";
import type { SystemRoles, VerificationPurposes } from "./auth.constants.js";
import type { TGender } from "../../globals/global.constants.js";

export type TSystemRole = keyof typeof SystemRoles;

export type TUser = {
    userId: string;
    fullName: string;
    phone: string;
    email: string;
    password: string;
    passwordResetToken?: string;
    passwordResetTokenExpiry?: Date;
    profilePicture?: string;
    gender?: TGender;
    dateOfBirth?: Date;
    address: {
        village?: string;
        postOffice?: string;
        upazila: string;
        district: string;
        country: string;
    };
    emailVerified: boolean;
    phoneVerified: boolean;
    isActive: boolean;
    systemRole?: string;
    lastLogin?: Date;
    isDeleted: boolean
}


export type TVerificationPurpose = (typeof VerificationPurposes)[keyof typeof VerificationPurposes];

export type TEmailVerificationOtp = {
    email: string;
    code: string;
    purpose: TVerificationPurpose;
    attempts: number;
    isVerified: boolean;
    expiresAt: Date;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface AuthUserModel extends Model<TUser> {
    isUserExistById(id: string): Promise<TUser>;
    isPasswordMatched(plain: string, hash: string): Promise<boolean>;
    isJWTIssuedBeforePasswordChanged(passwordChangedTime: Date, jwtIssuedTime: number): Promise<boolean>
}