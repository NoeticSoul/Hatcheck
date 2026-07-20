import { createRoute } from "@hono/zod-openapi";
import type { UserPatch, UserRecord } from "../../db/store";
import { clientIp, createRouter, errorBody, sanitizeUser } from "../context";
import { hashPassword } from "../password";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  cookieSecurity,
  CreateUserBodySchema,
  ErrorSchema,
  jsonContent,
  PatchUserBodySchema,
  UserIdParamsSchema,
  UserListResponseSchema,
  UserOptionsResponseSchema,
  UserResponseSchema,
} from "../openapi";

const adminOnly = requireRole("admin");
const technicianPlus = requireRole("technician", "admin");

// Before/after state recorded in audit entries for user mutations. Only
// non-sensitive fields: passwordHash never appears here, and a password
// change is visible solely as the field name "password" in `fields`.
function auditSnapshot(user: UserRecord) {
  return {
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    isActive: user.isActive,
  };
}

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

const userOptionsRoute = createRoute({
  method: "get",
  path: "/api/v1/users/options",
  tags: ["users"],
  summary: "Active users for holder pickers (technician or admin)",
  description:
    "Minimal id/displayName/email list of ACTIVE users, unpaginated; " +
    "intended for the custody holder picker. Read-only, not audited.",
  security: cookieSecurity,
  middleware: [requireAuth, technicianPlus],
  responses: {
    200: jsonContent(UserOptionsResponseSchema, "Active users, minimal shape"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Technician or admin role required"),
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
    409: jsonContent(ErrorSchema, "Would remove the last active admin"),
  },
});

export function userRoutes() {
  const router = createRouter();

  router.openapi(listUsersRoute, async (c) => {
    const users = await c.get("store").listUsers();
    return c.json({ users: users.map(sanitizeUser) }, 200);
  });

  router.openapi(userOptionsRoute, async (c) => {
    const users = await c.get("store").listUsers();
    const items = users
      .filter((user) => user.isActive)
      .map((user) => ({
        id: user.id,
        displayName: user.displayName,
        email: user.email,
      }));
    return c.json({ items }, 200);
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
      passwordHash: await hashPassword(body.password),
    });
    await store.appendAudit({
      action: "user.create",
      actorUserId: actor.id,
      actorEmail: actor.email,
      entityType: "user",
      entityId: created.id,
      details: { before: null, after: auditSnapshot(created) },
      ip: clientIp(c),
    });
    return c.json({ user: sanitizeUser(created) }, 201);
  });

  router.openapi(patchUserRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const store = c.get("store");
    const actor = c.get("user");

    const target = await store.getUserById(id);
    if (target === null) {
      return c.json(errorBody("not_found", "User not found"), 404);
    }

    // An instance must always retain at least one active admin, or it can
    // never be administered again (there is no out-of-band role recovery).
    const demotes =
      body.isActive === false ||
      (body.role !== undefined && body.role !== "admin");
    if (demotes && target.role === "admin" && target.isActive) {
      const users = await store.listUsers();
      const activeAdmins = users.filter((u) => u.role === "admin" && u.isActive);
      if (activeAdmins.length <= 1) {
        return c.json(
          errorBody(
            "last_admin",
            "Cannot deactivate or demote the last active admin",
          ),
          409,
        );
      }
    }

    const patch: UserPatch = {};
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.role !== undefined) patch.role = body.role;
    if (body.isActive !== undefined) patch.isActive = body.isActive;
    if (body.password !== undefined) {
      patch.passwordHash = await hashPassword(body.password);
    }

    const updated = await store.updateUser(id, patch);
    if (updated === null) {
      return c.json(errorBody("not_found", "User not found"), 404);
    }
    // Deactivation and password reset both invalidate existing sessions;
    // a stolen cookie must not survive a credential rotation (CWE-613).
    // Admins resetting their own password sign themselves out too.
    if (body.isActive === false || body.password !== undefined) {
      await store.deleteSessionsForUser(id);
    }
    await store.appendAudit({
      action: "user.update",
      actorUserId: actor.id,
      actorEmail: actor.email,
      entityType: "user",
      entityId: updated.id,
      // Patched field names plus sanitized before/after snapshots; raw
      // patch values are never logged (password would be among them).
      details: {
        fields: Object.keys(body),
        before: auditSnapshot(target),
        after: auditSnapshot(updated),
      },
      ip: clientIp(c),
    });
    return c.json({ user: sanitizeUser(updated) }, 200);
  });

  return router;
}
