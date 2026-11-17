import type { NextFunction, Request, Response } from "express";
import status from "http-status";
import AppError from "../errors/AppError.js";

/**
 * multipart/form-data cannot carry a JSON object, so clients send the payload as a
 * JSON string in `data` (same convention as farm creation). Plain JSON requests are
 * left untouched because they have no `data` field to parse.
 */
const parseMultipartData = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const data = req.body?.data;

  if (typeof data !== "string" || !data.trim()) {
    next();
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    next(new AppError(status.BAD_REQUEST, "`data` must be valid JSON!"));
    return;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    next(new AppError(status.BAD_REQUEST, "`data` must be a JSON object!"));
    return;
  }

  req.body = parsed;
  next();
};

export default parseMultipartData;
