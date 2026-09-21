import type { Request, Response, NextFunction } from "express";
import { status } from "http-status";
const notFound = (req: Request, res: Response, next: NextFunction) => {

    res.status(status.NOT_FOUND).json({
        success: false,
        message: 'API Not found',
        error: ''
    });
}
export default notFound;