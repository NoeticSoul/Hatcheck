// Audit endpoint tests. Synthetic data only; the test password is a
// fixture, not a secret.
import { hash } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { createSqliteStore } from "../db/store.sqlite";
import type { Role, Store } from "../db/store";
import { createApp } from "./app";

const TEST_PASSWORD = "correct-horse-battery-staple";

async function makeApp() {
  const config = loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
  const store = await createSqliteStore(":memory:");
  await store.migrate();
  const app = createApp(store, config);
  return { app, store, config };
}

async function seedUser(
  store: Store,
  email: string,
  role: Role,
  password: string = TEST_PASSWORD,
) {
  return store.createUser({
    email,
    displayName: "Sam Testerly",
    role,
    authSource: "local",
    passwordHash: await hash(password),
  });
}

function sessionCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = /hatcheck_session=([^;]+)/.exec(setCookie);
  if (match === null) throw new Error("no hatcheck_session cookie in response");
  return `hatcheck_session=${match[1]}`;
}

async function loginAs(
  app: ReturnType<typeof createApp>,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<string> {
  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return sessionCookie(res);
}

describe("GET /api/v1/audit", () => {
  it("401s when unauthenticated", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/v1/audit");
    expect(res.status).toBe(401);
  });

  it("403s for non-admin roles", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "ro@hatcheck.test", "readonly");
    const cookie = await loginAs(app, "ro@hatcheck.test");
    const res = await app.request("/api/v1/audit", { headers: { cookie } });
    expect(res.status).toBe(403);
  });

  it("returns entries and total for an admin", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "admin@hatcheck.test", "admin");
    const cookie = await loginAs(app, "admin@hatcheck.test");

    const res = await app.request("/api/v1/audit", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    // At minimum the auth.login entry from loginAs exists.
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.map((e: { action: string }) => e.action)).toContain(
      "auth.login",
    );
  });

  it("filters by action", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "admin@hatcheck.test", "admin");
    // Generate one failed and one successful login.
    await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "admin@hatcheck.test",
        password: "wrong-password-value",
      }),
    });
    const cookie = await loginAs(app, "admin@hatcheck.test");

    const res = await app.request("/api/v1/audit?action=auth.login_failed", {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries.length).toBe(1);
    expect(body.entries[0].action).toBe("auth.login_failed");
  });

  it("respects limit and offset", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "admin@hatcheck.test", "admin");
    const cookie = await loginAs(app, "admin@hatcheck.test");
    for (let i = 0; i < 3; i += 1) {
      await store.appendAudit({ action: "seed.run", details: { i } });
    }

    const limited = await app.request("/api/v1/audit?limit=2&action=seed.run", {
      headers: { cookie },
    });
    const limitedBody = await limited.json();
    expect(limitedBody.entries.length).toBe(2);

    const offset = await app.request(
      "/api/v1/audit?limit=2&offset=2&action=seed.run",
      { headers: { cookie } },
    );
    const offsetBody = await offset.json();
    expect(offsetBody.entries.length).toBe(1);
  });

  it("400s on an invalid limit", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "admin@hatcheck.test", "admin");
    const cookie = await loginAs(app, "admin@hatcheck.test");

    const res = await app.request("/api/v1/audit?limit=0", {
      headers: { cookie },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation_error");
  });
});

// Phase gate assertion: every mutating action writes an audit entry with
// actor, timestamp, and before/after state -- and secret material never
// enters the log.
describe("audit record contents", () => {
  it("user.update records actor, timestamp, and before/after state", async () => {
    const { app, store } = await makeApp();
    const admin = await seedUser(store, "admin@hatcheck.test", "admin");
    const target = await seedUser(store, "tech@hatcheck.test", "technician");
    const cookie = await loginAs(app, "admin@hatcheck.test");
    const t0 = Date.now();

    const res = await app.request(`/api/v1/users/${target.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ role: "readonly" }),
    });
    expect(res.status).toBe(200);

    const [entry] = await store.listAudit({ limit: 1, action: "user.update" });
    if (entry === undefined) throw new Error("no user.update audit entry");
    expect(entry.actorUserId).toBe(admin.id);
    expect(entry.actorEmail).toBe("admin@hatcheck.test");
    expect(entry.at).toBeGreaterThanOrEqual(t0);
    expect(entry.at).toBeLessThanOrEqual(Date.now());
    expect(entry.entityType).toBe("user");
    expect(entry.entityId).toBe(target.id);
    const details = JSON.parse(entry.details ?? "null");
    expect(details.fields).toContain("role");
    expect(details.before.role).toBe("technician");
    expect(details.after.role).toBe("readonly");
    expect(details.before.email).toBe("tech@hatcheck.test");
  });

  it("user.create records actor, timestamp, and the created state", async () => {
    const { app, store } = await makeApp();
    const admin = await seedUser(store, "admin@hatcheck.test", "admin");
    const cookie = await loginAs(app, "admin@hatcheck.test");
    const t0 = Date.now();

    const res = await app.request("/api/v1/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        email: "newhire@hatcheck.test",
        displayName: "Robin Newhire",
        role: "technician",
        password: "a-long-enough-password",
      }),
    });
    expect(res.status).toBe(201);

    const [entry] = await store.listAudit({ limit: 1, action: "user.create" });
    if (entry === undefined) throw new Error("no user.create audit entry");
    expect(entry.actorUserId).toBe(admin.id);
    expect(entry.actorEmail).toBe("admin@hatcheck.test");
    expect(entry.at).toBeGreaterThanOrEqual(t0);
    expect(entry.at).toBeLessThanOrEqual(Date.now());
    const details = JSON.parse(entry.details ?? "null");
    expect(details.before).toBeNull();
    expect(details.after.email).toBe("newhire@hatcheck.test");
    expect(details.after.role).toBe("technician");
  });

  it("password changes never put secret material in the audit log", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "admin@hatcheck.test", "admin");
    const target = await seedUser(store, "tech@hatcheck.test", "technician");
    const cookie = await loginAs(app, "admin@hatcheck.test");

    const newPassword = "brand-new-secret-value-1";
    const res = await app.request(`/api/v1/users/${target.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ password: newPassword }),
    });
    expect(res.status).toBe(200);

    const [entry] = await store.listAudit({ limit: 1, action: "user.update" });
    if (entry === undefined) throw new Error("no user.update audit entry");
    // The change is visible by field name only.
    const details = JSON.parse(entry.details ?? "null");
    expect(details.fields).toContain("password");
    expect(details.before).not.toHaveProperty("password");
    expect(details.before).not.toHaveProperty("passwordHash");
    expect(details.after).not.toHaveProperty("password");
    expect(details.after).not.toHaveProperty("passwordHash");
    // Neither the plaintext nor an argon2 hash appears anywhere in the row.
    expect(entry.details).not.toContain(newPassword);
    expect(entry.details).not.toContain("$argon2");
  });
});
