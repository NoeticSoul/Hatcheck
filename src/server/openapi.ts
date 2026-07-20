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

// ---- Phase 1: Assets ------------------------------------------------------

export const AssetTypeSchema = z
  .enum(["device", "peripheral", "license"])
  .openapi("AssetType");

export const AssetStatusSchema = z
  .enum(["in_stock", "deployed", "in_repair", "retired"])
  .openapi("AssetStatus");

export const AssetSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    assetType: AssetTypeSchema,
    status: AssetStatusSchema,
    locationId: z.string().nullable(),
    model: z.string().nullable(),
    manufacturer: z.string().nullable(),
    notes: z.string().nullable(),
    assetTag: z.string().nullable(),
    assetTagNorm: z.string().nullable(),
    serialNumber: z.string().nullable(),
    serialNumberNorm: z.string().nullable(),
    systemUuid: z.string().nullable(),
    systemUuidNorm: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .openapi("Asset");

export const AssetInterfaceSchema = z
  .object({
    id: z.string(),
    assetId: z.string(),
    mac: z.string(),
    label: z.string().nullable(),
    createdAt: z.number(),
  })
  .openapi("AssetInterface");

export const CustodyEventSchema = z
  .object({
    id: z.string(),
    assetId: z.string(),
    at: z.number(),
    type: z.enum(["check_out", "check_in"]),
    holderUserId: z.string().nullable(),
    holderName: z.string().nullable(),
    locationId: z.string().nullable(),
    locationName: z.string().nullable(),
    note: z.string().nullable(),
    actorUserId: z.string().nullable(),
    actorEmail: z.string().nullable(),
  })
  .openapi("CustodyEvent");

export const AssetListItemSchema = AssetSchema.extend({
  currentCustody: CustodyEventSchema.nullable(),
}).openapi("AssetListItem");

export const AssetListResponseSchema = z.object({
  items: z.array(AssetListItemSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export const AssetResponseSchema = z.object({ asset: AssetSchema });

export const AssetCreateResponseSchema = z.object({
  asset: AssetSchema,
  interfaces: z.array(AssetInterfaceSchema),
});

export const AssetDetailResponseSchema = z.object({
  asset: AssetSchema,
  interfaces: z.array(AssetInterfaceSchema),
  currentCustody: CustodyEventSchema.nullable(),
  location: LocationSchema.nullable(),
});

export const AssetInterfaceResponseSchema = z.object({
  interface: AssetInterfaceSchema,
});

export const AssetIdParamsSchema = z.object({
  id: z.string().min(1),
});

export const AssetInterfaceParamsSchema = z.object({
  id: z.string().min(1),
  interfaceId: z.string().min(1),
});

export const ListAssetsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: AssetStatusSchema.optional(),
  assetType: AssetTypeSchema.optional(),
  locationId: z.uuid().optional(),
  q: z.string().min(1).optional(),
  /** Only assets currently checked out to this user (derived state). */
  heldByUserId: z.uuid().optional(),
});

export const AssetInterfaceInputSchema = z.object({
  mac: z.string().min(1),
  label: z.string().max(100).nullable().optional(),
});

export const CreateAssetBodySchema = z.object({
  name: z.string().min(1).max(200),
  assetType: AssetTypeSchema.optional(),
  status: AssetStatusSchema.optional(),
  locationId: z.uuid().nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  manufacturer: z.string().max(200).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  assetTag: z.string().max(200).nullable().optional(),
  serialNumber: z.string().max(200).nullable().optional(),
  systemUuid: z.string().max(200).nullable().optional(),
  interfaces: z.array(AssetInterfaceInputSchema).max(16).optional(),
});

export const PatchAssetBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  assetType: AssetTypeSchema.optional(),
  status: AssetStatusSchema.optional(),
  locationId: z.uuid().nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  manufacturer: z.string().max(200).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  assetTag: z.string().max(200).nullable().optional(),
  serialNumber: z.string().max(200).nullable().optional(),
  systemUuid: z.string().max(200).nullable().optional(),
});

export const AddAssetInterfaceBodySchema = AssetInterfaceInputSchema;

// ---- Phase 1: Custody -----------------------------------------------------

// Exactly one of holderUserId/holderLabel is required; that cross-field
// rule lives in the custody service so its 400 carries a clear message.
export const CheckOutBodySchema = z.object({
  holderUserId: z.uuid().optional(),
  holderLabel: z.string().min(1).max(200).optional(),
  locationId: z.uuid().optional(),
  note: z.string().max(2000).optional(),
});

export const CheckInBodySchema = z.object({
  locationId: z.uuid().optional(),
  note: z.string().max(2000).optional(),
});

export const CustodyActionResponseSchema = z.object({
  event: CustodyEventSchema,
  asset: AssetSchema,
});

export const CustodyListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const CustodyListResponseSchema = z.object({
  items: z.array(CustodyEventSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

// ---- Phase 1: CSV import & exceptions -------------------------------------

export const ImportModeSchema = z
  .enum(["dry_run", "commit"])
  .openapi("ImportMode");

export const ImportJobSchema = z
  .object({
    id: z.string(),
    at: z.number(),
    actorUserId: z.string().nullable(),
    actorEmail: z.string().nullable(),
    filename: z.string().nullable(),
    fileHash: z.string(),
    mode: ImportModeSchema,
    status: z.enum(["running", "completed", "failed"]),
    totalRows: z.number(),
    createdCount: z.number(),
    skippedCount: z.number(),
    collisionCount: z.number(),
    errorCount: z.number(),
  })
  .openapi("ImportJob");

export const ImportRowSchema = z
  .object({
    id: z.string(),
    jobId: z.string(),
    /** 1-based data-row ordinal; the header row is not counted. */
    rowNumber: z.number(),
    outcome: z.enum(["created", "skipped_duplicate", "collision", "error"]),
    message: z.string().nullable(),
    assetId: z.string().nullable(),
    /** JSON object of the row's cells, keyed by canonical column name. */
    raw: z.string().nullable(),
  })
  .openapi("ImportRow");

export const RunImportQuerySchema = z.object({
  mode: ImportModeSchema,
  filename: z.string().min(1).max(200).optional(),
});

export const ImportRunResponseSchema = z.object({
  job: ImportJobSchema,
  rows: z.array(ImportRowSchema),
  priorImport: ImportJobSchema.nullable(),
});

export const ImportJobResponseSchema = z.object({ job: ImportJobSchema });

export const ImportListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// Rows page cap is higher than other lists so a full 500-row report
// (gate criterion 1) stays retrievable in one request.
export const ImportRowListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const ImportListResponseSchema = z.object({
  items: z.array(ImportJobSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export const ImportRowListResponseSchema = z.object({
  items: z.array(ImportRowSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export const ImportIdParamsSchema = z.object({
  id: z.string().min(1),
});

export const ExceptionStatusSchema = z
  .enum(["open", "resolved", "dismissed"])
  .openapi("ExceptionStatus");

export const ExceptionSchema = z
  .object({
    id: z.string(),
    at: z.number(),
    kind: z.enum(["import_identity_collision"]),
    status: ExceptionStatusSchema,
    assetId: z.string().nullable(),
    importRowId: z.string().nullable(),
    details: z.string().nullable(),
    resolvedByUserId: z.string().nullable(),
    resolvedAt: z.number().nullable(),
    resolutionNote: z.string().nullable(),
  })
  .openapi("ExceptionRecord");

export const ExceptionListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: ExceptionStatusSchema.optional(),
});

export const ExceptionListResponseSchema = z.object({
  items: z.array(ExceptionSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export const ExceptionResponseSchema = z.object({
  exception: ExceptionSchema,
});

export const ExceptionIdParamsSchema = z.object({
  id: z.string().min(1),
});

export const ResolveExceptionBodySchema = z.object({
  status: z.enum(["resolved", "dismissed"]),
  note: z.string().max(2000).optional(),
});

/** Holder-picker option: deliberately minimal, never the full user. */
export const UserOptionSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    email: z.string(),
  })
  .openapi("UserOption");

export const UserOptionsResponseSchema = z.object({
  items: z.array(UserOptionSchema),
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
