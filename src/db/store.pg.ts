import { fileURLToPath } from "node:url";
import { and, asc, count, desc, eq, gt, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema.pg";
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
  new URL("./migrations/pg", import.meta.url),
);

export function createPgStore(databaseUrl: string): Store {
  const client = postgres(databaseUrl, { max: 10 });
  const db = drizzle(client, { schema });

  return {
    kind: "postgres",

    async migrate() {
      // The migrator needs its own single connection.
      const migrationClient = postgres(databaseUrl, { max: 1 });
      try {
        await migrate(drizzle(migrationClient), {
          migrationsFolder: MIGRATIONS_DIR,
        });
      } finally {
        await migrationClient.end();
      }
    },

    async close() {
      await client.end();
    },

    async createUser(user: NewUser): Promise<UserRecord> {
      const row = buildUserRow(user);
      await db.insert(schema.users).values(row);
      return row;
    },

    async getUserById(id: string): Promise<UserRecord | null> {
      const rows = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async getUserByEmail(email: string): Promise<UserRecord | null> {
      const rows = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email.toLowerCase()))
        .limit(1);
      return rows[0] ?? null;
    },

    async getUserByOidcSubject(subject: string): Promise<UserRecord | null> {
      const rows = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.oidcSubject, subject))
        .limit(1);
      return rows[0] ?? null;
    },

    async listUsers(): Promise<UserRecord[]> {
      const rows = await db
        .select()
        .from(schema.users)
        .orderBy(asc(schema.users.email));
      // Normalize in JS: SQLite orders by bytes, PostgreSQL by locale
      // collation; both stores re-sort so the engines agree exactly.
      return rows.sort((a, b) =>
        a.email < b.email ? -1 : a.email > b.email ? 1 : 0,
      );
    },

    async updateUser(id: string, patch: UserPatch): Promise<UserRecord | null> {
      const rows = await db
        .update(schema.users)
        .set({ ...patch, updatedAt: Date.now() })
        .where(eq(schema.users.id, id))
        .returning();
      return rows[0] ?? null;
    },

    async countUsers(): Promise<number> {
      const rows = await db.select({ n: count() }).from(schema.users);
      return rows[0]?.n ?? 0;
    },

    async createSession(session: NewSession): Promise<void> {
      await db.insert(schema.sessions).values({
        tokenHash: session.tokenHash,
        userId: session.userId,
        createdAt: Date.now(),
        expiresAt: session.expiresAt,
        ip: session.ip ?? null,
        userAgent: session.userAgent ?? null,
      });
    },

    async getSessionUser(
      tokenHash: string,
      now: number,
    ): Promise<{ session: SessionRecord; user: UserRecord } | null> {
      const rows = await db
        .select({ session: schema.sessions, user: schema.users })
        .from(schema.sessions)
        .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
        .where(
          and(
            eq(schema.sessions.tokenHash, tokenHash),
            gt(schema.sessions.expiresAt, now),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async deleteSession(tokenHash: string): Promise<void> {
      await db
        .delete(schema.sessions)
        .where(eq(schema.sessions.tokenHash, tokenHash));
    },

    async deleteSessionsForUser(userId: string): Promise<void> {
      await db
        .delete(schema.sessions)
        .where(eq(schema.sessions.userId, userId));
    },

    async deleteExpiredSessions(now: number): Promise<void> {
      await db
        .delete(schema.sessions)
        .where(lt(schema.sessions.expiresAt, now));
    },

    async appendAudit(entry: NewAuditEntry): Promise<AuditEntry> {
      const row = buildAuditRow(entry);
      await db.insert(schema.auditLog).values(row);
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
        .offset(query.offset ?? 0);
    },

    async countAudit(): Promise<number> {
      const rows = await db.select({ n: count() }).from(schema.auditLog);
      return rows[0]?.n ?? 0;
    },

    async getSetting(key: string): Promise<unknown> {
      const rows = await db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.key, key))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : JSON.parse(row.value);
    },

    async setSetting(key: string, value: unknown): Promise<void> {
      const now = Date.now();
      const serialized = JSON.stringify(value);
      await db
        .insert(schema.settings)
        .values({ key, value: serialized, updatedAt: now })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: serialized, updatedAt: now },
        });
    },
  };
}
