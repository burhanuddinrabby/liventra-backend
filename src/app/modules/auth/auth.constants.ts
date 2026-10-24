export const SystemRoles = {
    SUPER_ADMIN: 'superAdmin',
    USER: 'user',
    ADMIN: 'admin'
} as const;

export const VerificationPurposes = {
    EMAIL: 'email-verification'
} as const;

export const EMAIL_OTP_LENGTH = 6;
export const EMAIL_OTP_TTL_MS = 2 * 60 * 1000;
export const EMAIL_OTP_MAX_ATTEMPTS = 5;