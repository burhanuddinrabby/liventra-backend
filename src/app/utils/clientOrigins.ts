import config from "../config/index.js";

/**
 * Browser origins allowed to call the API and open sockets (CLIENT_ORIGINS, comma separated).
 * Missing variable: everything outside production, nothing in production.
 */
export const allowedOrigins: string | string[] | false =
  config.client_origins.length > 0
    ? config.client_origins
    : config.node_env === "production"
      ? false
      : "*";
