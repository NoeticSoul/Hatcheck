// Zod schemas shared by route definitions. These drive both runtime
// validation and the generated OpenAPI 3.1 document (CLAUDE.md: API-first,
// spec generated from route definitions).
import { z } from "@hono/zod-openapi";

export const RoleSchema = z
  .enum(["admin", "technician", "readonly"])
  .openapi("Role");

export const ErrorSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string() }),
  })
  .openapi("Error");

// Sanitized user: passwordHash and oidcSubject are intentionally absent.
export const SafeUserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    displayName: z.string(),
    role: RoleSchema,
    authSource: z.enum(["local", "oidc"]),
    isActive: z.boolean(),
    createdAt: z.number(),
  })
  .openapi("User");

export const UserResponseSchema = z.object({ user: SafeUserSchema });

export const UserListResponseSchema = z.object({
  users: z.array(SafeUserSchema),
});

export const LoginBodySchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export const CreateUserBodySchema = z.object({
  email: z.email(),
  displayName: z.string().min(1),
  role: RoleSchema,
  password: z.string().min(12),
});

export const PatchUserBodySchema = z.object({
  displayName: z.string().min(1).optional(),
  role: RoleSchema.optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(12).optional(),
});

export const UserIdParamsSchema = z.object({
  id: z.string().min(1),
});

export const AuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  action: z.string().optional(),
});

export const AuditEntrySchema = z
  .object({
    id: z.string(),
    at: z.number(),
    actorUserId: z.string().nullable(),
    actorEmail: z.string().nullable(),
    action: z.string(),
    entityType: z.string().nullable(),
    entityId: z.string().nullable(),
    details: z.string().nullable(),
    ip: z.string().nullable(),
  })
  .openapi("AuditEntry");

export const AuditListResponseSchema = z.object({
  entries: z.array(AuditEntrySchema),
  total: z.number(),
});

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  version: z.string(),
  db: z.enum(["sqlite", "postgres"]),
  oidcEnabled: z.boolean(),
  aiEnabled: z.boolean(),
});

export const AiStatusResponseSchema = z.object({
  enabled: z.boolean(),
  provider: z.string().nullable(),
});

export function jsonContent<T extends z.ZodType>(schema: T, description: string) {
  return { content: { "application/json": { schema } }, description };
}

/** Standard security requirement for cookie-authenticated routes. */
export const cookieSecurity = [{ cookieAuth: [] }];
