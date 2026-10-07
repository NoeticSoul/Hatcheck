// Application-level fault and concurrency regressions run against the engine
// selected by the CI matrix, including genuine PostgreSQL HTTP orchestration.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssetRecord, Role, Store } from "../db/store";
import { createTestStore } from "../test/store";
import { createLocation, updateLocation } from "../modules/locations/service";
import { exportAssetsCsv } from "../modules/assets/service";
import { parseCsv } from "../modules/imports/csv";
import { loadConfig } from "../config";
import { createApp } from "./app";
import { hashPassword, verifyPassword } from "./password";
import { createSessionToken } from "./session";

const PASSWORD = "correct-horse-battery-staple";
const stores: Store[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

function inject(store: Store, overrides: (tx: Store) => Partial<Store>): Store {
  return { ...store, ...overrides(store), transaction: (work) => store.transaction((tx) => work(inject(tx, overrides))) };
}

async function context(role: Role = "admin", authSource: "local" | "oidc" = "local") {
  const store = await createTestStore();
  await store.migrate();
  stores.push(store);
  const user = await store.createUser({
    email: "operator@hatcheck.test", displayName: "Synthetic Operator", role,
    authSource, passwordHash: authSource === "local" ? await hashPassword(PASSWORD) : null,
    oidcSubject: authSource === "oidc" ? "synthetic-subject" : null,
  });
  const session = createSessionToken();
  await store.createSession({ tokenHash: session.tokenHash, userId: user.id, expiresAt: Date.now() + 60000 });
  const cookie = `hatcheck_session=${session.token}`;
  const config = loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
  return { store, user, session, cookie, config, app: createApp(store, config) };
}

function request(app: ReturnType<typeof createApp>, cookie: string, path: string, method = "GET", body?: unknown) {
  return app.request(path, {
    method, headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function failAudit(store: Store, action: string) {
  vi.spyOn(console, "error").mockImplementation(() => {});
  return inject(store, (tx) => ({ appendAudit(entry) {
    if (entry.action === action) throw new Error(`Injected ${action} audit failure`);
    return tx.appendAudit(entry);
  } }));
}

async function asset(store: Store): Promise<AssetRecord> {
  return store.createAssetWithInterfaces({ name: "Original Asset", assetTag: "TAG-TEST", assetTagNorm: "TAG-TEST" }, []);
}

describe("HTTP mutation and audit atomicity", () => {
  it("rolls back an asset create when audit append fails, so retry creates only one asset", async () => {
    const c = await context();
    const failing = createApp(failAudit(c.store, "asset.create"), c.config);
    expect((await request(failing, c.cookie, "/api/v1/assets", "POST", { name: "Unaudited Asset" })).status).toBe(500);
    expect(await c.store.countAssets({})).toBe(0);
    expect((await request(c.app, c.cookie, "/api/v1/assets", "POST", { name: "Unaudited Asset" })).status).toBe(201);
    expect(await c.store.countAssets({})).toBe(1);
    expect(await c.store.countAudit({ action: "asset.create" })).toBe(1);
  });

  it("rolls back an asset update or delete when its audit fails", async () => {
    const c = await context();
    const a = await asset(c.store);
    for (const [action, method, body] of [["asset.update", "PATCH", { name: "Changed" }], ["asset.delete", "DELETE", undefined]] as const) {
      const app = createApp(failAudit(c.store, action), c.config);
      expect((await request(app, c.cookie, `/api/v1/assets/${a.id}`, method, body)).status).toBe(500);
      expect((await c.store.getAssetById(a.id))?.name).toBe("Original Asset");
    }
  });

  it("rolls back custody status, location, and history when checkout audit fails", async () => {
    const c = await context();
    const a = await asset(c.store);
    const location = await c.store.createLocation({ name: "Synthetic Bench" });
    const app = createApp(failAudit(c.store, "custody.check_out"), c.config);
    const res = await request(app, c.cookie, `/api/v1/assets/${a.id}/checkout`, "POST", { holderLabel: "Synthetic Holder", locationId: location.id });
    expect(res.status).toBe(500);
    expect((await c.store.getAssetById(a.id))?.status).toBe("in_stock");
    expect((await c.store.getAssetById(a.id))?.locationId).toBeNull();
    expect(await c.store.countCustodyEvents(a.id)).toBe(0);
    expect(await c.store.getCurrentCustody(a.id)).toBeNull();
  });

  it("rolls back a checkin when its audit fails and retains current custody", async () => {
    const c = await context();
    const a = await asset(c.store);
    expect((await request(c.app, c.cookie, `/api/v1/assets/${a.id}/checkout`, "POST", { holderLabel: "Synthetic Holder" })).status).toBe(201);
    const app = createApp(failAudit(c.store, "custody.check_in"), c.config);
    expect((await request(app, c.cookie, `/api/v1/assets/${a.id}/checkin`, "POST", {})).status).toBe(500);
    expect((await c.store.getAssetById(a.id))?.status).toBe("deployed");
    expect(await c.store.countCustodyEvents(a.id)).toBe(1);
    expect((await c.store.getCurrentCustody(a.id))?.holderName).toBe("Synthetic Holder");
  });

  it("rolls back a location mutation and exception decision when their audits fail", async () => {
    const c = await context();
    const locationApp = createApp(failAudit(c.store, "location.create"), c.config);
    expect((await request(locationApp, c.cookie, "/api/v1/locations", "POST", { name: "Synthetic Site", kind: "site" })).status).toBe(500);
    expect(await c.store.countLocations({ includeInactive: true })).toBe(0);
    const exception = await c.store.createException({ kind: "import_identity_collision" });
    const exceptionApp = createApp(failAudit(c.store, "exception.resolve"), c.config);
    expect((await request(exceptionApp, c.cookie, `/api/v1/exceptions/${exception.id}/resolve`, "POST", { status: "resolved", note: "Synthetic review" })).status).toBe(500);
    expect((await c.store.getExceptionById(exception.id))?.status).toBe("open");
  });

  it("rolls back user creation and password reset/session revocation when audits fail", async () => {
    const c = await context();
    const creationApp = createApp(failAudit(c.store, "user.create"), c.config);
    expect((await request(creationApp, c.cookie, "/api/v1/users", "POST", { email: "new@hatcheck.test", displayName: "Synthetic Newhire", role: "technician", password: PASSWORD })).status).toBe(500);
    expect(await c.store.countUsers()).toBe(1);
    const updateApp = createApp(failAudit(c.store, "user.update"), c.config);
    expect((await request(updateApp, c.cookie, `/api/v1/users/${c.user.id}`, "PATCH", { password: "changed-password-value" })).status).toBe(500);
    expect(await verifyPassword((await c.store.getUserById(c.user.id))!.passwordHash!, PASSWORD)).toBe(true);
    expect(await c.store.getSessionUser(c.session.tokenHash, Date.now())).not.toBeNull();
  });

  it("retains a retryable browser session when logout auditing fails", async () => {
    const c = await context();
    const app = createApp(failAudit(c.store, "auth.logout"), c.config);
    const failed = await request(app, c.cookie, "/api/v1/auth/logout", "POST");
    expect(failed.status).toBe(500);
    expect(failed.headers.get("set-cookie")).toBeNull();
    expect(await c.store.getSessionUser(c.session.tokenHash, Date.now())).not.toBeNull();
    const retried = await request(c.app, c.cookie, "/api/v1/auth/logout", "POST");
    expect(retried.status).toBe(204);
    expect(retried.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await c.store.getSessionUser(c.session.tokenHash, Date.now())).toBeNull();
  });

  it("retains the full custody ledger in the deletion audit", async () => {
    const c = await context();
    const a = await asset(c.store);
    await request(c.app, c.cookie, `/api/v1/assets/${a.id}/checkout`, "POST", { holderLabel: "Synthetic Holder", note: "Synthetic handoff" });
    await request(c.app, c.cookie, `/api/v1/assets/${a.id}/checkin`, "POST", { note: "Synthetic return" });
    const ledger = await c.store.listCustodyEvents(a.id, { limit: 100 });
    expect((await request(c.app, c.cookie, `/api/v1/assets/${a.id}`, "DELETE")).status).toBe(204);
    const [audit] = await c.store.listAudit({ limit: 1, action: "asset.delete" });
    expect(JSON.parse(audit!.details!).before.custodyEvents).toEqual(ledger);
    expect(await c.store.getAssetById(a.id)).toBeNull();
  });
});

describe("serialized administrative and hierarchy invariants", () => {
  it("retains one active admin under concurrent self-demotions", async () => {
    const c = await context();
    const second = await c.store.createUser({ email: "second@hatcheck.test", displayName: "Synthetic Second", role: "admin", authSource: "local" });
    const token = createSessionToken();
    await c.store.createSession({ tokenHash: token.tokenHash, userId: second.id, expiresAt: Date.now() + 60000 });
    const responses = await Promise.all([
      request(c.app, c.cookie, `/api/v1/users/${c.user.id}`, "PATCH", { role: "technician" }),
      request(c.app, `hatcheck_session=${token.token}`, `/api/v1/users/${second.id}`, "PATCH", { role: "technician" }),
    ]);
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
    expect((await c.store.listUsers()).filter((user) => user.role === "admin" && user.isActive)).toHaveLength(1);
  });

  it("prevents concurrent cross-parent edits from creating a hierarchy cycle", async () => {
    const c = await context();
    const a = await c.store.createLocation({ name: "Synthetic Site A", kind: "site" });
    const b = await c.store.createLocation({ name: "Synthetic Site B", kind: "site" });
    const results = await Promise.all([
      updateLocation(c.store, a.id, { kind: "building", parentId: b.id }),
      updateLocation(c.store, b.id, { kind: "building", parentId: a.id }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const finalA = await c.store.getLocationById(a.id);
    const finalB = await c.store.getLocationById(b.id);
    expect(finalA?.parentId === b.id && finalB?.parentId === a.id).toBe(false);
  });

  it("prevents concurrent identical root location names", async () => {
    const c = await context();
    const results = await Promise.all([createLocation(c.store, { name: "Synthetic Root" }), createLocation(c.store, { name: "Synthetic Root" })]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await c.store.countLocations({ includeInactive: true })).toBe(1);
  });
});

describe("local self-service password rotation", () => {
  it("allows readonly users, verifies the current password, and revokes every session", async () => {
    const c = await context("readonly");
    const second = createSessionToken();
    await c.store.createSession({ tokenHash: second.tokenHash, userId: c.user.id, expiresAt: Date.now() + 60000 });
    expect((await request(c.app, c.cookie, "/api/v1/users/me/password", "POST", { currentPassword: "incorrect", newPassword: "new-long-password" })).status).toBe(403);
    expect(await c.store.getSessionUser(c.session.tokenHash, Date.now())).not.toBeNull();
    expect((await request(c.app, c.cookie, "/api/v1/users/me/password", "POST", { currentPassword: PASSWORD, newPassword: "short" })).status).toBe(400);
    const res = await request(c.app, c.cookie, "/api/v1/users/me/password", "POST", { currentPassword: PASSWORD, newPassword: "new-long-password" });
    expect(res.status).toBe(200);
    expect(await c.store.getSessionUser(c.session.tokenHash, Date.now())).toBeNull();
    expect(await c.store.getSessionUser(second.tokenHash, Date.now())).toBeNull();
    expect(await verifyPassword((await c.store.getUserById(c.user.id))!.passwordHash!, "new-long-password")).toBe(true);
    const [audit] = await c.store.listAudit({ limit: 1, action: "user.password_change" });
    expect(audit?.details).not.toContain(PASSWORD);
    expect(audit?.details).not.toContain("new-long-password");
  });

  it("requires authentication and rejects identity-provider accounts", async () => {
    const c = await context("readonly", "oidc");
    expect((await request(c.app, "", "/api/v1/users/me/password", "POST", { currentPassword: PASSWORD, newPassword: "new-long-password" })).status).toBe(401);
    expect((await request(c.app, c.cookie, "/api/v1/users/me/password", "POST", { currentPassword: PASSWORD, newPassword: "new-long-password" })).status).toBe(403);
    expect(await c.store.getSessionUser(c.session.tokenHash, Date.now())).not.toBeNull();
  });

  it("rolls back password changes and revocations if their audit fails", async () => {
    const c = await context("technician");
    const app = createApp(failAudit(c.store, "user.password_change"), c.config);
    expect((await request(app, c.cookie, "/api/v1/users/me/password", "POST", { currentPassword: PASSWORD, newPassword: "new-long-password" })).status).toBe(500);
    expect(await verifyPassword((await c.store.getUserById(c.user.id))!.passwordHash!, PASSWORD)).toBe(true);
    expect(await c.store.getSessionUser(c.session.tokenHash, Date.now())).not.toBeNull();
  });
});

describe("bounded consistent asset export", () => {
  it("keeps asset, interface, and location snapshots together under concurrent edits", async () => {
    const c = await context();
    const location = await c.store.createLocation({ name: "Original Location" });
    const a = await asset(c.store);
    await c.store.updateAsset(a.id, { locationId: location.id });
    await c.store.addAssetInterface(a.id, { mac: "00:00:5e:00:53:01" });
    let release!: () => void;
    let observed!: () => void;
    const entered = new Promise<void>((resolve) => { observed = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = inject(c.store, (tx) => ({ async listAssets(query) {
      observed();
      await gate;
      return tx.listAssets(query);
    } }));
    const exporting = exportAssetsCsv(slow, {});
    await entered;
    const edit = c.store.transaction(async (tx) => {
      await tx.updateAsset(a.id, { name: "Changed Asset" });
      await tx.updateLocation(location.id, { name: "Changed Location" });
      await tx.addAssetInterface(a.id, { mac: "00:00:5e:00:53:02" });
    });
    release();
    const result = await exporting;
    await edit;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const csv = parseCsv(result.csv);
    expect(csv.ok).toBe(true);
    if (!csv.ok) return;
    expect(csv.records[1]?.cells[1]).toBe("Original Asset");
    expect(csv.records[1]?.cells[4]).toBe("Original Location");
    expect(csv.records[1]?.cells[11]).toBe("00:00:5e:00:53:01");
    expect((await c.store.getAssetById(a.id))?.name).toBe("Changed Asset");
  });

  it("enforces the row cap during accumulation even if the count underreports", async () => {
    const c = await context();
    const a = await asset(c.store);
    const unbounded = inject(c.store, () => ({ countAssets: async () => 0, listAssets: async () => Array.from({ length: 500 }, () => a) }));
    const result = await exportAssetsCsv(unbounded, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("too_many_rows");
  });
});
