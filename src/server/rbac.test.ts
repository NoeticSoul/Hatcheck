// RBAC tests: role checks are enforced at the API layer. Synthetic data
// only; the test password is a fixture, not a secret.
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

function jsonRequest(
  app: ReturnType<typeof createApp>,
  path: string,
  method: string,
  cookie: string | null,
  body?: unknown,
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie !== null) headers["cookie"] = cookie;
  return app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const NEW_USER = {
  email: "newhire@hatcheck.test",
  displayName: "Robin Newhire",
  role: "technician",
  password: "a-long-enough-password",
};

describe("unauthenticated access", () => {
  it("401s on GET /api/v1/users", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/v1/users");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("401s on POST /api/v1/users", async () => {
    const { app } = await makeApp();
    const res = await jsonRequest(app, "/api/v1/users", "POST", null, NEW_USER);
    expect(res.status).toBe(401);
  });
});

describe("readonly role", () => {
  it("gets 403 on POST /api/v1/users", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "ro@hatcheck.test", "readonly");
    const cookie = await loginAs(app, "ro@hatcheck.test");

    const res = await jsonRequest(app, "/api/v1/users", "POST", cookie, NEW_USER);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("forbidden");
  });

  it("gets 403 on GET /api/v1/users and PATCH /api/v1/users/:id", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "ro@hatcheck.test", "readonly");
    const cookie = await loginAs(app, "ro@hatcheck.test");

    const list = await app.request("/api/v1/users", { headers: { cookie } });
    expect(list.status).toBe(403);

    const patch = await jsonRequest(app, "/api/v1/users/some-id", "PATCH", cookie, {
      role: "admin",
    });
    expect(patch.status).toBe(403);
  });
});

describe("admin user management", () => {
  it("creates a user: 201, audited, response sanitized", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "admin@hatcheck.test", "admin");
    const cookie = await loginAs(app, "admin@hatcheck.test");

    const res = await jsonRequest(app, "/api/v1/users", "POST", cookie, NEW_USER);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.email).toBe("newhire@hatcheck.test");
    expect(body.user.role).toBe("technician");
    expect(body.user).not.toHaveProperty("passwordHash");
    expect(body.user).not.toHaveProperty("oidcSubject");

    const entries = await store.listAudit({ limit: 10, action: "user.create" });
    expect(entries.length).toBe(1);
    expect(entries[0]?.entityId).toBe(body.user.id);

    // The new user can actually log in.
    const cookie2 = await loginAs(app, NEW_USER.email, NEW_USER.password);
    expect(cookie2).toContain("hatcheck_session=");
  });

  it("rejects a duplicate email with 409", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "admin@hatcheck.test", "admin");
    const cookie = await loginAs(app, "admin@hatcheck.test");

    await jsonRequest(app, "/api/v1/users", "POST", cookie, NEW_USER);
    const dup = await jsonRequest(app, "/api/v1/users", "POST", cookie, NEW_USER);
    expect(dup.status).toBe(409);
    const body = await dup.json();
    expect(body.error.code).toBe("email_in_use");
  });

  it("rejects a short password with 400", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "admin@hatcheck.test", "admin");
    const cookie = await loginAs(app, "admin@hatcheck.test");

    const res = await jsonRequest(app, "/api/v1/users", "POST", cookie, {
      ...NEW_USER,
      password: "short",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation_error");
  });

  it("lists users with sanitized shapes", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "admin@hatcheck.test", "admin");
    await seedUser(store, "tech@hatcheck.test", "technician");
    const cookie = await loginAs(app, "admin@hatcheck.test");

    const res = await app.request("/api/v1/users", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.length).toBe(2);
    for (const user of body.users) {
      expect(user).not.toHaveProperty("passwordHash");
    }
  });

  it("PATCH updates role and audits user.update", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "admin@hatcheck.test", "admin");
    const target = await seedUser(store, "tech@hatcheck.test", "technician");
    const cookie = await loginAs(app, "admin@hatcheck.test");

    const res = await jsonRequest(
      app,
      `/api/v1/users/${target.id}`,
      "PATCH",
      cookie,
      { role: "readonly" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.role).toBe("readonly");

    const entries = await store.listAudit({ limit: 10, action: "user.update" });
    expect(entries.length).toBe(1);
    expect(entries[0]?.entityId).toBe(target.id);
  });

  it("deactivation deletes sessions: old cookie becomes 401", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "admin@hatcheck.test", "admin");
    const target = await seedUser(store, "tech@hatcheck.test", "technician");
    const adminCookie = await loginAs(app, "admin@hatcheck.test");
    const targetCookie = await loginAs(app, "tech@hatcheck.test");

    // Session works before deactivation.
    const before = await app.request("/api/v1/auth/me", {
      headers: { cookie: targetCookie },
    });
    expect(before.status).toBe(200);

    const res = await jsonRequest(
      app,
      `/api/v1/users/${target.id}`,
      "PATCH",
      adminCookie,
      { isActive: false },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.isActive).toBe(false);

    const after = await app.request("/api/v1/auth/me", {
      headers: { cookie: targetCookie },
    });
    expect(after.status).toBe(401);
  });

  it("PATCH of an unknown user returns 404", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "admin@hatcheck.test", "admin");
    const cookie = await loginAs(app, "admin@hatcheck.test");

    const res = await jsonRequest(
      app,
      "/api/v1/users/no-such-id",
      "PATCH",
      cookie,
      { displayName: "Nobody" },
    );
    expect(res.status).toBe(404);
  });

  it("PATCH password change re-hashes and allows login with the new one", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "admin@hatcheck.test", "admin");
    const target = await seedUser(store, "tech@hatcheck.test", "technician");
    const cookie = await loginAs(app, "admin@hatcheck.test");

    const newPassword = "another-long-password";
    const res = await jsonRequest(
      app,
      `/api/v1/users/${target.id}`,
      "PATCH",
      cookie,
      { password: newPassword },
    );
    expect(res.status).toBe(200);

    const relogin = await loginAs(app, "tech@hatcheck.test", newPassword);
    expect(relogin).toContain("hatcheck_session=");

    const updated = await store.getUserById(target.id);
    expect(updated?.passwordHash).not.toBe(target.passwordHash);
  });
});
