import { hash } from "@node-rs/argon2";
import { createRoute } from "@hono/zod-openapi";
import type { UserPatch } from "../../db/store";
import { clientIp, createRouter, errorBody, sanitizeUser } from "../context";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  cookieSecurity,
  CreateUserBodySchema,
  ErrorSchema,
  jsonContent,
  PatchUserBodySchema,
  UserIdParamsSchema,
  UserListResponseSchema,
  UserResponseSchema,
} from "../openapi";

const adminOnly = requireRole("admin");

const listUsersRoute = createRoute({
  method: "get",
  path: "/api/v1/users",
  tags: ["users"],
  summary: "List users (admin)",
  security: cookieSecurity,
  middleware: [requireAuth, adminOnly],
  responses: {
    200: jsonContent(UserListResponseSchema, "All users"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Admin role required"),
  },
});

const createUserRoute = createRoute({
  method: "post",
  path: "/api/v1/users",
  tags: ["users"],
  summary: "Create a local user (admin)",
  security: cookieSecurity,
  middleware: [requireAuth, adminOnly],
  request: {
    body: {
      content: { "application/json": { schema: CreateUserBodySchema } },
      required: true,
    },
  },
  responses: {
    201: jsonContent(UserResponseSchema, "User created"),
    400: jsonContent(ErrorSchema, "Validation error"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Admin role required"),
    409: jsonContent(ErrorSchema, "Email already in use"),
  },
});

const patchUserRoute = createRoute({
  method: "patch",
  path: "/api/v1/users/{id}",
  tags: ["users"],
  summary: "Update a user (admin)",
  security: cookieSecurity,
  middleware: [requireAuth, adminOnly],
  request: {
    params: UserIdParamsSchema,
    body: {
      content: { "application/json": { schema: PatchUserBodySchema } },
      required: true,
    },
  },
  responses: {
    200: jsonContent(UserResponseSchema, "User updated"),
    400: jsonContent(ErrorSchema, "Validation error"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Admin role required"),
    404: jsonContent(ErrorSchema, "User not found"),
  },
});

export function userRoutes() {
  const router = createRouter();

  router.openapi(listUsersRoute, async (c) => {
    const users = await c.get("store").listUsers();
    return c.json({ users: users.map(sanitizeUser) }, 200);
  });

  router.openapi(createUserRoute, async (c) => {
    const body = c.req.valid("json");
    const store = c.get("store");
    const actor = c.get("user");

    const existing = await store.getUserByEmail(body.email);
    if (existing !== null) {
      return c.json(errorBody("email_in_use", "Email is already in use"), 409);
    }

    const created = await store.createUser({
      email: body.email,
      displayName: body.displayName,
      role: body.role,
      authSource: "local",
      passwordHash: await hash(body.password),
    });
    await store.appendAudit({
      action: "user.create",
      actorUserId: actor.id,
      actorEmail: actor.email,
      entityType: "user",
      entityId: created.id,
      details: { email: created.email, role: created.role },
      ip: clientIp(c),
    });
    return c.json({ user: sanitizeUser(created) }, 201);
  });

  router.openapi(patchUserRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const store = c.get("store");
    const actor = c.get("user");

    const patch: UserPatch = {};
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.role !== undefined) patch.role = body.role;
    if (body.isActive !== undefined) patch.isActive = body.isActive;
    if (body.password !== undefined) {
      patch.passwordHash = await hash(body.password);
    }

    const updated = await store.updateUser(id, patch);
    if (updated === null) {
      return c.json(errorBody("not_found", "User not found"), 404);
    }
    if (body.isActive === false) {
      await store.deleteSessionsForUser(id);
    }
    await store.appendAudit({
      action: "user.update",
      actorUserId: actor.id,
      actorEmail: actor.email,
      entityType: "user",
      entityId: updated.id,
      // Field names only; never patch values (password would be in them).
      details: { fields: Object.keys(body) },
      ip: clientIp(c),
    });
    return c.json({ user: sanitizeUser(updated) }, 200);
  });

  return router;
}
