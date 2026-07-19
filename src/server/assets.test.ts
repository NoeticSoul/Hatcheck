// Assets API tests: RBAC, identity-key normalization and uniqueness, the
// strict status/custody coupling, interfaces, cascade delete, list
// filters, and audit records. Synthetic data only: MACs come exclusively
// from the documentation range 00:00:5e:00:53:xx and every serial, tag,
// and UUID is invented. The test password is a fixture, not a secret.
import { hash } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { createSqliteStore } from "../db/store.sqlite";
import type {
  AssetInterfaceRecord,
  AssetRecord,
  AuditEntry,
  Role,
  Store,
} from "../db/store";
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

async function makeAppWithAdmin() {
  const { app, store, config } = await makeApp();
  const admin = await seedUser(store, "admin@hatcheck.test", "admin");
  const cookie = await loginAs(app, "admin@hatcheck.test");
  return { app, store, config, admin, cookie };
}

/** Creates an asset through the API, failing loudly on any error. */
async function createAsset(
  app: ReturnType<typeof createApp>,
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ asset: AssetRecord; interfaces: AssetInterfaceRecord[] }> {
  const res = await jsonRequest(app, "/api/v1/assets", "POST", cookie, body);
  if (res.status !== 201) {
    throw new Error(`create asset failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as {
    asset: AssetRecord;
    interfaces: AssetInterfaceRecord[];
  };
}

/** First element, throwing instead of returning undefined (strict TS). */
function first<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("expected at least one item");
  return item;
}

/** Latest audit entry for an action whose details match the predicate. */
async function findAudit(
  store: Store,
  action: string,
  predicate: (details: string) => boolean = () => true,
): Promise<AuditEntry> {
  const entries = await store.listAudit({ limit: 50, action });
  const entry = entries.find((e) => predicate(e.details ?? ""));
  if (entry === undefined) throw new Error(`no ${action} audit entry found`);
  return entry;
}

describe("assets RBAC", () => {
  it("401s on every endpoint when unauthenticated", async () => {
    const { app } = await makeApp();
    const id = crypto.randomUUID();
    const ifaceId = crypto.randomUUID();
    const attempts = [
      app.request("/api/v1/assets"),
      app.request(`/api/v1/assets/${id}`),
      jsonRequest(app, "/api/v1/assets", "POST", null, { name: "Loaner" }),
      jsonRequest(app, `/api/v1/assets/${id}`, "PATCH", null, { name: "L" }),
      jsonRequest(app, `/api/v1/assets/${id}`, "DELETE", null),
      jsonRequest(app, `/api/v1/assets/${id}/interfaces`, "POST", null, {
        mac: "00:00:5e:00:53:01",
      }),
      jsonRequest(
        app,
        `/api/v1/assets/${id}/interfaces/${ifaceId}`,
        "DELETE",
        null,
      ),
    ];
    for (const attempt of attempts) {
      const res = await attempt;
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("unauthorized");
    }
  });

  it("readonly can GET list and detail but not mutate", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const { asset, interfaces } = await createAsset(app, cookie, {
      name: "Spare Laptop",
      interfaces: [{ mac: "00:00:5e:00:53:02" }],
    });
    await seedUser(store, "ro@hatcheck.test", "readonly");
    const ro = await loginAs(app, "ro@hatcheck.test");

    const list = await app.request("/api/v1/assets", { headers: { cookie: ro } });
    expect(list.status).toBe(200);

    const detail = await app.request(`/api/v1/assets/${asset.id}`, {
      headers: { cookie: ro },
    });
    expect(detail.status).toBe(200);

    const mutations = [
      jsonRequest(app, "/api/v1/assets", "POST", ro, { name: "Nope" }),
      jsonRequest(app, `/api/v1/assets/${asset.id}`, "PATCH", ro, {
        name: "Nope",
      }),
      jsonRequest(app, `/api/v1/assets/${asset.id}`, "DELETE", ro),
      jsonRequest(app, `/api/v1/assets/${asset.id}/interfaces`, "POST", ro, {
        mac: "00:00:5e:00:53:03",
      }),
      jsonRequest(
        app,
        `/api/v1/assets/${asset.id}/interfaces/${first(interfaces).id}`,
        "DELETE",
        ro,
      ),
    ];
    for (const mutation of mutations) {
      const res = await mutation;
      expect(res.status).toBe(403);
    }
  });

  it("technician can create, patch, and manage interfaces but not delete assets", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "tech@hatcheck.test", "technician");
    const tech = await loginAs(app, "tech@hatcheck.test");

    const post = await jsonRequest(app, "/api/v1/assets", "POST", tech, {
      name: "Bench Laptop",
    });
    expect(post.status).toBe(201);
    const { asset } = await post.json();

    const patch = await jsonRequest(
      app,
      `/api/v1/assets/${asset.id}`,
      "PATCH",
      tech,
      { notes: "reimaged" },
    );
    expect(patch.status).toBe(200);

    const addIface = await jsonRequest(
      app,
      `/api/v1/assets/${asset.id}/interfaces`,
      "POST",
      tech,
      { mac: "00:00:5e:00:53:04" },
    );
    expect(addIface.status).toBe(201);
    const ifaceBody = await addIface.json();

    const delIface = await jsonRequest(
      app,
      `/api/v1/assets/${asset.id}/interfaces/${ifaceBody.interface.id}`,
      "DELETE",
      tech,
    );
    expect(delIface.status).toBe(204);

    const del = await jsonRequest(
      app,
      `/api/v1/assets/${asset.id}`,
      "DELETE",
      tech,
    );
    expect(del.status).toBe(403);
  });

  it("admin can DELETE", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const { asset } = await createAsset(app, cookie, { name: "Doomed Laptop" });
    const del = await jsonRequest(
      app,
      `/api/v1/assets/${asset.id}`,
      "DELETE",
      cookie,
    );
    expect(del.status).toBe(204);
  });
});

describe("asset create", () => {
  it("applies defaults and trims the name", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const { asset, interfaces } = await createAsset(app, cookie, {
      name: "  Spare Laptop  ",
    });
    expect(asset.name).toBe("Spare Laptop");
    expect(asset.assetType).toBe("device");
    expect(asset.status).toBe("in_stock");
    expect(asset.locationId).toBeNull();
    expect(asset.model).toBeNull();
    expect(asset.manufacturer).toBeNull();
    expect(asset.notes).toBeNull();
    expect(asset.assetTag).toBeNull();
    expect(asset.serialNumber).toBeNull();
    expect(asset.systemUuid).toBeNull();
    expect(interfaces).toEqual([]);
  });

  it("honors a full payload with two interfaces", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const loc = await store.createLocation({ name: "Imaging Bench" });
    const { asset, interfaces } = await createAsset(app, cookie, {
      name: "Imaging Rig",
      assetType: "device",
      status: "in_repair",
      locationId: loc.id,
      model: "Fictionbook 14",
      manufacturer: "Vantablue",
      notes: "screen flicker under load",
      assetTag: "  HT-0100  ",
      serialNumber: "VB-9000",
      systemUuid: "D0C5E7A2-1111-4222-8333-444455556666",
      interfaces: [
        { mac: "00:00:5E:00:53:0A", label: "onboard" },
        { mac: "00-00-5e-00-53-0b" },
      ],
    });
    expect(asset.assetType).toBe("device");
    expect(asset.status).toBe("in_repair");
    expect(asset.locationId).toBe(loc.id);
    expect(asset.model).toBe("Fictionbook 14");
    expect(asset.manufacturer).toBe("Vantablue");
    expect(asset.notes).toBe("screen flicker under load");
    // Raw values are stored trimmed as entered; case is preserved.
    expect(asset.assetTag).toBe("HT-0100");
    expect(asset.serialNumber).toBe("VB-9000");
    expect(asset.systemUuid).toBe("D0C5E7A2-1111-4222-8333-444455556666");
    // MACs canonicalize to lower-case colon form regardless of input style.
    const macs = interfaces.map((i) => i.mac).sort();
    expect(macs).toEqual(["00:00:5e:00:53:0a", "00:00:5e:00:53:0b"]);
    const labeled = interfaces.find((i) => i.mac === "00:00:5e:00:53:0a");
    expect(labeled?.label).toBe("onboard");
  });

  it("stores serials trimmed as entered but rejects case-variant duplicates", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const { asset } = await createAsset(app, cookie, {
      name: "First Laptop",
      serialNumber: "  VB-2001  ",
    });
    expect(asset.serialNumber).toBe("VB-2001");

    const res = await jsonRequest(app, "/api/v1/assets", "POST", cookie, {
      name: "Second Laptop",
      serialNumber: "vb-2001",
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("identity_in_use");
    expect(body.error.message).toContain("serialNumber");
  });

  it("rejects duplicate asset tags and system UUIDs with 409", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    await createAsset(app, cookie, {
      name: "Tagged Laptop",
      assetTag: "HT-0200",
      systemUuid: "AAAA1111-2222-4333-8444-555566667777",
    });

    const dupTag = await jsonRequest(app, "/api/v1/assets", "POST", cookie, {
      name: "Tag Clone",
      assetTag: "ht-0200",
    });
    expect(dupTag.status).toBe(409);
    const tagBody = await dupTag.json();
    expect(tagBody.error.code).toBe("identity_in_use");
    expect(tagBody.error.message).toContain("assetTag");

    const dupUuid = await jsonRequest(app, "/api/v1/assets", "POST", cookie, {
      name: "Uuid Clone",
      systemUuid: "aaaa1111-2222-4333-8444-555566667777",
    });
    expect(dupUuid.status).toBe(409);
    const uuidBody = await dupUuid.json();
    expect(uuidBody.error.code).toBe("identity_in_use");
    expect(uuidBody.error.message).toContain("systemUuid");
  });

  it("rejects an invalid MAC with 400 invalid_mac", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const res = await jsonRequest(app, "/api/v1/assets", "POST", cookie, {
      name: "Bad Nic Laptop",
      interfaces: [{ mac: "00:00:5e:00:53" }],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_mac");
    expect(body.error.message).toContain("00:00:5e:00:53");
  });

  it("rejects an unknown location with 400 invalid_location", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const res = await jsonRequest(app, "/api/v1/assets", "POST", cookie, {
      name: "Lost Laptop",
      locationId: crypto.randomUUID(),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_location");
  });

  it("rejects status deployed with 400 invalid_status", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const res = await jsonRequest(app, "/api/v1/assets", "POST", cookie, {
      name: "Eager Laptop",
      status: "deployed",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_status");
  });
});

describe("asset patch", () => {
  it("updates fields and bumps updatedAt", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const { asset } = await createAsset(app, cookie, { name: "Old Name" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const res = await jsonRequest(
      app,
      `/api/v1/assets/${asset.id}`,
      "PATCH",
      cookie,
      {
        name: " New Name ",
        model: "Fictionbook 15",
        status: "in_repair",
        notes: "hinge replaced",
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.asset.name).toBe("New Name");
    expect(body.asset.model).toBe("Fictionbook 15");
    expect(body.asset.status).toBe("in_repair");
    expect(body.asset.notes).toBe("hinge replaced");
    expect(body.asset.updatedAt).toBeGreaterThan(asset.updatedAt);
  });

  it("clearing a serial with \"\" stores null and frees it for another asset", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const { asset } = await createAsset(app, cookie, {
      name: "Serial Holder",
      serialNumber: "SN-2100",
    });
    const res = await jsonRequest(
      app,
      `/api/v1/assets/${asset.id}`,
      "PATCH",
      cookie,
      { serialNumber: "" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.asset.serialNumber).toBeNull();

    const reuse = await jsonRequest(app, "/api/v1/assets", "POST", cookie, {
      name: "Serial Inheritor",
      serialNumber: "SN-2100",
    });
    expect(reuse.status).toBe(201);
  });

  it("rejects taking an identity key already held by another asset", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    await createAsset(app, cookie, { name: "Holder", assetTag: "HT-0300" });
    const { asset } = await createAsset(app, cookie, { name: "Taker" });
    const res = await jsonRequest(
      app,
      `/api/v1/assets/${asset.id}`,
      "PATCH",
      cookie,
      { assetTag: "ht-0300" },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("identity_in_use");
  });

  it("rejects setting status deployed with 400 invalid_status", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const { asset } = await createAsset(app, cookie, { name: "Keen Laptop" });
    const res = await jsonRequest(
      app,
      `/api/v1/assets/${asset.id}`,
      "PATCH",
      cookie,
      { status: "deployed" },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_status");
  });

  it("409s on any status change while the asset is deployed", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const { asset } = await createAsset(app, cookie, { name: "Field Laptop" });
    const custody = await store.appendCustodyEvent(
      { assetId: asset.id, type: "check_out", holderName: "Casey Fielding" },
      "deployed",
    );
    expect(custody?.ok).toBe(true);

    const res = await jsonRequest(
      app,
      `/api/v1/assets/${asset.id}`,
      "PATCH",
      cookie,
      { status: "in_stock" },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("asset_checked_out");
  });

  it("allows non-status PATCHes on a deployed asset", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const { asset } = await createAsset(app, cookie, { name: "Field Laptop" });
    await store.appendCustodyEvent(
      { assetId: asset.id, type: "check_out", holderName: "Casey Fielding" },
      "deployed",
    );
    const res = await jsonRequest(
      app,
      `/api/v1/assets/${asset.id}`,
      "PATCH",
      cookie,
      { notes: "charger included" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.asset.notes).toBe("charger included");
    expect(body.asset.status).toBe("deployed");
  });

  it("404s on an unknown id", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const res = await jsonRequest(
      app,
      `/api/v1/assets/${crypto.randomUUID()}`,
      "PATCH",
      cookie,
      { name: "Ghost" },
    );
    expect(res.status).toBe(404);
  });
});

describe("asset interfaces", () => {
  it("adds an interface with a canonical MAC and audits the addition", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const { asset } = await createAsset(app, cookie, { name: "Nic Laptop" });
    const res = await jsonRequest(
      app,
      `/api/v1/assets/${asset.id}/interfaces`,
      "POST",
      cookie,
      { mac: "00-00-5E-00-53-10", label: "dock" },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.interface.assetId).toBe(asset.id);
    expect(body.interface.mac).toBe("00:00:5e:00:53:10");
    expect(body.interface.label).toBe("dock");

    const entry = await findAudit(store, "asset.update", (d) =>
      d.includes("added"),
    );
    expect(entry.entityId).toBe(asset.id);
    const details = JSON.parse(entry.details ?? "null");
    expect(details.fields).toEqual(["interfaces"]);
    expect(details.added).toEqual({ mac: "00:00:5e:00:53:10", label: "dock" });
  });

  it("404s when adding to a missing asset", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const res = await jsonRequest(
      app,
      `/api/v1/assets/${crypto.randomUUID()}/interfaces`,
      "POST",
      cookie,
      { mac: "00:00:5e:00:53:11" },
    );
    expect(res.status).toBe(404);
  });

  it("400s on an invalid MAC", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const { asset } = await createAsset(app, cookie, { name: "Nic Laptop" });
    const res = await jsonRequest(
      app,
      `/api/v1/assets/${asset.id}/interfaces`,
      "POST",
      cookie,
      { mac: "not-a-mac" },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_mac");
  });

  it("removes an interface and audits the removal", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const { asset, interfaces } = await createAsset(app, cookie, {
      name: "Nic Laptop",
      interfaces: [{ mac: "00:00:5e:00:53:12", label: "onboard" }],
    });
    const res = await jsonRequest(
      app,
      `/api/v1/assets/${asset.id}/interfaces/${first(interfaces).id}`,
      "DELETE",
      cookie,
    );
    expect(res.status).toBe(204);
    expect(await store.listAssetInterfaces(asset.id)).toEqual([]);

    const entry = await findAudit(store, "asset.update", (d) =>
      d.includes("removed"),
    );
    expect(entry.entityId).toBe(asset.id);
    const details = JSON.parse(entry.details ?? "null");
    expect(details.fields).toEqual(["interfaces"]);
    expect(details.removed).toEqual({
      mac: "00:00:5e:00:53:12",
      label: "onboard",
    });
  });

  it("404s when the interface id belongs to another asset", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const owner = await createAsset(app, cookie, {
      name: "Owner Laptop",
      interfaces: [{ mac: "00:00:5e:00:53:13" }],
    });
    const other = await createAsset(app, cookie, { name: "Other Laptop" });
    const res = await jsonRequest(
      app,
      `/api/v1/assets/${other.asset.id}/interfaces/${first(owner.interfaces).id}`,
      "DELETE",
      cookie,
    );
    expect(res.status).toBe(404);
    // The mis-addressed interface is untouched on its real owner.
    const still = await store.listAssetInterfaces(owner.asset.id);
    expect(still.map((i) => i.id)).toEqual([first(owner.interfaces).id]);
  });

  it("allows the same MAC on interfaces of two different assets", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const twinA = await createAsset(app, cookie, {
      name: "Twin Alpha",
      interfaces: [{ mac: "00:00:5e:00:53:14" }],
    });
    const twinB = await createAsset(app, cookie, {
      name: "Twin Beta",
      interfaces: [{ mac: "00:00:5e:00:53:14" }],
    });
    expect(first(twinA.interfaces).mac).toBe("00:00:5e:00:53:14");
    expect(first(twinB.interfaces).mac).toBe("00:00:5e:00:53:14");
  });
});

describe("asset delete", () => {
  async function seedDoomedAsset() {
    const ctx = await makeAppWithAdmin();
    const { app, store, cookie } = ctx;
    const { asset } = await createAsset(app, cookie, {
      name: "Doomed Laptop",
      assetTag: "HT-0400",
      interfaces: [{ mac: "00:00:5e:00:53:20", label: "onboard" }],
    });
    const out = await store.appendCustodyEvent(
      { assetId: asset.id, type: "check_out", holderName: "Casey Fielding" },
      "deployed",
    );
    const back = await store.appendCustodyEvent(
      { assetId: asset.id, type: "check_in" },
      "in_stock",
    );
    if (out?.ok !== true || back?.ok !== true) {
      throw new Error("failed to seed custody events");
    }
    return { ...ctx, asset };
  }

  it("cascades interfaces and custody events on delete", async () => {
    const { app, store, cookie, asset } = await seedDoomedAsset();
    expect(await store.countCustodyEvents(asset.id)).toBe(2);

    const res = await jsonRequest(
      app,
      `/api/v1/assets/${asset.id}`,
      "DELETE",
      cookie,
    );
    expect(res.status).toBe(204);
    expect(await store.countCustodyEvents(asset.id)).toBe(0);
    expect(await store.listAssetInterfaces(asset.id)).toEqual([]);

    const get = await app.request(`/api/v1/assets/${asset.id}`, {
      headers: { cookie },
    });
    expect(get.status).toBe(404);
  });

  it("audits the full final snapshot including interfaces and custody count", async () => {
    const { app, store, admin, cookie, asset } = await seedDoomedAsset();
    const t0 = Date.now();
    const res = await jsonRequest(
      app,
      `/api/v1/assets/${asset.id}`,
      "DELETE",
      cookie,
    );
    expect(res.status).toBe(204);

    const entry = await findAudit(store, "asset.delete");
    expect(entry.actorUserId).toBe(admin.id);
    expect(entry.actorEmail).toBe("admin@hatcheck.test");
    expect(entry.at).toBeGreaterThanOrEqual(t0);
    expect(entry.at).toBeLessThanOrEqual(Date.now());
    expect(entry.entityType).toBe("asset");
    expect(entry.entityId).toBe(asset.id);
    const details = JSON.parse(entry.details ?? "null");
    expect(details.after).toBeNull();
    expect(details.before).toEqual({
      name: "Doomed Laptop",
      assetType: "device",
      status: "in_stock",
      locationId: null,
      model: null,
      manufacturer: null,
      notes: null,
      assetTag: "HT-0400",
      serialNumber: null,
      systemUuid: null,
      interfaces: [{ mac: "00:00:5e:00:53:20", label: "onboard" }],
      custodyEventCount: 2,
    });
  });

  it("404s on an unknown id", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const res = await jsonRequest(
      app,
      `/api/v1/assets/${crypto.randomUUID()}`,
      "DELETE",
      cookie,
    );
    expect(res.status).toBe(404);
  });
});

describe("asset list and detail", () => {
  async function seedFleet() {
    const ctx = await makeAppWithAdmin();
    const { app, store, cookie } = ctx;
    const loc = await store.createLocation({ name: "Imaging Bench" });
    const alpha = (
      await createAsset(app, cookie, {
        name: "Alpha Laptop",
        assetType: "device",
        locationId: loc.id,
        serialNumber: "SR-A1",
        interfaces: [{ mac: "00:00:5e:00:53:30" }],
      })
    ).asset;
    const bravo = (
      await createAsset(app, cookie, {
        name: "Bravo Dock",
        assetType: "peripheral",
        locationId: loc.id,
      })
    ).asset;
    const charlie = (
      await createAsset(app, cookie, {
        name: "Charlie Laptop",
        assetType: "device",
        status: "in_repair",
      })
    ).asset;
    const delta = (
      await createAsset(app, cookie, {
        name: "Delta License",
        assetType: "license",
        status: "retired",
      })
    ).asset;
    return { ...ctx, loc, alpha, bravo, charlie, delta };
  }

  it("filters by status, assetType, locationId, and q", async () => {
    const { app, cookie, loc, alpha, bravo, charlie } = await seedFleet();

    const byStatus = await app.request("/api/v1/assets?status=in_repair", {
      headers: { cookie },
    });
    const statusBody = await byStatus.json();
    expect(statusBody.items.map((a: AssetRecord) => a.id)).toEqual([charlie.id]);
    expect(statusBody.total).toBe(1);

    const byType = await app.request("/api/v1/assets?assetType=peripheral", {
      headers: { cookie },
    });
    const typeBody = await byType.json();
    expect(typeBody.items.map((a: AssetRecord) => a.id)).toEqual([bravo.id]);
    expect(typeBody.total).toBe(1);

    const byLoc = await app.request(`/api/v1/assets?locationId=${loc.id}`, {
      headers: { cookie },
    });
    const locBody = await byLoc.json();
    expect(locBody.items.map((a: AssetRecord) => a.id).sort()).toEqual(
      [alpha.id, bravo.id].sort(),
    );
    expect(locBody.total).toBe(2);

    const byName = await app.request("/api/v1/assets?q=LAPTOP", {
      headers: { cookie },
    });
    const nameBody = await byName.json();
    expect(nameBody.items.map((a: AssetRecord) => a.id).sort()).toEqual(
      [alpha.id, charlie.id].sort(),
    );

    // q also reaches serial numbers, case-insensitively.
    const bySerial = await app.request("/api/v1/assets?q=sr-a1", {
      headers: { cookie },
    });
    const serialBody = await bySerial.json();
    expect(serialBody.items.map((a: AssetRecord) => a.id)).toEqual([alpha.id]);
  });

  it("paginates with disjoint pages and a consistent total", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const created: string[] = [];
    for (const name of ["Page A", "Page B", "Page C", "Page D", "Page E"]) {
      const { asset } = await createAsset(app, cookie, { name });
      created.push(asset.id);
    }
    const seen: string[] = [];
    for (const offset of [0, 2, 4]) {
      const res = await app.request(
        `/api/v1/assets?q=page&limit=2&offset=${offset}`,
        { headers: { cookie } },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(5);
      expect(body.limit).toBe(2);
      expect(body.offset).toBe(offset);
      for (const item of body.items as AssetRecord[]) {
        expect(seen).not.toContain(item.id);
        seen.push(item.id);
      }
    }
    expect(seen.sort()).toEqual(created.sort());
  });

  it("caps limit at 200 and rejects bad values", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const tooBig = await app.request("/api/v1/assets?limit=201", {
      headers: { cookie },
    });
    expect(tooBig.status).toBe(400);
    const zero = await app.request("/api/v1/assets?limit=0", {
      headers: { cookie },
    });
    expect(zero.status).toBe(400);
  });

  it("reports currentCustody in both list and detail", async () => {
    const { app, store, cookie, alpha, bravo } = await seedFleet();
    const custody = await store.appendCustodyEvent(
      { assetId: alpha.id, type: "check_out", holderName: "Casey Fielding" },
      "deployed",
    );
    if (custody?.ok !== true) throw new Error("failed to check out alpha");

    const list = await app.request("/api/v1/assets", { headers: { cookie } });
    const listBody = await list.json();
    type Item = AssetRecord & { currentCustody: { id: string } | null };
    const items = listBody.items as Item[];
    const alphaItem = items.find((a) => a.id === alpha.id);
    const bravoItem = items.find((a) => a.id === bravo.id);
    expect(alphaItem?.currentCustody?.id).toBe(custody.event.id);
    expect(alphaItem?.status).toBe("deployed");
    expect(bravoItem?.currentCustody).toBeNull();

    const held = await app.request(`/api/v1/assets/${alpha.id}`, {
      headers: { cookie },
    });
    const heldBody = await held.json();
    expect(heldBody.currentCustody.id).toBe(custody.event.id);
    expect(heldBody.currentCustody.holderName).toBe("Casey Fielding");

    const idle = await app.request(`/api/v1/assets/${bravo.id}`, {
      headers: { cookie },
    });
    const idleBody = await idle.json();
    expect(idleBody.currentCustody).toBeNull();
  });

  it("detail includes interfaces and the resolved location record", async () => {
    const { app, cookie, loc, alpha, charlie } = await seedFleet();
    const res = await app.request(`/api/v1/assets/${alpha.id}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.asset.id).toBe(alpha.id);
    expect(body.interfaces.map((i: AssetInterfaceRecord) => i.mac)).toEqual([
      "00:00:5e:00:53:30",
    ]);
    expect(body.location.id).toBe(loc.id);
    expect(body.location.name).toBe("Imaging Bench");

    const homeless = await app.request(`/api/v1/assets/${charlie.id}`, {
      headers: { cookie },
    });
    const homelessBody = await homeless.json();
    expect(homelessBody.location).toBeNull();
  });

  it("404s on detail for an unknown id", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const res = await app.request(`/api/v1/assets/${crypto.randomUUID()}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });
});

// Phase gate assertion: every asset mutation writes an audit entry with
// actor, timestamp, and before/after state; rejected mutations write none.
describe("asset audit records", () => {
  it("asset.create records actor, timestamp, and the created state", async () => {
    const { app, store, admin, cookie } = await makeAppWithAdmin();
    const loc = await store.createLocation({ name: "Audit Bench" });
    const t0 = Date.now();
    const { asset } = await createAsset(app, cookie, {
      name: "Audit Laptop",
      assetType: "device",
      locationId: loc.id,
      model: "Fictionbook 14",
      assetTag: "HT-0500",
      serialNumber: "VB-0500",
    });

    const entry = await findAudit(store, "asset.create");
    expect(entry.actorUserId).toBe(admin.id);
    expect(entry.actorEmail).toBe("admin@hatcheck.test");
    expect(entry.at).toBeGreaterThanOrEqual(t0);
    expect(entry.at).toBeLessThanOrEqual(Date.now());
    expect(entry.entityType).toBe("asset");
    expect(entry.entityId).toBe(asset.id);
    const details = JSON.parse(entry.details ?? "null");
    expect(details.before).toBeNull();
    expect(details.after).toEqual({
      name: "Audit Laptop",
      assetType: "device",
      status: "in_stock",
      locationId: loc.id,
      model: "Fictionbook 14",
      manufacturer: null,
      notes: null,
      assetTag: "HT-0500",
      serialNumber: "VB-0500",
      systemUuid: null,
    });
  });

  it("asset.update records fields and before/after snapshots", async () => {
    const { app, store, admin, cookie } = await makeAppWithAdmin();
    const { asset } = await createAsset(app, cookie, { name: "Before Laptop" });
    const t0 = Date.now();
    const res = await jsonRequest(
      app,
      `/api/v1/assets/${asset.id}`,
      "PATCH",
      cookie,
      { name: "After Laptop", status: "in_repair" },
    );
    expect(res.status).toBe(200);

    const entry = await findAudit(store, "asset.update");
    expect(entry.actorUserId).toBe(admin.id);
    expect(entry.actorEmail).toBe("admin@hatcheck.test");
    expect(entry.at).toBeGreaterThanOrEqual(t0);
    expect(entry.at).toBeLessThanOrEqual(Date.now());
    expect(entry.entityType).toBe("asset");
    expect(entry.entityId).toBe(asset.id);
    const details = JSON.parse(entry.details ?? "null");
    expect(details.fields.sort()).toEqual(["name", "status"]);
    expect(details.before.name).toBe("Before Laptop");
    expect(details.before.status).toBe("in_stock");
    expect(details.after.name).toBe("After Laptop");
    expect(details.after.status).toBe("in_repair");
  });

  it("rejected mutations write no audit entry", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const { asset } = await createAsset(app, cookie, {
      name: "Guarded Laptop",
      serialNumber: "VB-0600",
    });
    await store.appendCustodyEvent(
      { assetId: asset.id, type: "check_out", holderName: "Casey Fielding" },
      "deployed",
    );
    const countBefore = await store.countAudit();

    const dupSerial = await jsonRequest(app, "/api/v1/assets", "POST", cookie, {
      name: "Serial Clone",
      serialNumber: "vb-0600",
    });
    expect(dupSerial.status).toBe(409);

    const badMac = await jsonRequest(
      app,
      `/api/v1/assets/${asset.id}/interfaces`,
      "POST",
      cookie,
      { mac: "not-a-mac" },
    );
    expect(badMac.status).toBe(400);

    const heldStatus = await jsonRequest(
      app,
      `/api/v1/assets/${asset.id}`,
      "PATCH",
      cookie,
      { status: "in_stock" },
    );
    expect(heldStatus.status).toBe(409);

    const missingDelete = await jsonRequest(
      app,
      `/api/v1/assets/${crypto.randomUUID()}`,
      "DELETE",
      cookie,
    );
    expect(missingDelete.status).toBe(404);

    expect(await store.countAudit()).toBe(countBefore);
  });
});

describe("OpenAPI document", () => {
  it("includes all asset operations", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    const doc = await res.json();

    const collection = doc.paths["/api/v1/assets"];
    expect(collection).toBeDefined();
    expect(collection.get).toBeDefined();
    expect(collection.post).toBeDefined();

    const item = doc.paths["/api/v1/assets/{id}"];
    expect(item).toBeDefined();
    expect(item.get).toBeDefined();
    expect(item.patch).toBeDefined();
    expect(item.delete).toBeDefined();

    const ifaceCollection = doc.paths["/api/v1/assets/{id}/interfaces"];
    expect(ifaceCollection).toBeDefined();
    expect(ifaceCollection.post).toBeDefined();

    const ifaceItem =
      doc.paths["/api/v1/assets/{id}/interfaces/{interfaceId}"];
    expect(ifaceItem).toBeDefined();
    expect(ifaceItem.delete).toBeDefined();
  });
});
