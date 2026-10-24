import z from "zod";
import { SystemRoles } from "./auth.constants.js";

const createUserValidation = z.object({
    body: z.object({
        fullName: z.string().min(1, { message: "Last name is required" }),
        phone: z.string().min(1, { message: "Phone number is required" }),
        email: z.string().min(1, { message: "Invalid email address" }),
        password: z.string().min(8, { message: "Password must be at least 8 characters long" }),
        profilePicture: z.string().optional(),
        gender: z.enum(['male', 'female', 'other']).optional(),
        dateOfBirth: z.string().optional(),
        address: z.object({
            village: z.string().optional(),
            postOffice: z.string().optional(),
            upazila: z.string().min(1, { message: "Upazila is required" }),
            district: z.string().min(1, { message: "District is required" }),
            country: z.string().min(1, { message: "Country is required" }),
        }),
        emailVerified: z.boolean().optional(),
        phoneVerified: z.boolean().optional(),
        isActive: z.boolean().optional(),
        systemRole: z.enum(Object.values(SystemRoles)).optional(),
        lastLogin: z.string().optional(),
        isDeleted: z.boolean().optional()
    })
});

const loginUserValidation = z.object({
    body: z.object({
        email: z.string().min(1, { message: "Login method is required" }),
        password: z.string().min(1, { message: "Password is required" })
    })
});

const forgotPasswordValidation = z.object({
    body: z.object({
        email: z.email({ message: "Invalid email address" }),
    })
});

const resetPasswordValidation = z.object({
    body: z.object({
        token: z.string().min(1, { message: "Reset token is required" }),
        newPassword: z.string().min(8, { message: "New password must be at least 8 characters long" }),
    })
});

const updateProfileValidation = z.object({
    body: z.object({
        fullName: z.string().min(1, { message: "Full name is required" }).optional(),
        gender: z.enum(['male', 'female', 'other']).optional(),
        dateOfBirth: z.string().optional(),
        address: z.object({
            village: z.string().optional(),
            postOffice: z.string().optional(),
            upazila: z.string().optional(),
            district: z.string().optional(),
            country: z.string().optional(),
        }).optional(),
    }).refine((values) => Object.keys(values).length > 0, { message: "No data provided to update!" })
});

const changePasswordValidation = z.object({
    body: z.object({
        currentPassword: z.string().min(1, { message: "Current password is required" }),
        newPassword: z.string().min(8, { message: "New password must be at least 8 characters long" }),
    }).refine((values) => values.currentPassword !== values.newPassword, {
        message: "New password must be different from the current password!"
    })
});

const updateSystemRoleValidation = z.object({
    body: z.object({
        systemRole: z.enum(Object.values(SystemRoles), { message: "System role must be one of: user, admin, superAdmin" }),
    })
});

//with otp -> verify the emailed code; without otp -> (re)send a fresh one
const verifyEmailValidation = z.object({
    body: z.object({
        email: z.email({ message: "Invalid email address" }),
        otp: z.string().regex(/^\d{6}$/, { message: "OTP must be a 6-digit code" }).optional(),
    })
});

export const userValidations = {
    createUserValidation,
    loginUserValidation,
    forgotPasswordValidation,
    resetPasswordValidation,
    updateProfileValidation,
    changePasswordValidation,
    updateSystemRoleValidation,
    verifyEmailValidation
};
