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
