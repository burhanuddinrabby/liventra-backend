import express, { type NextFunction, type Request, type Response } from 'express';
import { UserController } from './auth.controller.js';
import { upload } from '../../utils/uploadImage.js';
import validateRequest from '../../middlewares/validateRequest.js';
import { userValidations } from './auth.validation.js';
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

// userRouter.post('/get-me', auth(SystemRoles.ADMIN as TSystemRole), UserController.createUser);

/* 
- POST /api/v1/users/login
- GET /api/v1/users/profile
- PUT /api/v1/users/profile
- PATCH /api/v1/users/profile-picture
- PUT /api/v1/users/change-password
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