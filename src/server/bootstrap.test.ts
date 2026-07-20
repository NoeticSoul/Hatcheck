// First-run bootstrap tests: an empty database gains exactly one usable
// admin (audited, password never stored in plaintext); any existing user
// disables the bootstrap permanently. Synthetic data only.
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { createSqliteStore } from "../db/store.sqlite";
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
    expect(lines.join("\n")).toContain("bootstrap-test-password");

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
});

describe("generatePassword", () => {
  it("emits the requested length from the unambiguous charset", () => {
    const password = generatePassword(24);
    expect(password).toHaveLength(24);
    expect(/^[A-HJ-NP-Za-km-z2-9]+$/.test(password)).toBe(true);
    expect(password).not.toMatch(/[0OIl1]/);
  });
});
