// RBAC lives here, at the API layer (CLAUDE.md hard rule 5). The UI may
// hide controls, but these middlewares are the actual enforcement.
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { Role, UserRecord } from "../../db/store";
import { errorBody, type AppEnv } from "../context";
import { hashSessionToken, SESSION_COOKIE } from "../session";

/**
 * Resolves the session cookie to an active user, or 401s. On success the
 * user and session records are set on the context for downstream handlers.
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token === undefined || token === "") {
    return c.json(errorBody("unauthorized", "Authentication required"), 401);
  }
  const store = c.get("store");
  const found = await store.getSessionUser(hashSessionToken(token), Date.now());
  if (found === null || !found.user.isActive) {
    return c.json(errorBody("unauthorized", "Authentication required"), 401);
  }
  c.set("user", found.user);
  c.set("session", found.session);
  await next();
};

/** Must run after requireAuth. 403s unless the user has one of the roles. */
export function requireRole(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // The context type declares user as always present, but it is unset at
    // runtime if requireAuth did not run first; widen to check defensively.
    const user = c.get("user") as UserRecord | undefined;
    if (user === undefined || !roles.includes(user.role)) {
      return c.json(errorBody("forbidden", "Insufficient role"), 403);
    }
    await next();
  };
}
