import type { Response, } from "express";

export type TMeta = {
    page: number;
    limit: number;
    totalEntries: number;
    totalPage: number;
}

type TResponse<T> = {
    statusCode: number;
    success: boolean;
    meta?: TMeta;
    message?: string;
    data?: T
}
const sendResponse = <T>(res: Response, data: TResponse<T>) => {
    res.status(data.statusCode).json({
        success: data.success,
        message: data?.message,
        meta: data?.meta,
        data: data.data
    });
}

export default sendResponse;