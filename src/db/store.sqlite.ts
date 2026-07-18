import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { and, asc, count, desc, eq, gt, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.sqlite";
import {
  buildAuditRow,
  buildUserRow,
  type AuditEntry,
  type AuditQuery,
  type NewAuditEntry,
  type NewSession,
  type NewUser,
  type SessionRecord,
  type Store,
  type UserPatch,
  type UserRecord,
} from "./store";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("./migrations/sqlite", import.meta.url),
);

export function createSqliteStore(sqlitePath: string): Store {
  if (sqlitePath !== ":memory:") {
    mkdirSync(dirname(resolve(sqlitePath)), { recursive: true });
  }
  const sqlite = new Database(sqlitePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });

  return {
    kind: "sqlite",

    async migrate() {
      migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    },

    async close() {
      sqlite.close();
    },

    async createUser(user: NewUser): Promise<UserRecord> {
      const row = buildUserRow(user);
      db.insert(schema.users).values(row).run();
      return row;
    },

    async getUserById(id: string): Promise<UserRecord | null> {
      const rows = db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, id))
        .limit(1)
        .all();
      return rows[0] ?? null;
    },

    async getUserByEmail(email: string): Promise<UserRecord | null> {
      const rows = db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email.toLowerCase()))
        .limit(1)
        .all();
      return rows[0] ?? null;
    },

    async getUserByOidcSubject(subject: string): Promise<UserRecord | null> {
      const rows = db
        .select()
        .from(schema.users)
        .where(eq(schema.users.oidcSubject, subject))
        .limit(1)
        .all();
      return rows[0] ?? null;
    },

    async listUsers(): Promise<UserRecord[]> {
      return db.select().from(schema.users).orderBy(asc(schema.users.email)).all();
    },

    async updateUser(id: string, patch: UserPatch): Promise<UserRecord | null> {
      const rows = db
        .update(schema.users)
        .set({ ...patch, updatedAt: Date.now() })
        .where(eq(schema.users.id, id))
        .returning()
        .all();
      return rows[0] ?? null;
    },

    async countUsers(): Promise<number> {
      const rows = db.select({ n: count() }).from(schema.users).all();
      return rows[0]?.n ?? 0;
    },

    async createSession(session: NewSession): Promise<void> {
      db.insert(schema.sessions)
        .values({
          tokenHash: session.tokenHash,
          userId: session.userId,
          createdAt: Date.now(),
          expiresAt: session.expiresAt,
          ip: session.ip ?? null,
          userAgent: session.userAgent ?? null,
        })
        .run();
    },

    async getSessionUser(
      tokenHash: string,
      now: number,
    ): Promise<{ session: SessionRecord; user: UserRecord } | null> {
      const rows = db
        .select({ session: schema.sessions, user: schema.users })
        .from(schema.sessions)
        .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
        .where(
          and(
            eq(schema.sessions.tokenHash, tokenHash),
            gt(schema.sessions.expiresAt, now),
          ),
        )
        .limit(1)
        .all();
      return rows[0] ?? null;
    },

    async deleteSession(tokenHash: string): Promise<void> {
      db.delete(schema.sessions)
        .where(eq(schema.sessions.tokenHash, tokenHash))
        .run();
    },

    async deleteSessionsForUser(userId: string): Promise<void> {
      db.delete(schema.sessions)
        .where(eq(schema.sessions.userId, userId))
        .run();
    },

    async deleteExpiredSessions(now: number): Promise<void> {
      db.delete(schema.sessions)
        .where(lt(schema.sessions.expiresAt, now))
        .run();
    },

    async appendAudit(entry: NewAuditEntry): Promise<AuditEntry> {
      const row = buildAuditRow(entry);
      db.insert(schema.auditLog).values(row).run();
      return row;
    },

    async listAudit(query: AuditQuery): Promise<AuditEntry[]> {
      const conditions = query.action
        ? eq(schema.auditLog.action, query.action)
        : undefined;
      return db
        .select()
        .from(schema.auditLog)
        .where(conditions)
        .orderBy(desc(schema.auditLog.at), desc(schema.auditLog.id))
        .limit(query.limit)
        .offset(query.offset ?? 0)
        .all();
    },

    async countAudit(): Promise<number> {
      const rows = db.select({ n: count() }).from(schema.auditLog).all();
      return rows[0]?.n ?? 0;
    },

    async getSetting(key: string): Promise<unknown> {
      const rows = db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.key, key))
        .limit(1)
        .all();
      const row = rows[0];
      return row === undefined ? null : JSON.parse(row.value);
    },

    async setSetting(key: string, value: unknown): Promise<void> {
      const now = Date.now();
      const serialized = JSON.stringify(value);
      db.insert(schema.settings)
        .values({ key, value: serialized, updatedAt: now })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: serialized, updatedAt: now },
        })
        .run();
    },
  };
}
