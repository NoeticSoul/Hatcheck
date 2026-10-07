import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config";
import type { Store } from "../db/store";
import { createTestStore } from "../test/store";
import { createApp } from "./app";
import { hashPassword } from "./password";
import { createSessionToken } from "./session";

const PASSWORD = "synthetic-password-fixture";
const stores: Store[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

async function fixture() {
  const store = await createTestStore();
  stores.push(store);
  await store.migrate();
  const user = await store.createUser({
    email: "admin@hatcheck.test", displayName: "Synthetic Admin", role: "admin",
    authSource: "local", passwordHash: await hashPassword(PASSWORD),
  });
  const token = createSessionToken();
  await store.createSession({ tokenHash: token.tokenHash, userId: user.id, expiresAt: Date.now() + 60_000 });
  let issuedTokenHash = "";
  const config = loadConfig({ NODE_ENV: "test" });
  const failing: Store = {
    ...store,
    transaction: (work) => store.transaction(async (tx) => {
      await work({ ...tx, createSession(entry) {
        issuedTokenHash = entry.tokenHash;
        return tx.createSession(entry);
      } });
      // The callback has finished and emitted cookies; force rollback at the
      // transaction boundary to model a failed finalization/COMMIT.
      throw new Error("Synthetic transaction finalization failure");
    }),
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  return {
    store, token, app: createApp(failing, config), healthy: createApp(store, config),
    get issuedTokenHash() { return issuedTokenHash; },
  };
}

describe("session response integrity at the transaction boundary", () => {
  it("does not issue a cookie or persist a new session when login finalization fails", async () => {
    const context = await fixture();
    const response = await context.app.request("/api/v1/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@hatcheck.test", password: PASSWORD }),
    });
    expect(response.status).toBe(500);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(context.issuedTokenHash).not.toBe("");
    expect(await context.store.getSessionUser(context.issuedTokenHash, Date.now())).toBeNull();
    expect(await context.store.countAudit({ action: "auth.login" })).toBe(0);
    expect(await context.store.getSessionUser(context.token.tokenHash, Date.now())).not.toBeNull();
  });

  it("keeps the browser cookie and original session retryable when logout finalization fails", async () => {
    const context = await fixture();
    const request = { method: "POST", headers: { cookie: `hatcheck_session=${context.token.token}` } };
    const failed = await context.app.request("/api/v1/auth/logout", request);
    expect(failed.status).toBe(500);
    expect(failed.headers.get("set-cookie")).toBeNull();
    expect(await context.store.getSessionUser(context.token.tokenHash, Date.now())).not.toBeNull();
    expect(await context.store.countAudit({ action: "auth.logout" })).toBe(0);
    const retried = await context.healthy.request("/api/v1/auth/logout", request);
    expect(retried.status).toBe(204);
    expect(retried.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await context.store.getSessionUser(context.token.tokenHash, Date.now())).toBeNull();
  });
});
