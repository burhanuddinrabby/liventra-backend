import { model, Schema } from "mongoose";
import { SystemRoles, VerificationPurposes } from "./auth.constants.js";
import type { TEmailVerificationOtp, TUser } from "./auth.interface.js";
import bcrypt from 'bcrypt';
import config from "../../config/index.js";

const userSchema = new Schema<TUser>(
    {
        userId: { type: String, required: true, unique: true },
        fullName: { type: String, required: true },
        phone: { type: String, required: true, unique: true },
        email: { type: String, required: true, unique: true },
        password: { type: String, required: true },
        passwordResetToken: { type: String },
        passwordResetTokenExpiry: { type: Date },
        profilePicture: { type: String },
        gender: {
            type: String, enum: {
                values: ['male', 'female', 'other'],
                message: "{VALUE} is not a valid gender"
            }, required: false
        },
        dateOfBirth: { type: Date },
        address: {
            village: { type: String },
            postOffice: { type: String },
            upazila: { type: String, required: true },
            district: { type: String, required: true },
            country: { type: String, required: true }
        },
        emailVerified: { type: Boolean, default: false },
        phoneVerified: { type: Boolean, default: false },
        isActive: { type: Boolean, default: true },
        systemRole: { type: String, enum: Object.values(SystemRoles), default: SystemRoles.USER },
        lastLogin: { type: Date },
        isDeleted: { type: Boolean, default: false }
    },
    {
        timestamps: true
    }
);

// Static method to check if a user exists by email
userSchema.statics.isUserExistByEmail = async function (email: string): Promise<TUser> {
    const user = await this.findOne({ email }, { userId: 1, fullName: 1, phone: 1, password: 1, systemRole: 1 }).lean();
    return user;
}
userSchema.statics.isUserExistById = async function (id: string): Promise<TUser> {
    const user = await this.findOne({ userId: id }, { userId: 1, fullName: 1, phone: 1, password: 1, systemRole: 1 }).lean();
    return user;
}

userSchema.statics.isPasswordMatched = async function (plain: string, hash: string) {
    return await bcrypt.compare(plain, hash);
}

userSchema.statics.isJWTIssuedBeforePasswordChanged = async function (passwordChangedTime: Date, jwtIssuedTime: number) {
    const passChangeTimeInMS = new Date(passwordChangedTime).getTime() / 1000;
    return passChangeTimeInMS > jwtIssuedTime;
}

//pre hook to hash password before saving to database
userSchema.pre('save', async function () {
    this.password = await bcrypt.hash(this.password, Number(config.bcrypt_salt_round));
})

//only non-deleted (isDeleted: false) users will be returned while searching (find / findOne)
// userSchema.pre(['find', 'findOne'], function () {
//     this.where({
//         isDeleted: false
//     });
// })
export const UserModel = model<TUser>('User', userSchema);

//OTP records for email verification — only the sha256 hash of the code is stored (see hashEmailOtp in auth.services.ts)
const emailVerificationOtpSchema = new Schema<TEmailVerificationOtp>(
    {
        email: { type: String, required: true, lowercase: true, index: true },
        code: { type: String, required: true },
        purpose: {
            type: String,
            enum: Object.values(VerificationPurposes),
            default: VerificationPurposes.EMAIL,
            required: true
        },
        attempts: { type: Number, default: 0 },
        isVerified: { type: Boolean, default: false },
        expiresAt: { type: Date, required: true }
    },
    {
        timestamps: true
    }
);

//TTL index — MongoDB purges the record itself once expiresAt passes (2 minutes, set by the service).
//NOTE: expireAfterSeconds directly; mongoose's `{ expires: 0 }` sugar is falsy-skipped and would create a plain index
emailVerificationOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailVerificationOtpModel = model<TEmailVerificationOtp>('EmailVerificationOtp', emailVerificationOtpSchema);