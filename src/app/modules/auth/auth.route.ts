import express, { type NextFunction, type Request, type Response } from 'express';
import { UserController } from './auth.controller.js';
import { upload } from '../../utils/uploadImage.js';
import validateRequest from '../../middlewares/validateRequest.js';
import { userValidations } from './auth.validation.js';
import auth from '../../middlewares/auth.js';
import { SystemRoles } from './auth.constants.js';
const userRouter = express.Router();

//POST /api/v1/users/register-user
userRouter.post('/register-user', upload.single('file'), (req: Request, res: Response, next: NextFunction) => {
    //form data
    //file -> image
    //data -> remaining body
    req.body = JSON.parse(req.body.data);
    // console.log(req.body)
    next();
}, validateRequest(userValidations.createUserValidation), UserController.createUser);

//POST /api/v1/users/login
userRouter.post('/login', validateRequest(userValidations.loginUserValidation), UserController.loginUser);

// GET /api/v1/users/profile
userRouter.get('/profile', auth(SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER), UserController.getProfile);

// PUT /api/v1/users/profile
userRouter.put('/profile', auth(SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER), validateRequest(userValidations.updateProfileValidation), UserController.updateProfile);

// PATCH /api/v1/users/profile-picture
userRouter.patch('/profile-picture', auth(SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER), upload.single('file'), UserController.updateProfilePicture);

// PUT /api/v1/users/change-password
userRouter.put('/change-password', auth(SystemRoles.SUPER_ADMIN, SystemRoles.ADMIN, SystemRoles.USER), validateRequest(userValidations.changePasswordValidation), UserController.changePassword);

// GET /api/v1/users (paginated list) - admin & superAdmin only
userRouter.get('/', auth(SystemRoles.ADMIN, SystemRoles.SUPER_ADMIN), UserController.getAllUsers);

// GET /api/v1/users/:id (full user details) - admin & superAdmin only
userRouter.get('/:id', auth(SystemRoles.ADMIN, SystemRoles.SUPER_ADMIN), UserController.getUserById);

/* 

- POST /api/v1/users/forgot-password
- POST /api/v1/users/verify-email 
- POST /api/v1/users/verify-phone
- GET /api/v1/users 
- GET /api/v1/users/:id
- PATCH /api/v1/users/:id/system-role
- PATCH /api/v1/users/:id/toggle-active
- DELETE /api/v1/users/:id
*/
export { userRouter };