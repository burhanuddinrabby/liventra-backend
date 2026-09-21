import type { NextFunction, Request, RequestHandler, Response } from 'express';

const catchAsync = (requestFunction: RequestHandler) => {
    return (req: Request, res: Response, next: NextFunction) => {
        Promise.resolve(requestFunction(req, res, next)).catch(err => next(err));
    }
}

export default catchAsync;