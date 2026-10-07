import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import type { Store } from "../db/store";
import { createTestStore } from "../test/store";
import { createApp } from "./app";
import { clientIp, createRouter } from "./context";
import { rateLimit } from "./middleware/rate-limit";
import { createSessionToken } from "./session";

const stores: Store[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())); });

async function fixture(env: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({ NODE_ENV: "test", APP_URL: "https://hatcheck.test", ...env });
  const store = await createTestStore();
  stores.push(store);
  await store.migrate();
  const user = await store.createUser({
    email: "admin@hatcheck.test", displayName: "Synthetic Admin", role: "admin", authSource: "local",
  });
  const token = createSessionToken();
  await store.createSession({ tokenHash: token.tokenHash, userId: user.id, expiresAt: Date.now() + 60_000 });
  return { app: createApp(store, config), store, cookie: `hatcheck_session=${token.token}` };
}

describe("browser write security", () => {
  it.each(["https://sibling.hatcheck.test", "https://attacker.test", "null"])(
    "rejects CSV session writes from %s before any mutation", async (origin) => {
      const { app, store, cookie } = await fixture();
      const response = await app.request("/api/v1/imports/assets?mode=commit", {
        method: "POST", headers: { cookie, origin, "content-type": "text/csv", "sec-fetch-site": "same-site" },
        body: "name,asset_tag\nSynthetic device,SYNTHETIC-001",
      });
      expect(response.status).toBe(403);
      expect(await store.countAssets({})).toBe(0);
      expect(await store.countImportJobs()).toBe(0);
    },
  );

  it("rejects untrusted Fetch Metadata even when Origin is missing", async () => {
    const { app, cookie } = await fixture();
    for (const site of ["cross-site", "same-site", "none"]) {
      const response = await app.request("/api/v1/auth/logout", {
        method: "POST", headers: { cookie, "sec-fetch-site": site },
      });
      expect(response.status).toBe(403);
    }
  });

  it("accepts the public origin and requires CSV media type", async () => {
    const { app, cookie } = await fixture();
    const request = (type: string) => app.request("/api/v1/imports/assets?mode=dry_run", {
      method: "POST", headers: { cookie, origin: "https://hatcheck.test", "content-type": type },
      body: "name,asset_tag\nSynthetic device,SYNTHETIC-001",
    });
    expect((await request("text/plain")).status).toBe(415);
    expect((await request("application/x-www-form-urlencoded")).status).toBe(415);
    expect((await request("text/csv; charset=utf-8")).status).toBe(200);
  });

  it("permits native clients and the explicitly supported Vite development origin", async () => {
    const { app, cookie } = await fixture({ NODE_ENV: "development" });
    const response = await app.request("/api/v1/assets", {
      method: "POST", headers: { cookie, "content-type": "application/json", origin: "http://localhost:5173", "sec-fetch-site": "same-site" },
      body: JSON.stringify({ name: "Synthetic device" }),
    });
    expect(response.status).toBe(201);
    expect((await app.request("/api/v1/auth/logout", { method: "POST", headers: { cookie } })).status).toBe(204);
  });

  it("rejects cross-origin login and emits non-cacheable API/security headers", async () => {
    const { app } = await fixture();
    const response = await app.request("/api/v1/auth/login", {
      method: "POST", headers: { origin: "https://attacker.test", "content-type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=31536000");
  });
});

describe("proxy and limiter bounds", () => {
  function proxyApp(proxies = "127.0.0.1") {
    const router = createRouter();
    const config = loadConfig({ HATCHECK_TRUST_PROXY: "true", HATCHECK_TRUSTED_PROXIES: proxies });
    router.use("*", async (c, next) => { c.set("config", config); await next(); });
    router.get("/", (c) => c.json({ ip: clientIp(c) }));
    return router;
  }

  it("ignores forged/malformed forwarded addresses unless a listed peer appended a valid IP", async () => {
    const app = proxyApp();
    const request = (peer?: string, forwarded = "203.0.113.4, 198.51.100.7") =>
      app.request("/", { headers: { "x-forwarded-for": forwarded } }, { remoteAddr: peer });
    expect(await (await request("192.0.2.2")).json()).toEqual({ ip: "192.0.2.2" });
    expect(await (await request()).json()).toEqual({ ip: "local" });
    expect(await (await request("::ffff:127.0.0.1")).json()).toEqual({ ip: "198.51.100.7" });
    expect(await (await request("127.0.0.1", "forged-value")).json()).toEqual({ ip: "127.0.0.1" });
  });

  it("bounds attacker-created rate-limit entries and still limits known clients", async () => {
    const app = proxyApp();
    app.use("/limited", rateLimit({ windowMs: 60_000, max: 1, maxEntries: 2 }));
    app.get("/limited", (c) => c.text("ok"));
    const request = (ip: string) => app.request("/limited", {}, { remoteAddr: ip });
    expect((await request("192.0.2.1")).status).toBe(200);
    expect((await request("192.0.2.2")).status).toBe(200);
    expect((await request("192.0.2.3")).status).toBe(429);
    expect((await request("192.0.2.1")).status).toBe(429);
  });

  it("trusts ALB peers inside configured subnets and rejects forged peers outside them", async () => {
    const app = proxyApp("10.42.1.0/24,10.42.2.0/24");
    const request = (peer?: string, forwarded = "192.0.2.1, 198.51.100.7") =>
      app.request("/", { headers: { "x-forwarded-for": forwarded } }, { remoteAddr: peer });
    expect(await (await request("10.42.1.19")).json()).toEqual({ ip: "198.51.100.7" });
    expect(await (await request("::ffff:10.42.2.30")).json()).toEqual({ ip: "198.51.100.7" });
    expect(await (await request("10.42.3.19")).json()).toEqual({ ip: "10.42.3.19" });
    expect(await (await request()).json()).toEqual({ ip: "local" });
    expect(await (await request("10.42.1.19", "invalid")).json()).toEqual({ ip: "10.42.1.19" });
  });
});
