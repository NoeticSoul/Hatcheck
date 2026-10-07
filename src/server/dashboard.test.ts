import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import type { DocumentInput } from "../db/documents.types";
import type { Role, Store } from "../db/store";
import { createDocument, reviseDocument, transitionDocument } from "../modules/documents/service";
import { createTestStore } from "../test/store";
import { createApp } from "./app";
import { createSessionToken } from "./session";

const stores: Store[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())); });

const SOP: DocumentInput = {
  title: "Synthetic inventory review", reviewDate: "2000-01-01", changeSummary: "Initial review procedure",
  sections: {
    purpose: "Verify synthetic inventory.", scope: "The isolated synthetic lab.",
    prerequisites: "A synthetic inventory fixture.", procedure: "Count the synthetic assets.",
    verification: "Check all synthetic lifecycle states.", escalation: "Ask the synthetic lab administrator.",
  },
};

async function fixture(role: Role = "readonly") {
  const store = await createTestStore();
  await store.migrate();
  stores.push(store);
  const reader = await store.createUser({ email: "reader@dashboard.hatcheck.test", displayName: "Synthetic Reader", role, authSource: "local" });
  const admin = await store.createUser({ email: "admin@dashboard.hatcheck.test", displayName: "Synthetic Admin", role: "admin", authSource: "local" });
  const session = createSessionToken();
  await store.createSession({ tokenHash: session.tokenHash, userId: reader.id, expiresAt: Date.now() + 60000 });
  return { store, reader, admin, app: createApp(store, loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv)), cookie: `hatcheck_session=${session.token}` };
}

describe("operational dashboard", () => {
  it("requires authentication and gives readonly users honest empty totals", async () => {
    const { app, cookie } = await fixture();
    expect((await app.request("/api/v1/dashboard")).status).toBe(401);
    const response = await app.request("/api/v1/dashboard", { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      assets: { total: 0, in_stock: 0, deployed: 0, in_repair: 0, retired: 0 },
      openExceptions: 0, recentCustody: [], overdueDocuments: 0,
    });
  });

  it("counts lifecycle states, open exceptions, recent custody, and overdue approved snapshots", async () => {
    const { store, app, cookie, admin } = await fixture();
    await store.createAssetWithInterfaces({ name: "Synthetic Stock" }, []);
    const held = await store.createAssetWithInterfaces({ name: "Synthetic Deployed" }, []);
    await store.createAssetWithInterfaces({ name: "Synthetic Repair", status: "in_repair" }, []);
    await store.createAssetWithInterfaces({ name: "Synthetic Retired", status: "retired" }, []);
    await store.appendCustodyEvent({ assetId: held.id, type: "check_out", holderName: "Synthetic Holder", actorEmail: admin.email }, "deployed");
    await store.createException({ kind: "import_identity_collision" });
    const resolved = await store.createException({ kind: "import_identity_collision" });
    await store.resolveException(resolved.id, { status: "resolved", resolvedByUserId: admin.id });
    const stale = await createDocument(store, "SOP-LAB-001", SOP, admin, "local");
    await transitionDocument(store, stale.document.id, 1, "published", admin, "local");
    // The latest private draft is fresh, but readers still rely on the
    // back-dated approved revision. The dashboard must count that snapshot.
    await reviseDocument(store, stale.document.id, 1, { ...SOP, reviewDate: "2099-01-01", changeSummary: "Fresh private draft" }, admin, "local");
    const fresh = await createDocument(store, "SOP-LAB-002", { ...SOP, reviewDate: "2099-01-01" }, admin, "local");
    await transitionDocument(store, fresh.document.id, 1, "published", admin, "local");
    await createDocument(store, "SOP-LAB-003", SOP, admin, "local");
    const archived = await createDocument(store, "SOP-LAB-004", SOP, admin, "local");
    await transitionDocument(store, archived.document.id, 1, "published", admin, "local");
    await transitionDocument(store, archived.document.id, 1, "archived", admin, "local");

    const response = await app.request("/api/v1/dashboard", { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.assets).toEqual({ total: 4, in_stock: 1, deployed: 1, in_repair: 1, retired: 1 });
    expect(body.openExceptions).toBe(1);
    expect(body.overdueDocuments).toBe(1);
    expect(body.recentCustody).toEqual([expect.objectContaining({ assetId: held.id, assetName: "Synthetic Deployed", type: "check_out", holderName: "Synthetic Holder" })]);
  });

  it("bounds recent activity to ten events and retains checkin and checkout actions", async () => {
    const { store, app, cookie } = await fixture("technician");
    const asset = await store.createAssetWithInterfaces({ name: "Synthetic Loaner" }, []);
    for (let i = 0; i < 12; i += 1) {
      await store.appendCustodyEvent({ assetId: asset.id, type: i % 2 === 0 ? "check_out" : "check_in", holderName: i % 2 === 0 ? "Synthetic Holder" : null }, i % 2 === 0 ? "deployed" : "in_stock");
    }
    const body = await (await app.request("/api/v1/dashboard", { headers: { cookie } })).json();
    expect(body.recentCustody).toHaveLength(10);
    expect(new Set(body.recentCustody.map((event: { type: string }) => event.type))).toEqual(new Set(["check_out", "check_in"]));
    expect(body.assets.deployed).toBe(0);
    expect(body.assets.in_stock).toBe(1);
  });
});
