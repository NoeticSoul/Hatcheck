// Shared server context: the Hono environment type, router factory with the
// standard validation error hook, and small helpers used across routes.
import { OpenAPIHono } from "@hono/zod-openapi";
import { isIP } from "node:net";
import type { Context } from "hono";
import type { AppConfig } from "../config";
import { matchesProxyAddress } from "../network/proxy-address";
import type {
  AuthSource,
  Role,
  SessionRecord,
  Store,
  UserRecord,
} from "../db/store";

export interface AppVariables {
  store: Store;
  config: AppConfig;
  // Set by requireAuth; only read by handlers that run behind it.
  user: UserRecord;
  session: SessionRecord;
}

export type AppEnv = {
  Variables: AppVariables;
  // Populated by the runtime entrypoint (index.ts passes the socket address
  // through app.fetch's env argument); absent in tests via app.request.
  Bindings: { remoteAddr?: string };
};

export interface ErrorBody {
  error: { code: string; message: string };
}

export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

/** Sanitized user shape: passwordHash and oidcSubject never leave the API. */
export interface SafeUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  authSource: AuthSource;
  isActive: boolean;
  createdAt: number;
}

export function sanitizeUser(user: UserRecord): SafeUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    authSource: user.authSource,
    isActive: user.isActive,
    createdAt: user.createdAt,
  };
}

/**
 * Client IP for rate limiting and audit records. X-Forwarded-For is
 * client-controlled. Honor its final hop only when the connecting socket
 * belongs to an explicitly configured proxy that appends the client IP.
 * Missing socket evidence never establishes a trusted proxy (including tests).
 */
export function clientIp(c: Context<AppEnv>): string {
  const peer = c.env?.remoteAddr;
  const config = c.get("config");
  const normalize = (ip: string) => ip.toLowerCase().replace(/^::ffff:(?=\d+\.)/, "");
  if (config.trustProxy && peer !== undefined &&
      config.trustedProxies.some((entry) => matchesProxyAddress(peer, entry))) {
    const forwarded = c.req.header("x-forwarded-for");
    const hops = forwarded
      ?.split(",")
      .map((h) => h.trim())
      .filter((h) => h !== "");
    const last = hops?.[hops.length - 1];
    if (last !== undefined && isIP(last) !== 0) return normalize(last);
  }
  return peer ?? "local";
}

/** New router with the standard zod validation hook (400, error shape). */
export function createRouter(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const message = result.error.issues
          .map((i) => `${i.path.map(String).join(".")}: ${i.message}`)
          .join("; ");
        return c.json(
          errorBody("validation_error", message || "Invalid request"),
          400,
        );
      }
      return undefined;
    },
  });
}
