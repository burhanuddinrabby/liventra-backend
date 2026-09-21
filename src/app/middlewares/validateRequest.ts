import { ZodObject } from 'zod';
import catchAsync from '../utils/catchAsync.js';

const validateRequest = (schema: ZodObject) => {
    return catchAsync(async (req, res, next) => {
        await schema.parseAsync({
            body: req.body,
            cookies: req.cookies
        });
        next();
    }
    )
}

export default validateRequest;