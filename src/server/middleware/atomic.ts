import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../context";

class ResponseRollback extends Error {}

/**
 * A request's mutation and audit share a transaction. Hono handles route
 * exceptions inside next(), so an error response must also roll back.
 * Imports deliberately commit one row at a time in their domain service.
 */
export const atomicMutation: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = c.req.path;
  const unsafe = ["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method);
  // OIDC performs network verification before its explicit database transaction.
  if (!unsafe ||
      (c.req.method === "POST" && path === "/api/v1/imports/assets")) {
    await next();
    return;
  }
  const store = c.get("store");
  try {
    await store.transaction(async (tx) => {
      c.set("store", tx);
      await next();
      const failedLogin = path === "/api/v1/auth/login" && c.res.status === 401;
      if (c.res.status >= 400 && !failedLogin) throw new ResponseRollback();
    });
  } catch (error) {
    // Handlers may have issued/expired session cookies before COMMIT. Hono
    // carries response headers into its error response, so discard cookie
    // effects whenever the database unit fails or rolls back.
    c.header("Set-Cookie", undefined);
    if (!(error instanceof ResponseRollback)) throw error;
  } finally {
    c.set("store", store);
  }
};
