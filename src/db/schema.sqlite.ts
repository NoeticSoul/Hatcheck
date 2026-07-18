// SQLite schema. Must stay logically identical to schema.pg.ts — same
// tables, columns, and semantics. Timestamps are epoch milliseconds
// (integer) on both engines so query logic never branches by dialect.
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
