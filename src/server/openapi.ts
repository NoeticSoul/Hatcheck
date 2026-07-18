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

// ---- Phase 1: Locations ---------------------------------------------------

export const LocationKindSchema = z
  .enum(["site", "building", "room"])
  .openapi("LocationKind");

export const LocationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: LocationKindSchema,
    parentId: z.string().nullable(),
    description: z.string().nullable(),
    isActive: z.boolean(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .openapi("Location");

export const LocationResponseSchema = z.object({ location: LocationSchema });

export const LocationListResponseSchema = z.object({
  items: z.array(LocationSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export const LocationIdParamsSchema = z.object({
  id: z.string().min(1),
});

/** Query-string booleans: only the exact strings "true"/"false" parse. */
const queryBoolSchema = z
  .enum(["true", "false"])
  .transform((v) => v === "true");

export const ListLocationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  parentId: z.uuid().optional(),
  rootsOnly: queryBoolSchema.optional(),
  kind: LocationKindSchema.optional(),
  q: z.string().min(1).optional(),
  includeInactive: queryBoolSchema.optional(),
});

export const CreateLocationBodySchema = z.object({
  name: z.string().min(1).max(200),
  kind: LocationKindSchema.optional(),
  parentId: z.uuid().nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  isActive: z.boolean().optional(),
});

export const PatchLocationBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  kind: LocationKindSchema.optional(),
  parentId: z.uuid().nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  isActive: z.boolean().optional(),
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
