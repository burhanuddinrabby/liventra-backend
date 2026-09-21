import type { ErrorRequestHandler } from "express";
import type { TErrorSources, TGenericErrorResponse } from "../interfaces/error.type.js";
import { ZodError } from "zod";
import status from "http-status";
import handleZodError from "../errors/handleZodError.js";
import handleValidationError from "../errors/handleValidationError.js";
import handleCastError from "../errors/handleCastError.js";
import handleDuplicateError from "../errors/handleDuplicateError.js";
import config from "../config/index.js";
import AppError from "../errors/AppError.js";

/* 
success: false,
message,
errorSources,
stack 
*/
const globalErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
    let statusCode: number = err.statusCode || status.INTERNAL_SERVER_ERROR;
    let message = err?.message || 'Something went wrong!'
    let errorSources: TErrorSources = [{
        errorPath: '',
        errorMessage: 'Something went wrong!'
    }]

    let simplifiedError: TGenericErrorResponse = {
        statusCode,
        message,
        errorSources
    };

    if (err instanceof ZodError) {
        simplifiedError = handleZodError(err);
        // const simplifiedError = handleZodError(err);
        // statusCode = simplifiedError?.statusCode;
        // message = simplifiedError?.message;
        // errorSources = simplifiedError?.errorSources;
    } else if (err?.name === "ValidationError") {
        simplifiedError = handleValidationError(err);
    } else if (err?.name === "CastError") {
        simplifiedError = handleCastError(err);
    } else if (err?.code == 11000) {
        simplifiedError = handleDuplicateError(err);
    } else if (err?.name == 'TokenExpiredError') {
        simplifiedError = {
            statusCode: status.FORBIDDEN,
            message: 'Your token is expired!',
            errorSources: [{
                errorPath: config.node_env === 'development' ? req?.url : '',
                errorMessage: err?.message
            }]
        }
    }
    else if (err instanceof AppError) {
        simplifiedError = {
            statusCode: err?.statusCode,
            message: err?.message,
            errorSources: [{
                errorPath: '',
                errorMessage: err?.message
            }]
        }
    } else if (err instanceof Error) {
        simplifiedError = {
            statusCode: status.INTERNAL_SERVER_ERROR,
            message: err?.message,
            errorSources: [{
                errorPath: '',
                errorMessage: err?.message
            }]
        }
    }
    // TokenExpiredError
    statusCode = simplifiedError?.statusCode;
    message = simplifiedError?.message;
    errorSources = simplifiedError?.errorSources;

    res.status(statusCode).json({
        success: false,
        message,
        errorSources,
        err: err || '',
        stack: config.node_env === 'development' ? err?.stack : null
    });
}

export default globalErrorHandler;