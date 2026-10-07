// First-run bootstrap tests: an empty database gains exactly one usable
// admin (audited, password never stored in plaintext); any existing user
// disables the bootstrap permanently. Synthetic data only.
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { createTestStore as createSqliteStore } from "../test/store";
import { createApp } from "./app";
import { ensureInitialAdmin, generatePassword } from "./bootstrap";

async function makeStore() {
  const store = await createSqliteStore(":memory:");
  await store.migrate();
  return store;
}

describe("ensureInitialAdmin", () => {
  it("creates a login-capable admin on an empty database, once", async () => {
    const store = await makeStore();
    const lines: string[] = [];
    const result = await ensureInitialAdmin(store, {
      adminPassword: "bootstrap-test-password",
      log: (line) => lines.push(line),
    });
    expect(result.created).toBe(true);
    expect(result.email).toBe("admin@hatcheck.test");
    expect(lines.join("\n")).not.toContain("bootstrap-test-password");
    expect(lines.join("\n")).toContain("configured initial password");

    // The account actually works through the real login route.
    const config = loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const app = createApp(store, config);
    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "admin@hatcheck.test",
        password: "bootstrap-test-password",
      }),
    });
    expect(res.status).toBe(200);

    // Audited, with no password material in the trail.
    const audit = await store.listAudit({ limit: 10, action: "user.create" });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorEmail).toBe("system:bootstrap");
    expect(audit[0]?.details ?? "").not.toContain("bootstrap-test-password");

    // Idempotent: a second call changes nothing.
    const again = await ensureInitialAdmin(store, {
      log: () => {},
    });
    expect(again.created).toBe(false);
    expect(await store.countUsers()).toBe(1);
    await store.close();
  });

  it("does nothing when any user already exists", async () => {
    const store = await makeStore();
    await store.createUser({
      email: "existing@hatcheck.test",
      displayName: "Existing User",
      role: "readonly",
      authSource: "local",
      passwordHash: "argon2-placeholder",
    });
    const result = await ensureInitialAdmin(store, { log: () => {} });
    expect(result.created).toBe(false);
    expect(await store.countUsers()).toBe(1);
    await store.close();
  });

  it("honors the configured email and lowercases it", async () => {
    const store = await makeStore();
    const result = await ensureInitialAdmin(store, {
      adminEmail: "Ops.Lead@Hatcheck.TEST",
      adminPassword: "bootstrap-test-password",
      log: () => {},
    });
    expect(result.email).toBe("ops.lead@hatcheck.test");
    expect(await store.getUserByEmail("ops.lead@hatcheck.test")).not.toBeNull();
    await store.close();
  });

  it("serializes concurrent first-run attempts into one audited account", async () => {
    const store = await makeStore();
    const lines: string[] = [];
    try {
      const results = await Promise.all(Array.from({ length: 3 }, () => ensureInitialAdmin(store, {
        log: (line) => lines.push(line),
      })));
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(await store.countUsers()).toBe(1);
      expect(await store.countAudit({ action: "user.create" })).toBe(1);
      expect(lines).toHaveLength(2);
    } finally { await store.close(); }
  });

  it("generates a password when an unset bootstrap secret is represented by an empty environment value", async () => {
    const previous = process.env.HATCHECK_SEED_ADMIN_PASSWORD;
    process.env.HATCHECK_SEED_ADMIN_PASSWORD = "";
    const store = await makeStore();
    const lines: string[] = [];
    try {
      expect((await ensureInitialAdmin(store, { log: (line) => lines.push(line) })).created).toBe(true);
      expect(lines[0]).toMatch(/password: [A-HJ-NP-Za-km-z2-9]{20}$/);
    } finally {
      if (previous === undefined) delete process.env.HATCHECK_SEED_ADMIN_PASSWORD;
      else process.env.HATCHECK_SEED_ADMIN_PASSWORD = previous;
      await store.close();
    }
  });

  it("keeps a supplied cloud bootstrap secret out of log output", async () => {
    const previous = process.env.HATCHECK_SEED_ADMIN_PASSWORD;
    const password = "synthetic-cloud-bootstrap-secret";
    process.env.HATCHECK_SEED_ADMIN_PASSWORD = password;
    const store = await makeStore();
    const lines: string[] = [];
    try {
      expect((await ensureInitialAdmin(store, { log: (line) => lines.push(line) })).created).toBe(true);
      expect(lines.join("\n")).not.toContain(password);
      expect(lines.join("\n")).toContain("configured initial password");
    } finally {
      if (previous === undefined) delete process.env.HATCHECK_SEED_ADMIN_PASSWORD;
      else process.env.HATCHECK_SEED_ADMIN_PASSWORD = previous;
      await store.close();
    }
  });

  it("rolls back the initial account when its audit cannot be recorded", async () => {
    const store = await makeStore();
    const transaction = store.transaction.bind(store);
    store.transaction = (work) => transaction((tx) => work(new Proxy(tx, {
      get(target, property, receiver) {
        if (property === "appendAudit") return async () => { throw new Error("synthetic audit failure"); };
        return Reflect.get(target, property, receiver);
      },
    })));
    try {
      await expect(ensureInitialAdmin(store, { log: () => {} })).rejects.toThrow("synthetic audit failure");
      expect(await store.countUsers()).toBe(0);
      expect(await store.countAudit()).toBe(0);
    } finally { await store.close(); }
  });
});

describe("generatePassword", () => {
  it("emits the requested length from the unambiguous charset", () => {
    const password = generatePassword(24);
    expect(password).toHaveLength(24);
    expect(/^[A-HJ-NP-Za-km-z2-9]+$/.test(password)).toBe(true);
    expect(password).not.toMatch(/[0OIl1]/);
  });
});
