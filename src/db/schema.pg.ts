// PostgreSQL schema. Must stay logically identical to schema.sqlite.ts —
// same tables, columns, and semantics. Timestamps are epoch milliseconds
// (bigint read as number) on both engines. Roles use plain text columns,
// not pgEnum, to keep the schema portable (CLAUDE.md hard rule 1).
import { bigint, boolean, index, pgTable, text } from "drizzle-orm/pg-core";

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
