// Regression tests for the review-pass hardening fixes. Synthetic data
// only; fixture passwords are not secrets.
import { hash } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import type { Role, Store } from "../db/store";
import { createSqliteStore } from "../db/store.sqlite";
import { createApp } from "./app";

const TEST_PASSWORD = "correct-horse-battery-staple";

async function makeApp(env: Record<string, string> = {}) {
  const config = loadConfig({
    NODE_ENV: "test",
    ...env,
  } as NodeJS.ProcessEnv);
  const store = await createSqliteStore(":memory:");
  await store.migrate();
  const app = createApp(store, config);
  return { app, store };
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

function loginRequest(
  email: string,
  password: string,
  headers: Record<string, string> = {},
): [string, RequestInit] {
  return [
    "/api/v1/auth/login",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ email, password }),
    },
  ];
}

async function loginCookie(
  app: ReturnType<typeof createApp>,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<string> {
  const res = await app.request(...loginRequest(email, password));
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  expect(cookie).toContain("hatcheck_session=");
  return cookie;
}

describe("rate limiting vs X-Forwarded-For", () => {
  it("ignores spoofed X-Forwarded-For by default (all clients share the socket identity)", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "victim@hatcheck.test", "admin");

    let limited = false;
    for (let i = 0; i < 12; i++) {
      const res = await app.request(
        ...loginRequest("victim@hatcheck.test", "wrong-password", {
          "x-forwarded-for": `10.0.0.${i}`,
        }),
      );
      if (res.status === 429) {
        limited = true;
        break;
      }
      expect(res.status).toBe(401);
    }
    expect(limited).toBe(true);
  });

  it("with HATCHECK_TRUST_PROXY=true keys on the proxy-appended last hop, not client-prepended ones", async () => {
    const { app, store } = await makeApp({ HATCHECK_TRUST_PROXY: "true" });
    await seedUser(store, "victim@hatcheck.test", "admin");

    // The client varies the first (forgeable) hop, but the trusted proxy
    // appends the same real address last — the limit must still trigger.
    let limited = false;
    for (let i = 0; i < 12; i++) {
      const res = await app.request(
        ...loginRequest("victim@hatcheck.test", "wrong-password", {
          "x-forwarded-for": `203.0.113.${i}, 198.51.100.7`,
        }),
      );
      if (res.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });
});

describe("password reset revokes sessions", () => {
  it("invalidates a live session when an admin resets that user's password", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "admin@hatcheck.test", "admin");
    const target = await seedUser(store, "taylor.tech@hatcheck.test", "technician");

    const adminCookie = await loginCookie(app, "admin@hatcheck.test");
    const targetCookie = await loginCookie(app, "taylor.tech@hatcheck.test");

    const before = await app.request("/api/v1/auth/me", {
      headers: { cookie: targetCookie },
    });
    expect(before.status).toBe(200);

    const patch = await app.request(`/api/v1/users/${target.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ password: "a-brand-new-password" }),
    });
    expect(patch.status).toBe(200);

    const after = await app.request("/api/v1/auth/me", {
      headers: { cookie: targetCookie },
    });
    expect(after.status).toBe(401);
  });
});

describe("last active admin protection", () => {
  it("refuses to deactivate or demote the only active admin", async () => {
    const { app, store } = await makeApp();
    const admin = await seedUser(store, "admin@hatcheck.test", "admin");
    const cookie = await loginCookie(app, "admin@hatcheck.test");

    for (const body of [{ isActive: false }, { role: "technician" }]) {
      const res = await app.request(`/api/v1/users/${admin.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(409);
    }
  });

  it("allows demotion when another active admin remains", async () => {
    const { app, store } = await makeApp();
    const first = await seedUser(store, "admin@hatcheck.test", "admin");
    await seedUser(store, "second.admin@hatcheck.test", "admin");
    const cookie = await loginCookie(app, "second.admin@hatcheck.test");

    const res = await app.request(`/api/v1/users/${first.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ role: "readonly" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("body size limit", () => {
  it("rejects oversized JSON bodies with 413", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "x@hatcheck.test",
        password: "p".repeat(300 * 1024),
      }),
    });
    expect(res.status).toBe(413);
  });
});
