import status from "http-status";
import type { TErrorSources, TGenericErrorResponse } from "../interfaces/error.type.js";

const handleDuplicateError = (err: any): TGenericErrorResponse => {
    const statusCode = status.BAD_REQUEST;
    const matchPath = err?.message.match(/collection:\s*([^\s]+)/);//[projectName].pathName evabe thake
    const match = err?.message.match(/dup key:\s*{\s*name:\s*"([^"]+)"/);
    const collectionName = matchPath ? (matchPath[1].split('.'))[1] as string : null;

    const errorSources: TErrorSources = [{
        errorPath: collectionName as string,
        errorMessage: (match && match[1]) as string + ' already exists',
    }]
    const message: string = `Duplicate ${Object.keys(err.keyValue)[0]} of ${collectionName}`
    return {
        statusCode,
        message, //Object.keys(err.keyValue)[0] determine which field is duplicated
        errorSources
    }
}

export default handleDuplicateError;