// Contract suite proving both engines satisfy the Store interface
// identically (CLAUDE.md hard rule 1). The same tests run against SQLite
// always, and against PostgreSQL when HATCHECK_TEST_PG_URL is set.
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewUser, Store } from "./store";
import { createPgStore } from "./store.pg";
import { createSqliteStore } from "./store.sqlite";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeUser(overrides: Partial<NewUser> = {}): NewUser {
  return {
    email: "admin@hatcheck.test",
    displayName: "Instance Admin",
    role: "admin",
    authSource: "local",
    passwordHash: "argon2-placeholder-hash",
    ...overrides,
  };
}

export function storeContractTests(
  name: string,
  makeStore: () => Promise<Store>,
): void {
  describe(name, () => {
    let store: Store;

    beforeEach(async () => {
      store = await makeStore();
    });

    afterEach(async () => {
      await store.close();
    });

    describe("users", () => {
      it("creates a user and reads it back by id and email", async () => {
        const created = await store.createUser(makeUser());
        expect(created.id).toBeTruthy();
        expect(created.email).toBe("admin@hatcheck.test");
        expect(created.isActive).toBe(true);
        expect(created.oidcSubject).toBeNull();
        expect(created.createdAt).toBeGreaterThan(0);
        expect(created.updatedAt).toBe(created.createdAt);

        expect(await store.getUserById(created.id)).toEqual(created);
        expect(await store.getUserByEmail("admin@hatcheck.test")).toEqual(
          created,
        );
      });

      it("lowercases email on create and on lookup", async () => {
        const created = await store.createUser(
          makeUser({ email: "Taylor.Tech@Hatcheck.TEST" }),
        );
        expect(created.email).toBe("taylor.tech@hatcheck.test");
        expect(await store.getUserByEmail("TAYLOR.TECH@hatcheck.test")).toEqual(
          created,
        );
      });

      it("returns null for unknown id, email, and oidc subject", async () => {
        expect(await store.getUserById("missing-id")).toBeNull();
        expect(await store.getUserByEmail("nobody@hatcheck.test")).toBeNull();
        expect(await store.getUserByOidcSubject("missing-sub")).toBeNull();
      });

      it("finds a user by oidc subject", async () => {
        const created = await store.createUser(
          makeUser({
            email: "rowan.report@hatcheck.test",
            authSource: "oidc",
            passwordHash: null,
            oidcSubject: "idp-subject-1234",
          }),
        );
        expect(await store.getUserByOidcSubject("idp-subject-1234")).toEqual(
          created,
        );
      });

      it("rejects a duplicate email", async () => {
        await store.createUser(makeUser());
        await expect(
          store.createUser(makeUser({ displayName: "Duplicate Dana" })),
        ).rejects.toThrow();
      });

      it("lists users ordered by email ascending", async () => {
        await store.createUser(makeUser({ email: "rowan.report@hatcheck.test" }));
        await store.createUser(makeUser({ email: "admin@hatcheck.test" }));
        await store.createUser(makeUser({ email: "taylor.tech@hatcheck.test" }));
        const users = await store.listUsers();
        expect(users.map((u) => u.email)).toEqual([
          "admin@hatcheck.test",
          "rowan.report@hatcheck.test",
          "taylor.tech@hatcheck.test",
        ]);
      });

      it("patches a user and bumps updatedAt", async () => {
        const created = await store.createUser(makeUser());
        await sleep(5);
        const updated = await store.updateUser(created.id, {
          displayName: "Renamed Admin",
          role: "technician",
          isActive: false,
        });
        expect(updated).not.toBeNull();
        expect(updated?.displayName).toBe("Renamed Admin");
        expect(updated?.role).toBe("technician");
        expect(updated?.isActive).toBe(false);
        expect(updated?.email).toBe(created.email);
        expect(updated?.updatedAt).toBeGreaterThan(created.updatedAt);
        expect(await store.getUserById(created.id)).toEqual(updated);
      });

      it("updateUser returns null for a missing id", async () => {
        expect(
          await store.updateUser("missing-id", { displayName: "Nobody" }),
        ).toBeNull();
      });

      it("counts users", async () => {
        expect(await store.countUsers()).toBe(0);
        await store.createUser(makeUser());
        await store.createUser(makeUser({ email: "taylor.tech@hatcheck.test" }));
        expect(await store.countUsers()).toBe(2);
      });
    });

    describe("sessions", () => {
      const HASH_A = "a".repeat(64);
      const HASH_B = "b".repeat(64);
      const HASH_C = "c".repeat(64);

      it("creates a session and joins it to its user", async () => {
        const user = await store.createUser(makeUser());
        const now = Date.now();
        await store.createSession({
          tokenHash: HASH_A,
          userId: user.id,
          expiresAt: now + 60_000,
          ip: "203.0.113.10",
          userAgent: "vitest",
        });
        const found = await store.getSessionUser(HASH_A, now);
        expect(found).not.toBeNull();
        expect(found?.user).toEqual(user);
        expect(found?.session.tokenHash).toBe(HASH_A);
        expect(found?.session.userId).toBe(user.id);
        expect(found?.session.expiresAt).toBe(now + 60_000);
        expect(found?.session.ip).toBe("203.0.113.10");
        expect(found?.session.userAgent).toBe("vitest");
        expect(found?.session.createdAt).toBeGreaterThan(0);
      });

      it("does not return an expired session", async () => {
        const user = await store.createUser(makeUser());
        const now = Date.now();
        await store.createSession({
          tokenHash: HASH_A,
          userId: user.id,
          expiresAt: now - 1,
        });
        expect(await store.getSessionUser(HASH_A, now)).toBeNull();
        // Boundary: expiresAt strictly greater than now is required.
        await store.createSession({
          tokenHash: HASH_B,
          userId: user.id,
          expiresAt: now,
        });
        expect(await store.getSessionUser(HASH_B, now)).toBeNull();
      });

      it("returns null for an unknown token hash", async () => {
        expect(await store.getSessionUser(HASH_A, Date.now())).toBeNull();
      });

      it("deletes a single session", async () => {
        const user = await store.createUser(makeUser());
        const now = Date.now();
        await store.createSession({
          tokenHash: HASH_A,
          userId: user.id,
          expiresAt: now + 60_000,
        });
        await store.deleteSession(HASH_A);
        expect(await store.getSessionUser(HASH_A, now)).toBeNull();
      });

      it("deletes all sessions for one user only", async () => {
        const alpha = await store.createUser(makeUser());
        const beta = await store.createUser(
          makeUser({ email: "taylor.tech@hatcheck.test" }),
        );
        const now = Date.now();
        await store.createSession({
          tokenHash: HASH_A,
          userId: alpha.id,
          expiresAt: now + 60_000,
        });
        await store.createSession({
          tokenHash: HASH_B,
          userId: alpha.id,
          expiresAt: now + 60_000,
        });
        await store.createSession({
          tokenHash: HASH_C,
          userId: beta.id,
          expiresAt: now + 60_000,
        });
        await store.deleteSessionsForUser(alpha.id);
        expect(await store.getSessionUser(HASH_A, now)).toBeNull();
        expect(await store.getSessionUser(HASH_B, now)).toBeNull();
        expect(await store.getSessionUser(HASH_C, now)).not.toBeNull();
      });

      it("deletes only expired sessions", async () => {
        const user = await store.createUser(makeUser());
        const now = Date.now();
        await store.createSession({
          tokenHash: HASH_A,
          userId: user.id,
          expiresAt: now - 1,
        });
        await store.createSession({
          tokenHash: HASH_B,
          userId: user.id,
          expiresAt: now + 60_000,
        });
        await store.deleteExpiredSessions(now);
        // The expired one is gone even when queried with an earlier "now".
        expect(await store.getSessionUser(HASH_A, now - 60_000)).toBeNull();
        expect(await store.getSessionUser(HASH_B, now)).not.toBeNull();
      });
    });

    describe("audit", () => {
      it("appends an entry with serialized details and reads it back", async () => {
        const entry = await store.appendAudit({
          action: "auth.login",
          actorUserId: "user-1",
          actorEmail: "admin@hatcheck.test",
          entityType: "user",
          entityId: "user-1",
          details: { method: "password" },
          ip: "203.0.113.10",
        });
        expect(entry.id).toBeTruthy();
        expect(entry.at).toBeGreaterThan(0);
        expect(entry.details).toBe(JSON.stringify({ method: "password" }));

        const listed = await store.listAudit({ limit: 10 });
        expect(listed).toEqual([entry]);
      });

      it("defaults optional fields to null", async () => {
        const entry = await store.appendAudit({ action: "seed.run" });
        expect(entry.actorUserId).toBeNull();
        expect(entry.actorEmail).toBeNull();
        expect(entry.entityType).toBeNull();
        expect(entry.entityId).toBeNull();
        expect(entry.details).toBeNull();
        expect(entry.ip).toBeNull();
        const listed = await store.listAudit({ limit: 10 });
        expect(listed[0]).toEqual(entry);
      });

      it("lists entries newest-first with action filter, limit, and offset", async () => {
        // Sleeps guarantee distinct `at` values so the desc-by-at ordering
        // is deterministic across engines.
        const first = await store.appendAudit({ action: "auth.login" });
        await sleep(5);
        const second = await store.appendAudit({ action: "auth.logout" });
        await sleep(5);
        const third = await store.appendAudit({ action: "auth.login" });

        const all = await store.listAudit({ limit: 10 });
        expect(all.map((e) => e.id)).toEqual([third.id, second.id, first.id]);

        const logins = await store.listAudit({
          limit: 10,
          action: "auth.login",
        });
        expect(logins.map((e) => e.id)).toEqual([third.id, first.id]);

        const limited = await store.listAudit({ limit: 2 });
        expect(limited.map((e) => e.id)).toEqual([third.id, second.id]);

        const offsetPage = await store.listAudit({ limit: 2, offset: 2 });
        expect(offsetPage.map((e) => e.id)).toEqual([first.id]);

        const filteredOffset = await store.listAudit({
          limit: 10,
          offset: 1,
          action: "auth.login",
        });
        expect(filteredOffset.map((e) => e.id)).toEqual([first.id]);
      });

      it("counts audit entries", async () => {
        expect(await store.countAudit()).toBe(0);
        await store.appendAudit({ action: "auth.login" });
        await store.appendAudit({ action: "auth.logout" });
        expect(await store.countAudit()).toBe(2);
      });
    });

    describe("settings", () => {
      it("returns null for a missing key", async () => {
        expect(await store.getSetting("missing")).toBeNull();
      });

      it("round-trips a structured value", async () => {
        await store.setSetting("instance", { name: "Hatcheck (dev)" });
        expect(await store.getSetting("instance")).toEqual({
          name: "Hatcheck (dev)",
        });
      });

      it("overwrites an existing key", async () => {
        await store.setSetting("instance", { name: "Before" });
        await store.setSetting("instance", { name: "After", extra: 2 });
        expect(await store.getSetting("instance")).toEqual({
          name: "After",
          extra: 2,
        });
      });

      it("stores primitive values", async () => {
        await store.setSetting("flag", true);
        expect(await store.getSetting("flag")).toBe(true);
        await store.setSetting("limit", 25);
        expect(await store.getSetting("limit")).toBe(25);
      });
    });
  });
}

storeContractTests("sqlite store contract", async () => {
  const store = await createSqliteStore(":memory:");
  await store.migrate();
  return store;
});

// Postgres leg of the contract runs only when a test database is provided,
// e.g. HATCHECK_TEST_PG_URL=postgres://user:pass@localhost:5432/hatcheck_test
const pgUrl = process.env.HATCHECK_TEST_PG_URL;

describe.runIf(pgUrl !== undefined && pgUrl !== "")(
  "postgres store (HATCHECK_TEST_PG_URL)",
  () => {
    storeContractTests("postgres store contract", async () => {
      if (!pgUrl) throw new Error("HATCHECK_TEST_PG_URL is not set");
      // Test-harness cleanup only; the dual-DB portability rule applies to
      // core paths, not to resetting a scratch database between tests.
      const admin = postgres(pgUrl, { max: 1 });
      try {
        await admin`DROP TABLE IF EXISTS users, sessions, audit_log, settings CASCADE`;
        // drizzle-orm/postgres-js records applied migrations in schema
        // "drizzle", table "__drizzle_migrations" (see pg-core/dialect.js).
        await admin`DROP SCHEMA IF EXISTS drizzle CASCADE`;
      } finally {
        await admin.end();
      }
      const store = createPgStore(pgUrl);
      await store.migrate();
      return store;
    });
  },
);
