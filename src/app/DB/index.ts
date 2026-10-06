import config from "../config/index.js";
import { SystemRoles } from "../modules/auth/auth.constants.js";
import { UserModel } from "../modules/auth/auth.model.js";

const superAdminPassword = config.super_admin_pass;
if (!superAdminPassword) {
    throw new Error('SUPER_ADMIN_PASS is required to seed the super admin');
}

const superUser = {
    userId: 'U-00-0000',
    fullName: 'Super Admin',
    phone: '01700000000',
    email: 'bunnub5683@gmail.com',
    password: superAdminPassword,
    profilePicture: '',
    gender: 'male' as const,
    dateOfBirth: new Date('1990-01-01'),
    address: {
        village: 'Village',
        postOffice: 'Post Office',
        upazila: 'Upazila',
        district: 'District',
        country: 'Country'
    },
    emailVerified: true,
    phoneVerified: true,
    isActive: true,
    systemRole: SystemRoles.SUPER_ADMIN,
    lastLogin: new Date(),
    isDeleted: false
}

const seedSuperAdmin = async () => {
    const isSuperAdminExist = await UserModel.findOne({ systemRole: SystemRoles.SUPER_ADMIN });
    if (!isSuperAdminExist) {
        await UserModel.create(superUser);
    }
};

export default seedSuperAdmin;