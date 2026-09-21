import mongoose from "mongoose";
import status from "http-status";
import type { TErrorSources, TGenericErrorResponse } from "../interfaces/error.type.js";

const handleCastError = (err: mongoose.Error.CastError): TGenericErrorResponse => {
    const statusCode = status.BAD_REQUEST;
    const errorSources: TErrorSources = [{
        errorPath: err?.path,
        errorMessage: err?.message
    }]

    return {
        statusCode,
        message: 'Invalid Id',
        errorSources
    }
}

export default handleCastError;