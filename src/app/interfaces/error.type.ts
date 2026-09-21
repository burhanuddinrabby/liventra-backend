export type TErrorSources = {
    errorPath: string | number;
    errorMessage: string;
}[]

export type TGenericErrorResponse = {
    statusCode: number;
    message: string;
    errorSources: TErrorSources;
}