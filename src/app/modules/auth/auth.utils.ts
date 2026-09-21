import { UserModel } from "./auth.model.js";
import { SystemRoles } from "./auth.constants.js";
import jwt, { type JwtPayload, type SignOptions } from "jsonwebtoken";

const lastUserId = async () => {
    const lastUser = await UserModel.findOne(
        {
            systemRole: SystemRoles.USER
        } as any,
        {
            userId: 1,
            _id: 0
        }
    ).sort({
        createdAt: -1
    }).lean();
    const lastDigits: string = lastUser?.userId?.split('-')[2] || '00000';
    return lastDigits;
};

export const generateUserId = async (): Promise<string> => {
    const currentId = await lastUserId();
    let incrementId = (Number(currentId) + 1).toString().padStart(4, '0');
    const currentYear = new Date().getFullYear();
    incrementId = `USR-${currentYear}-${incrementId}`
    return incrementId;
}

export const createToken = (jwtPayload: { userId: string, role: string },
    secret: string,
    expiresIn: SignOptions["expiresIn"],
) => {
    const options: SignOptions = expiresIn === undefined ? {} : { expiresIn };
    return jwt.sign(jwtPayload, secret, options)
}

export const verifyToken = (token: string, secret: string) => {
    return jwt.verify(token, secret) as JwtPayload;
}