import type { MiddlewareHandler } from "hono";
import { errorBody, type AppEnv } from "../context";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Cookie sessions require an approved browser Origin for unsafe methods. */
export const protectBrowserWrites: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  const config = c.get("config");
  const allowed = new Set([new URL(config.appUrl).origin]);
  if (config.nodeEnv === "development") {
    allowed.add("http://localhost:5173");
    allowed.add("http://127.0.0.1:5173");
  }
  const origin = c.req.header("origin");
  const fetchSite = c.req.header("sec-fetch-site");
  // Fetch metadata is browser-controlled. A same-site sibling hostname is
  // not an authorized origin, even when the session's SameSite cookie is sent.
  if ((origin !== undefined && !allowed.has(origin)) ||
      fetchSite === "cross-site" ||
      (origin === undefined && fetchSite !== undefined && fetchSite !== "same-origin")) {
    return c.json(errorBody("untrusted_origin", "Browser origin is not permitted"), 403);
  }
  // Command-line clients do not supply Origin/Fetch Metadata and retain API
  // access. Browsers cannot suppress both headers on cross-origin writes.
  return next();
};

export const csvMediaType: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === "POST" &&
      c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "text/csv") {
    return c.json(errorBody("unsupported_media_type", "CSV imports require Content-Type: text/csv"), 415);
  }
  return next();
};

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (c.req.path.startsWith("/api/")) {
    c.header("Cache-Control", "no-store");
    if (c.req.path !== "/api/v1/docs" && !c.res.headers.has("Content-Security-Policy")) {
      c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    }
  } else if (c.get("config").isProduction) {
    c.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  }
  if (new URL(c.get("config").appUrl).protocol === "https:") {
    c.header("Strict-Transport-Security", "max-age=31536000");
  }
};
