import { hash, verify } from "@node-rs/argon2";
import { createRoute } from "@hono/zod-openapi";
import type { AppConfig } from "../../config";
import { clientIp, createRouter, errorBody, sanitizeUser } from "../context";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { createOidcHandlers } from "../oidc";
import {
  cookieSecurity,
  ErrorSchema,
  jsonContent,
  LoginBodySchema,
  UserResponseSchema,
} from "../openapi";
import { clearSession, issueSession } from "../session";

const loginRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/login",
  tags: ["auth"],
  summary: "Log in with email and password",
  request: {
    body: {
      content: { "application/json": { schema: LoginBodySchema } },
      required: true,
    },
  },
  responses: {
    200: jsonContent(UserResponseSchema, "Logged in; session cookie set"),
    400: jsonContent(ErrorSchema, "Validation error"),
    401: jsonContent(ErrorSchema, "Invalid credentials"),
    429: jsonContent(ErrorSchema, "Too many attempts"),
  },
});

const logoutRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/logout",
  tags: ["auth"],
  summary: "Log out and clear the session",
  security: cookieSecurity,
  middleware: [requireAuth],
  responses: {
    204: { description: "Logged out" },
    401: jsonContent(ErrorSchema, "Not authenticated"),
  },
});

const meRoute = createRoute({
  method: "get",
  path: "/api/v1/auth/me",
  tags: ["auth"],
  summary: "Current authenticated user",
  security: cookieSecurity,
  middleware: [requireAuth],
  responses: {
    200: jsonContent(UserResponseSchema, "Current user"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
  },
});

const oidcLoginRoute = createRoute({
  method: "get",
  path: "/api/v1/auth/oidc/login",
  tags: ["auth"],
  summary: "Start OIDC login",
  responses: {
    302: { description: "Redirect to the identity provider" },
    501: jsonContent(ErrorSchema, "OIDC is not configured"),
  },
});

const oidcCallbackRoute = createRoute({
  method: "get",
  path: "/api/v1/auth/oidc/callback",
  tags: ["auth"],
  summary: "Complete OIDC login",
  responses: {
    302: { description: "Redirect to the app (or /login?error=oidc on failure)" },
    403: jsonContent(ErrorSchema, "Account is inactive"),
    501: jsonContent(ErrorSchema, "OIDC is not configured"),
  },
});

const INVALID_CREDENTIALS = "Invalid email or password";

// Verified against when the account is unknown or unusable, so those paths
// cost the same argon2 work as a wrong password and login timing does not
// reveal whether an email exists. The plaintext is irrelevant; it only has
// to be a well-formed hash that never matches.
const timingEqualizerHash = hash("hatcheck-timing-equalizer");

export function authRoutes(config: AppConfig) {
  const router = createRouter();
  const oidcHandlers = createOidcHandlers(config);

  // Contract: max 10 login attempts per 60s per client IP.
  router.use(
    loginRoute.getRoutingPath(),
    rateLimit({ windowMs: 60_000, max: 10 }),
  );

  router.openapi(loginRoute, async (c) => {
    const { email, password } = c.req.valid("json");
    const store = c.get("store");
    const ip = clientIp(c);

    const user = await store.getUserByEmail(email);
    let verified = false;
    if (
      user !== null &&
      user.isActive &&
      user.authSource === "local" &&
      user.passwordHash !== null
    ) {
      verified = await verify(user.passwordHash, password);
    } else {
      await verify(await timingEqualizerHash, password);
    }

    // Same 401 for unknown email, wrong password, and unusable accounts.
    if (user === null || !verified) {
      await store.appendAudit({
        action: "auth.login_failed",
        actorEmail: email,
        ip,
      });
      return c.json(errorBody("invalid_credentials", INVALID_CREDENTIALS), 401);
    }

    await store.appendAudit({
      action: "auth.login",
      actorUserId: user.id,
      actorEmail: user.email,
      ip,
    });
    await issueSession(store, config, c, user);
    return c.json({ user: sanitizeUser(user) }, 200);
  });

  router.openapi(logoutRoute, async (c) => {
    const store = c.get("store");
    const user = c.get("user");
    const session = c.get("session");
    await clearSession(store, c, session.tokenHash);
    await store.appendAudit({
      action: "auth.logout",
      actorUserId: user.id,
      actorEmail: user.email,
      ip: clientIp(c),
    });
    return c.body(null, 204);
  });

  router.openapi(meRoute, (c) => {
    return c.json({ user: sanitizeUser(c.get("user")) }, 200);
  });

  router.openapi(oidcLoginRoute, (c) => oidcHandlers.login(c));
  router.openapi(oidcCallbackRoute, (c) => oidcHandlers.callback(c));

  return router;
}
