// Authentication flow tests. All data is synthetic (*.test emails,
// invented names); the test password is a fixture, not a secret.
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

function login(app: ReturnType<typeof createApp>, email: string, password: string) {
  return app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

function sessionCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = /hatcheck_session=([^;]+)/.exec(setCookie);
  if (match === null) throw new Error("no hatcheck_session cookie in response");
  return `hatcheck_session=${match[1]}`;
}

describe("GET /api/v1/health", () => {
  it("is public and reports mode flags", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/v1/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.db).toBe("sqlite");
    expect(body.oidcEnabled).toBe(false);
    expect(body.aiEnabled).toBe(false);
    expect(typeof body.version).toBe("string");
  });
});

describe("POST /api/v1/auth/login", () => {
  it("succeeds, sets an httpOnly cookie, and audits auth.login", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "admin@hatcheck.test", "admin");

    const res = await login(app, "admin@hatcheck.test", TEST_PASSWORD);
    expect(res.status).toBe(200);

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("hatcheck_session=");
    expect(setCookie).toContain("HttpOnly");

    const body = await res.json();
    expect(body.user.email).toBe("admin@hatcheck.test");
    expect(body.user).not.toHaveProperty("passwordHash");

    const entries = await store.listAudit({ limit: 10 });
    expect(entries.map((e) => e.action)).toContain("auth.login");
  });

  it("returns 401 for a wrong password and audits auth.login_failed", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "admin@hatcheck.test", "admin");

    const res = await login(app, "admin@hatcheck.test", "wrong-password-value");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_credentials");

    const entries = await store.listAudit({ limit: 10 });
    expect(entries[0]?.action).toBe("auth.login_failed");
  });

  it("returns the same 401 message for an unknown email", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "admin@hatcheck.test", "admin");

    const wrongPassword = await login(
      app,
      "admin@hatcheck.test",
      "wrong-password-value",
    );
    const unknownEmail = await login(app, "ghost@hatcheck.test", TEST_PASSWORD);
    expect(unknownEmail.status).toBe(401);
    const a = await wrongPassword.json();
    const b = await unknownEmail.json();
    expect(b.error.message).toBe(a.error.message);
  });

  it("rejects an inactive user", async () => {
    const { app, store } = await makeApp();
    const user = await seedUser(store, "gone@hatcheck.test", "technician");
    await store.updateUser(user.id, { isActive: false });

    const res = await login(app, "gone@hatcheck.test", TEST_PASSWORD);
    expect(res.status).toBe(401);
  });

  it("rate limits with 429 after 10 attempts from one IP", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "admin@hatcheck.test", "admin");

    for (let i = 0; i < 10; i += 1) {
      const res = await login(app, "admin@hatcheck.test", "wrong-password-value");
      expect(res.status).toBe(401);
    }
    const blocked = await login(app, "admin@hatcheck.test", TEST_PASSWORD);
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body.error.code).toBe("rate_limited");
  });

  it("returns 400 with the standard error shape for invalid bodies", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation_error");
  });
});

describe("GET /api/v1/auth/me", () => {
  it("round-trips the session cookie", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "tech@hatcheck.test", "technician");
    const loginRes = await login(app, "tech@hatcheck.test", TEST_PASSWORD);
    const cookie = sessionCookie(loginRes);

    const me = await app.request("/api/v1/auth/me", {
      headers: { cookie },
    });
    expect(me.status).toBe(200);
    const body = await me.json();
    expect(body.user.email).toBe("tech@hatcheck.test");
    expect(body.user.role).toBe("technician");
    expect(body.user).not.toHaveProperty("passwordHash");
  });

  it("returns 401 without a cookie", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/v1/auth/me");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 401 for a garbage cookie", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/v1/auth/me", {
      headers: { cookie: "hatcheck_session=not-a-real-token" },
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/auth/logout", () => {
  it("kills the session, audits, and invalidates the old cookie", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "admin@hatcheck.test", "admin");
    const loginRes = await login(app, "admin@hatcheck.test", TEST_PASSWORD);
    const cookie = sessionCookie(loginRes);

    const logout = await app.request("/api/v1/auth/logout", {
      method: "POST",
      headers: { cookie },
    });
    expect(logout.status).toBe(204);

    const entries = await store.listAudit({ limit: 10 });
    expect(entries.map((e) => e.action)).toContain("auth.logout");

    const me = await app.request("/api/v1/auth/me", { headers: { cookie } });
    expect(me.status).toBe(401);
  });

  it("returns 401 when not authenticated", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/v1/auth/logout", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("OIDC when not configured", () => {
  it("GET /api/v1/auth/oidc/login returns 501", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/v1/auth/oidc/login");
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error.code).toBe("oidc_not_configured");
  });

  it("GET /api/v1/auth/oidc/callback returns 501", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/v1/auth/oidc/callback?code=x&state=y");
    expect(res.status).toBe(501);
  });
});

describe("GET /api/v1/ai/status", () => {
  it("requires authentication", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/v1/ai/status");
    expect(res.status).toBe(401);
  });

  it("reports disabled when no provider is configured", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "ro@hatcheck.test", "readonly");
    const cookie = sessionCookie(await login(app, "ro@hatcheck.test", TEST_PASSWORD));
    const res = await app.request("/api/v1/ai/status", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, provider: null });
  });
});

describe("GET /api/v1/openapi.json", () => {
  it("serves a 3.1 document covering the auth routes", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/api/v1/auth/login"]).toBeDefined();
    expect(doc.paths["/api/v1/users"]).toBeDefined();
    expect(doc.components.securitySchemes.cookieAuth.name).toBe(
      "hatcheck_session",
    );
  });
});
