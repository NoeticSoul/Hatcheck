// SQLite schema. Must stay logically identical to schema.pg.ts — same
// tables, columns, and semantics. Timestamps are epoch milliseconds
// (integer) on both engines so query logic never branches by dialect.
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    displayName: text("display_name").notNull(),
    role: text("role", { enum: ["admin", "technician", "readonly"] }).notNull(),
    authSource: text("auth_source", { enum: ["local", "oidc"] }).notNull(),
    passwordHash: text("password_hash"),
    oidcSubject: text("oidc_subject").unique(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
);

export const sessions = sqliteTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
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
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    at: integer("at").notNull(),
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

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// ---- Phase 1: Assets & Locations -----------------------------------------

// Hierarchy site -> building -> room, but parentless locations are fully
// valid so a flat single level works without ceremony. Depth and
// parent-kind ordering are service-layer rules, not schema constraints.
// Root-level (NULL parent) name uniqueness is also enforced in the service
// layer: both engines treat NULLs as distinct in unique indexes.
export const locations = sqliteTable(
  "locations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["site", "building", "room"] })
      .notNull()
      .default("room"),
    parentId: text("parent_id").references(
      (): AnySQLiteColumn => locations.id,
      { onDelete: "restrict" },
    ),
    description: text("description"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("locations_parent_id_idx").on(t.parentId),
    uniqueIndex("locations_parent_name_uq").on(t.parentId, t.name),
  ],
);

// Identity keys are nullable raw values plus app-normalized shadow columns
// carrying plain unique indexes; both engines treat NULLs as distinct, so
// "unique when present" needs no partial indexes or engine collations.
export const assets = sqliteTable(
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
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("assets_status_idx").on(t.status),
    index("assets_location_id_idx").on(t.locationId),
  ],
);

// MACs are per-interface attributes; the index is deliberately NON-unique
// (docks repeat across records) and MAC is never an identity matching key.
export const assetInterfaces = sqliteTable(
  "asset_interfaces",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    mac: text("mac").notNull(),
    label: text("label"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("asset_interfaces_asset_id_idx").on(t.assetId),
    index("asset_interfaces_mac_idx").on(t.mac),
  ],
);

// Append-only custody stream (the ticket stub). The Store interface
// exposes no update or delete for this table. Holder/location are
// denormalized snapshots (audit-log philosophy): history must survive
// later changes to the referenced user or location. ids are time-ordered
// so (at, id) is a total, portable ordering.
export const custodyEvents = sqliteTable(
  "custody_events",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    at: integer("at").notNull(),
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

export const importJobs = sqliteTable(
  "import_jobs",
  {
    id: text("id").primaryKey(),
    at: integer("at").notNull(),
    actorUserId: text("actor_user_id"),
    actorEmail: text("actor_email"),
    filename: text("filename"),
    fileHash: text("file_hash").notNull(),
    mode: text("mode", { enum: ["dry_run", "commit"] }).notNull(),
    status: text("status", { enum: ["running", "completed", "failed"] })
      .notNull()
      .default("running"),
    totalRows: integer("total_rows").notNull().default(0),
    createdCount: integer("created_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    collisionCount: integer("collision_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
  },
  (t) => [index("import_jobs_file_hash_idx").on(t.fileHash)],
);

export const importRows = sqliteTable(
  "import_rows",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => importJobs.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    outcome: text("outcome", {
      enum: ["created", "skipped_duplicate", "collision", "error"],
    }).notNull(),
    message: text("message"),
    assetId: text("asset_id"),
    raw: text("raw"),
  },
  (t) => [index("import_rows_job_id_idx").on(t.jobId)],
);

// Exception-first invariant: identity collisions become records for human
// review, never merges. Asset/import-row references are plain columns so
// exceptions survive hard deletes of what they point at.
export const exceptionRecords = sqliteTable(
  "exception_records",
  {
    id: text("id").primaryKey(),
    at: integer("at").notNull(),
    kind: text("kind", { enum: ["import_identity_collision"] }).notNull(),
    status: text("status", { enum: ["open", "resolved", "dismissed"] })
      .notNull()
      .default("open"),
    assetId: text("asset_id"),
    importRowId: text("import_row_id"),
    details: text("details"),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedAt: integer("resolved_at"),
    resolutionNote: text("resolution_note"),
  },
  (t) => [
    index("exception_records_status_idx").on(t.status),
    index("exception_records_at_idx").on(t.at),
  ],
);
