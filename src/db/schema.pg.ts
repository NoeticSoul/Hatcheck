// PostgreSQL schema. Must stay logically identical to schema.sqlite.ts —
// same tables, columns, and semantics. Timestamps are epoch milliseconds
// (bigint read as number) on both engines. Roles use plain text columns,
// not pgEnum, to keep the schema portable (CLAUDE.md hard rule 1).
import {
  bigint,
  boolean,
  index,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    displayName: text("display_name").notNull(),
    role: text("role", { enum: ["admin", "technician", "readonly"] }).notNull(),
    authSource: text("auth_source", { enum: ["local", "oidc"] }).notNull(),
    passwordHash: text("password_hash"),
    oidcSubject: text("oidc_subject").unique(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
);

export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [
    index("sessions_user_id_idx").on(t.userId),
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

// Append-only: the Store interface exposes no update or delete for this
// table; that absence is the architectural guarantee (CHARTER.md sec. 6).
// No FK to users so audit history survives any future user removal.
export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    at: bigint("at", { mode: "number" }).notNull(),
    actorUserId: text("actor_user_id"),
    actorEmail: text("actor_email"),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    details: text("details"),
    ip: text("ip"),
  },
  (t) => [
    index("audit_log_at_idx").on(t.at),
    index("audit_log_action_idx").on(t.action),
  ],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// ---- Phase 1: Assets & Locations -----------------------------------------
// Must stay logically identical to the Phase 1 tables in schema.sqlite.ts;
// see the comments there for the design rationale (flat-collapsible
// hierarchy, NULL-distinct unique identity keys, append-only custody with
// denormalized snapshots, exception-first import collisions).

export const locations = pgTable(
  "locations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["site", "building", "room"] })
      .notNull()
      .default("room"),
    parentId: text("parent_id").references((): AnyPgColumn => locations.id, {
      onDelete: "restrict",
    }),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("locations_parent_id_idx").on(t.parentId),
    uniqueIndex("locations_parent_name_uq").on(t.parentId, t.name),
  ],
);

export const assets = pgTable(
  "assets",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    assetType: text("asset_type", { enum: ["device", "peripheral", "license"] })
      .notNull()
      .default("device"),
    status: text("status", {
      enum: ["in_stock", "deployed", "in_repair", "retired"],
    })
      .notNull()
      .default("in_stock"),
    locationId: text("location_id").references(() => locations.id, {
      onDelete: "restrict",
    }),
    model: text("model"),
    manufacturer: text("manufacturer"),
    notes: text("notes"),
    assetTag: text("asset_tag"),
    assetTagNorm: text("asset_tag_norm").unique(),
    serialNumber: text("serial_number"),
    serialNumberNorm: text("serial_number_norm").unique(),
    systemUuid: text("system_uuid"),
    systemUuidNorm: text("system_uuid_norm").unique(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("assets_status_idx").on(t.status),
    index("assets_location_id_idx").on(t.locationId),
  ],
);

export const assetInterfaces = pgTable(
  "asset_interfaces",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    mac: text("mac").notNull(),
    label: text("label"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("asset_interfaces_asset_id_idx").on(t.assetId),
    index("asset_interfaces_mac_idx").on(t.mac),
  ],
);

export const custodyEvents = pgTable(
  "custody_events",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    at: bigint("at", { mode: "number" }).notNull(),
    type: text("type", { enum: ["check_out", "check_in"] }).notNull(),
    holderUserId: text("holder_user_id"),
    holderName: text("holder_name"),
    locationId: text("location_id"),
    locationName: text("location_name"),
    note: text("note"),
    actorUserId: text("actor_user_id"),
    actorEmail: text("actor_email"),
  },
  (t) => [index("custody_events_asset_at_idx").on(t.assetId, t.at)],
);

export const importJobs = pgTable(
  "import_jobs",
  {
    id: text("id").primaryKey(),
    at: bigint("at", { mode: "number" }).notNull(),
    actorUserId: text("actor_user_id"),
    actorEmail: text("actor_email"),
    filename: text("filename"),
    fileHash: text("file_hash").notNull(),
    mode: text("mode", { enum: ["dry_run", "commit"] }).notNull(),
    status: text("status", { enum: ["running", "completed", "failed"] })
      .notNull()
      .default("running"),
    totalRows: bigint("total_rows", { mode: "number" }).notNull().default(0),
    createdCount: bigint("created_count", { mode: "number" })
      .notNull()
      .default(0),
    skippedCount: bigint("skipped_count", { mode: "number" })
      .notNull()
      .default(0),
    collisionCount: bigint("collision_count", { mode: "number" })
      .notNull()
      .default(0),
    errorCount: bigint("error_count", { mode: "number" }).notNull().default(0),
  },
  (t) => [index("import_jobs_file_hash_idx").on(t.fileHash)],
);

export const importRows = pgTable(
  "import_rows",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => importJobs.id, { onDelete: "cascade" }),
    rowNumber: bigint("row_number", { mode: "number" }).notNull(),
    outcome: text("outcome", {
      enum: ["created", "skipped_duplicate", "collision", "error"],
    }).notNull(),
    message: text("message"),
    assetId: text("asset_id"),
    raw: text("raw"),
  },
  (t) => [index("import_rows_job_id_idx").on(t.jobId)],
);

export const exceptionRecords = pgTable(
  "exception_records",
  {
    id: text("id").primaryKey(),
    at: bigint("at", { mode: "number" }).notNull(),
    kind: text("kind", { enum: ["import_identity_collision"] }).notNull(),
    status: text("status", { enum: ["open", "resolved", "dismissed"] })
      .notNull()
      .default("open"),
    assetId: text("asset_id"),
    importRowId: text("import_row_id"),
    details: text("details"),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
    resolutionNote: text("resolution_note"),
  },
  (t) => [
    index("exception_records_status_idx").on(t.status),
    index("exception_records_at_idx").on(t.at),
  ],
);
