import crypto from "crypto";
import type { RequestHandler } from "express";

/**
 * Gives every request its own id (REQ-YYYYMMDD-xxxxxxxx, UTC day) and returns it as
 * X-Request-Id, so an error report can be matched with the server log.
 * A client-sent id is ignored: it could be forged.
 */
const requestContext: RequestHandler = (req, res, next) => {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  req.requestId = `REQ-${day}-${crypto.randomBytes(4).toString("hex")}`;
  res.setHeader("X-Request-Id", req.requestId);
  next();
};

export default requestContext;
