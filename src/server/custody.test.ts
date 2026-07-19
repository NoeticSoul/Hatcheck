// Custody API tests: RBAC, the holder matrix, strict status/custody
// coupling (check-out is the ONLY path to "deployed"), location moves and
// snapshots, the append-only history round trip (Phase 1 gate criterion 3),
// the heldByUserId list filter, the holder-picker endpoint, and audit
// records. Synthetic data only: *.test emails and invented names. The test
// password is a fixture, not a secret.
import { hash } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { createSqliteStore } from "../db/store.sqlite";
import type {
  AssetRecord,
  AuditEntry,
  CustodyEventRecord,
  Role,
  Store,
  UserRecord,
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
  displayName = "Sam Testerly",
): Promise<UserRecord> {
  return store.createUser({
    email,
    displayName,
    role,
    authSource: "local",
    passwordHash: await hash(TEST_PASSWORD),
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
): Promise<string> {
  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
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
  const admin = await seedUser(
    store,
    "admin@hatcheck.test",
    "admin",
    "Ash Admin",
  );
  const cookie = await loginAs(app, "admin@hatcheck.test");
  return { app, store, config, admin, cookie };
}

/** Creates an asset through the API, failing loudly on any error. */
async function createAsset(
  app: ReturnType<typeof createApp>,
  cookie: string,
  body: Record<string, unknown>,
): Promise<AssetRecord> {
  const res = await jsonRequest(app, "/api/v1/assets", "POST", cookie, body);
  if (res.status !== 201) {
    throw new Error(`create asset failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { asset: AssetRecord };
  return json.asset;
}

/** Creates a location through the API, failing loudly on any error. */
async function createLocation(
  app: ReturnType<typeof createApp>,
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const res = await jsonRequest(app, "/api/v1/locations", "POST", cookie, body);
  if (res.status !== 201) {
    throw new Error(`create location failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { location: { id: string; name: string } };
  return json.location;
}

function checkout(
  app: ReturnType<typeof createApp>,
  cookie: string | null,
  assetId: string,
  body: Record<string, unknown>,
) {
  return jsonRequest(
    app,
    `/api/v1/assets/${assetId}/checkout`,
    "POST",
    cookie,
    body,
  );
}

function checkin(
  app: ReturnType<typeof createApp>,
  cookie: string | null,
  assetId: string,
  body: Record<string, unknown> = {},
) {
  return jsonRequest(
    app,
    `/api/v1/assets/${assetId}/checkin`,
    "POST",
    cookie,
    body,
  );
}

async function getAsset(
  app: ReturnType<typeof createApp>,
  cookie: string,
  id: string,
): Promise<AssetRecord> {
  const res = await app.request(`/api/v1/assets/${id}`, {
    headers: { cookie },
  });
  if (res.status !== 200) throw new Error(`get asset failed: ${res.status}`);
  const json = (await res.json()) as { asset: AssetRecord };
  return json.asset;
}

/** Latest audit entry for an action, failing loudly when absent. */
async function findAudit(store: Store, action: string): Promise<AuditEntry> {
  const entries = await store.listAudit({ limit: 50, action });
  const entry = entries[0];
  if (entry === undefined) throw new Error(`no ${action} audit entry found`);
  return entry;
}

async function countAuditFor(store: Store, action: string): Promise<number> {
  return (await store.listAudit({ limit: 500, action })).length;
}

describe("custody RBAC", () => {
  it("401s on every custody endpoint and users/options when unauthenticated", async () => {
    const { app } = await makeApp();
    const id = crypto.randomUUID();
    const attempts = [
      checkout(app, null, id, { holderLabel: "Nobody" }),
      checkin(app, null, id),
      app.request(`/api/v1/assets/${id}/custody`),
      app.request("/api/v1/users/options"),
    ];
    for (const attempt of attempts) {
      const res = await attempt;
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("unauthorized");
    }
  });

  it("readonly cannot check out, check in, or list user options, but can read history", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const asset = await createAsset(app, cookie, { name: "Spare Laptop" });
    await seedUser(store, "ro@hatcheck.test", "readonly", "Riley Readonly");
    const ro = await loginAs(app, "ro@hatcheck.test");

    const forbidden = [
      checkout(app, ro, asset.id, { holderLabel: "Nope" }),
      checkin(app, ro, asset.id),
      app.request("/api/v1/users/options", { headers: { cookie: ro } }),
    ];
    for (const attempt of forbidden) {
      const res = await attempt;
      expect(res.status).toBe(403);
    }

    const history = await app.request(`/api/v1/assets/${asset.id}/custody`, {
      headers: { cookie: ro },
    });
    expect(history.status).toBe(200);
    const body = await history.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("technician can check out, check in, read history, and list options", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "tech@hatcheck.test", "technician", "Taylor Tech");
    const tech = await loginAs(app, "tech@hatcheck.test");
    const asset = await createAsset(app, tech, { name: "Bench Laptop" });

    const out = await checkout(app, tech, asset.id, {
      holderLabel: "Visitor Badge 7",
    });
    expect(out.status).toBe(201);
    const back = await checkin(app, tech, asset.id);
    expect(back.status).toBe(201);

    const history = await app.request(`/api/v1/assets/${asset.id}/custody`, {
      headers: { cookie: tech },
    });
    expect(history.status).toBe(200);

    const options = await app.request("/api/v1/users/options", {
      headers: { cookie: tech },
    });
    expect(options.status).toBe(200);
  });
});

describe("checkout holder matrix", () => {
  it("400s when neither or both holder fields are given", async () => {
    const { app, store, cookie, admin } = await makeAppWithAdmin();
    const asset = await createAsset(app, cookie, { name: "Spare Laptop" });

    const neither = await checkout(app, cookie, asset.id, {});
    expect(neither.status).toBe(400);
    const neitherBody = await neither.json();
    expect(neitherBody.error.code).toBe("validation_error");
    expect(neitherBody.error.message).toContain("exactly one");

    const both = await checkout(app, cookie, asset.id, {
      holderUserId: admin.id,
      holderLabel: "Also A Label",
    });
    expect(both.status).toBe(400);
    const bothBody = await both.json();
    expect(bothBody.error.code).toBe("validation_error");

    // Nothing was written.
    expect(await store.countCustodyEvents(asset.id)).toBe(0);
    expect((await store.getAssetById(asset.id))?.status).toBe("in_stock");
  });

  it("400s invalid_holder for an unknown holderUserId", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const asset = await createAsset(app, cookie, { name: "Spare Laptop" });
    const res = await checkout(app, cookie, asset.id, {
      holderUserId: crypto.randomUUID(),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_holder");
  });

  it("400s invalid_holder for an inactive holder", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const gone = await seedUser(
      store,
      "gone@hatcheck.test",
      "technician",
      "Gone Person",
    );
    await store.updateUser(gone.id, { isActive: false });
    const asset = await createAsset(app, cookie, { name: "Spare Laptop" });
    const res = await checkout(app, cookie, asset.id, {
      holderUserId: gone.id,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_holder");
    expect(await store.countCustodyEvents(asset.id)).toBe(0);
  });

  it("checks out to a label: holderUserId null, holderName is the label", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const asset = await createAsset(app, cookie, { name: "Loaner Laptop" });
    const res = await checkout(app, cookie, asset.id, {
      holderLabel: "  Visitor Badge 7  ",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      event: CustodyEventRecord;
      asset: AssetRecord;
    };
    expect(body.event.type).toBe("check_out");
    expect(body.event.holderUserId).toBeNull();
    expect(body.event.holderName).toBe("Visitor Badge 7");
    expect(body.asset.status).toBe("deployed");
  });

  it("checks out to a user: holderName snapshots the displayName", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const holder = await seedUser(
      store,
      "holder@hatcheck.test",
      "readonly",
      "Harper Holder",
    );
    const asset = await createAsset(app, cookie, { name: "Loaner Laptop" });
    const res = await checkout(app, cookie, asset.id, {
      holderUserId: holder.id,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { event: CustodyEventRecord };
    expect(body.event.holderUserId).toBe(holder.id);
    expect(body.event.holderName).toBe("Harper Holder");
  });
});

describe("status/custody coupling", () => {
  it("checkout from in_stock deploys the asset and records the event", async () => {
    const { app, store, cookie, admin } = await makeAppWithAdmin();
    const asset = await createAsset(app, cookie, { name: "Spare Laptop" });
    expect(asset.status).toBe("in_stock");

    const res = await checkout(app, cookie, asset.id, {
      holderLabel: "Visitor Badge 7",
      note: "loaner for the week",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      event: CustodyEventRecord;
      asset: AssetRecord;
    };
    expect(body.asset.status).toBe("deployed");
    expect(body.event.note).toBe("loaner for the week");
    expect(body.event.actorUserId).toBe(admin.id);
    expect(body.event.actorEmail).toBe("admin@hatcheck.test");
    expect((await store.getAssetById(asset.id))?.status).toBe("deployed");
    expect(await store.countCustodyEvents(asset.id)).toBe(1);
  });

  it("409s already_checked_out when the asset is deployed", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const asset = await createAsset(app, cookie, { name: "Spare Laptop" });
    expect(
      (await checkout(app, cookie, asset.id, { holderLabel: "First" })).status,
    ).toBe(201);
    const res = await checkout(app, cookie, asset.id, {
      holderLabel: "Second",
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("already_checked_out");
    expect(await store.countCustodyEvents(asset.id)).toBe(1);
  });

  it("409s asset_retired for a retired asset", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const asset = await createAsset(app, cookie, {
      name: "Retired Laptop",
      status: "retired",
    });
    const res = await checkout(app, cookie, asset.id, {
      holderLabel: "Anyone",
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("asset_retired");
    expect(await store.countCustodyEvents(asset.id)).toBe(0);
  });

  it("409s asset_unavailable for an asset in repair", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const asset = await createAsset(app, cookie, {
      name: "Broken Laptop",
      status: "in_repair",
    });
    const res = await checkout(app, cookie, asset.id, {
      holderLabel: "Anyone",
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("asset_unavailable");
    expect(await store.countCustodyEvents(asset.id)).toBe(0);
    expect((await store.getAssetById(asset.id))?.status).toBe("in_repair");
  });

  it("checkin returns the asset to in_stock", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const asset = await createAsset(app, cookie, { name: "Spare Laptop" });
    await checkout(app, cookie, asset.id, { holderLabel: "Visitor" });
    const res = await checkin(app, cookie, asset.id, { note: "returned" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      event: CustodyEventRecord;
      asset: AssetRecord;
    };
    expect(body.event.type).toBe("check_in");
    expect(body.event.note).toBe("returned");
    expect(body.asset.status).toBe("in_stock");
    expect((await store.getAssetById(asset.id))?.status).toBe("in_stock");
  });

  it("409s not_checked_out on checkin of an idle asset", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const asset = await createAsset(app, cookie, { name: "Idle Laptop" });
    const res = await checkin(app, cookie, asset.id);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("not_checked_out");
    expect(await store.countCustodyEvents(asset.id)).toBe(0);
  });

  it("404s on both endpoints for an unknown asset", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const id = crypto.randomUUID();
    expect(
      (await checkout(app, cookie, id, { holderLabel: "Anyone" })).status,
    ).toBe(404);
    expect((await checkin(app, cookie, id)).status).toBe(404);
  });
});

describe("custody locations", () => {
  it("checkout with a locationId moves the asset and snapshots the name", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const room = await createLocation(app, cookie, { name: "Room 101" });
    const asset = await createAsset(app, cookie, { name: "Spare Laptop" });
    expect(asset.locationId).toBeNull();

    const res = await checkout(app, cookie, asset.id, {
      holderLabel: "Visitor",
      locationId: room.id,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      event: CustodyEventRecord;
      asset: AssetRecord;
    };
    expect(body.event.locationId).toBe(room.id);
    expect(body.event.locationName).toBe("Room 101");
    expect(body.asset.locationId).toBe(room.id);
    expect((await store.getAssetById(asset.id))?.locationId).toBe(room.id);
  });

  it("checkout without a locationId leaves the asset location unchanged", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const room = await createLocation(app, cookie, { name: "Room 101" });
    const asset = await createAsset(app, cookie, {
      name: "Homed Laptop",
      locationId: room.id,
    });
    const res = await checkout(app, cookie, asset.id, {
      holderLabel: "Visitor",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { event: CustodyEventRecord };
    expect(body.event.locationId).toBeNull();
    expect(body.event.locationName).toBeNull();
    expect((await store.getAssetById(asset.id))?.locationId).toBe(room.id);
  });

  it("400s invalid_location and writes no event and no status change", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const asset = await createAsset(app, cookie, { name: "Spare Laptop" });
    const res = await checkout(app, cookie, asset.id, {
      holderLabel: "Visitor",
      locationId: crypto.randomUUID(),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_location");
    expect(await store.countCustodyEvents(asset.id)).toBe(0);
    expect((await store.getAssetById(asset.id))?.status).toBe("in_stock");

    // Same guard on checkin.
    await checkout(app, cookie, asset.id, { holderLabel: "Visitor" });
    const badIn = await checkin(app, cookie, asset.id, {
      locationId: crypto.randomUUID(),
    });
    expect(badIn.status).toBe(400);
    expect(await store.countCustodyEvents(asset.id)).toBe(1);
    expect((await store.getAssetById(asset.id))?.status).toBe("deployed");
  });

  it("checkin with a locationId moves the asset back to that location", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const room = await createLocation(app, cookie, { name: "Room 101" });
    const shelf = await createLocation(app, cookie, { name: "Storage Shelf" });
    const asset = await createAsset(app, cookie, { name: "Spare Laptop" });
    await checkout(app, cookie, asset.id, {
      holderLabel: "Visitor",
      locationId: room.id,
    });
    const res = await checkin(app, cookie, asset.id, { locationId: shelf.id });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      event: CustodyEventRecord;
      asset: AssetRecord;
    };
    expect(body.event.locationName).toBe("Storage Shelf");
    expect(body.asset.locationId).toBe(shelf.id);
    expect((await store.getAssetById(asset.id))?.locationId).toBe(shelf.id);
  });
});

describe("custody history", () => {
  it("custody round trip preserves complete history", async () => {
    // Phase 1 gate criterion 3 evidence: a check-out -> check-in round
    // trip (twice, with distinct holders) preserves the full event
    // stream; nothing is overwritten.
    const { app, store, cookie } = await makeAppWithAdmin();
    const holderA = await seedUser(
      store,
      "avery@hatcheck.test",
      "readonly",
      "Avery Alpha",
    );
    const asset = await createAsset(app, cookie, { name: "Traveling Laptop" });

    expect(
      (await checkout(app, cookie, asset.id, { holderUserId: holderA.id }))
        .status,
    ).toBe(201);
    expect((await checkin(app, cookie, asset.id)).status).toBe(201);
    expect(
      (
        await checkout(app, cookie, asset.id, {
          holderLabel: "Visitor Badge 7",
        })
      ).status,
    ).toBe(201);
    expect((await checkin(app, cookie, asset.id)).status).toBe(201);

    const res = await app.request(`/api/v1/assets/${asset.id}/custody`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: CustodyEventRecord[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.total).toBe(4);
    expect(body.items).toHaveLength(4);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);

    // Newest-first: in, out(label), in, out(user A).
    expect(body.items.map((e) => e.type)).toEqual([
      "check_in",
      "check_out",
      "check_in",
      "check_out",
    ]);
    const secondOut = body.items[1];
    const firstOut = body.items[3];
    if (secondOut === undefined || firstOut === undefined) {
      throw new Error("expected four custody events");
    }
    expect(firstOut.holderUserId).toBe(holderA.id);
    expect(firstOut.holderName).toBe("Avery Alpha");
    expect(secondOut.holderUserId).toBeNull();
    expect(secondOut.holderName).toBe("Visitor Badge 7");

    // Correct ordering: at is non-increasing and ids (time-ordered)
    // strictly decrease newest-first.
    for (let i = 1; i < body.items.length; i++) {
      const newer = body.items[i - 1];
      const older = body.items[i];
      if (newer === undefined || older === undefined) throw new Error("gap");
      expect(newer.at).toBeGreaterThanOrEqual(older.at);
      expect(newer.id > older.id).toBe(true);
    }

    // Asset ends in_stock and nothing was overwritten.
    expect((await store.getAssetById(asset.id))?.status).toBe("in_stock");
    expect(await store.countCustodyEvents(asset.id)).toBe(4);
  });

  it("404s for an unknown asset and paginates history", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const missing = await app.request(
      `/api/v1/assets/${crypto.randomUUID()}/custody`,
      { headers: { cookie } },
    );
    expect(missing.status).toBe(404);

    const asset = await createAsset(app, cookie, { name: "Busy Laptop" });
    for (let i = 0; i < 3; i++) {
      await checkout(app, cookie, asset.id, { holderLabel: `Holder ${i}` });
      await checkin(app, cookie, asset.id);
    }
    const page = await app.request(
      `/api/v1/assets/${asset.id}/custody?limit=2&offset=1`,
      { headers: { cookie } },
    );
    expect(page.status).toBe(200);
    const body = (await page.json()) as {
      items: CustodyEventRecord[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.total).toBe(6);
    expect(body.items).toHaveLength(2);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
    expect(body.items.map((e) => e.type)).toEqual(["check_out", "check_in"]);
  });
});

describe("heldByUserId asset filter", () => {
  it("matches while held and is empty after checkin", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const holder = await seedUser(
      store,
      "holder@hatcheck.test",
      "readonly",
      "Harper Holder",
    );
    const held = await createAsset(app, cookie, { name: "Held Laptop" });
    await createAsset(app, cookie, { name: "Idle Laptop" });
    expect(
      (await checkout(app, cookie, held.id, { holderUserId: holder.id }))
        .status,
    ).toBe(201);

    const whileHeld = await app.request(
      `/api/v1/assets?heldByUserId=${holder.id}`,
      { headers: { cookie } },
    );
    expect(whileHeld.status).toBe(200);
    const heldBody = (await whileHeld.json()) as {
      items: AssetRecord[];
      total: number;
    };
    expect(heldBody.items.map((a) => a.id)).toEqual([held.id]);
    expect(heldBody.total).toBe(1);

    expect((await checkin(app, cookie, held.id)).status).toBe(201);
    const afterIn = await app.request(
      `/api/v1/assets?heldByUserId=${holder.id}`,
      { headers: { cookie } },
    );
    const afterBody = (await afterIn.json()) as {
      items: AssetRecord[];
      total: number;
    };
    expect(afterBody.items).toEqual([]);
    expect(afterBody.total).toBe(0);
  });
});

describe("users/options", () => {
  it("returns only active users in a minimal shape", async () => {
    const { app, store, cookie, admin } = await makeAppWithAdmin();
    const active = await seedUser(
      store,
      "tech@hatcheck.test",
      "technician",
      "Taylor Tech",
    );
    const inactive = await seedUser(
      store,
      "former@hatcheck.test",
      "readonly",
      "Former Person",
    );
    await store.updateUser(inactive.id, { isActive: false });

    const res = await app.request("/api/v1/users/options", {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as {
      items: { id: string; displayName: string; email: string }[];
    };
    expect(new Set(body.items.map((u) => u.id))).toEqual(
      new Set([admin.id, active.id]),
    );
    const tech = body.items.find((u) => u.id === active.id);
    expect(tech).toEqual({
      id: active.id,
      displayName: "Taylor Tech",
      email: "tech@hatcheck.test",
    });
    // No sensitive keys anywhere in the JSON.
    expect(raw).not.toContain("passwordHash");
    expect(raw).not.toContain("oidcSubject");
  });
});

describe("custody audit", () => {
  it("writes custody.check_out and custody.check_in records with actor, time, and before/after", async () => {
    const { app, store, cookie, admin } = await makeAppWithAdmin();
    const room = await createLocation(app, cookie, { name: "Room 101" });
    const asset = await createAsset(app, cookie, { name: "Audited Laptop" });

    const beforeOut = Date.now();
    const outRes = await checkout(app, cookie, asset.id, {
      holderLabel: "Visitor Badge 7",
      locationId: room.id,
      note: "loaner",
    });
    const afterOut = Date.now();
    expect(outRes.status).toBe(201);
    const outBody = (await outRes.json()) as { event: CustodyEventRecord };

    const outAudit = await findAudit(store, "custody.check_out");
    expect(outAudit.actorUserId).toBe(admin.id);
    expect(outAudit.actorEmail).toBe("admin@hatcheck.test");
    expect(outAudit.entityType).toBe("asset");
    expect(outAudit.entityId).toBe(asset.id);
    expect(outAudit.at).toBeGreaterThanOrEqual(beforeOut);
    expect(outAudit.at).toBeLessThanOrEqual(afterOut);
    const outDetails = JSON.parse(outAudit.details ?? "{}");
    expect(outDetails.eventId).toBe(outBody.event.id);
    expect(outDetails.holder).toEqual({
      userId: null,
      name: "Visitor Badge 7",
    });
    expect(outDetails.note).toBe("loaner");
    expect(outDetails.before).toEqual({ status: "in_stock", locationId: null });
    expect(outDetails.after).toEqual({
      status: "deployed",
      locationId: room.id,
    });

    const beforeIn = Date.now();
    const inRes = await checkin(app, cookie, asset.id, { note: "back" });
    const afterIn = Date.now();
    expect(inRes.status).toBe(201);
    const inBody = (await inRes.json()) as { event: CustodyEventRecord };

    const inAudit = await findAudit(store, "custody.check_in");
    expect(inAudit.actorUserId).toBe(admin.id);
    expect(inAudit.actorEmail).toBe("admin@hatcheck.test");
    expect(inAudit.entityId).toBe(asset.id);
    expect(inAudit.at).toBeGreaterThanOrEqual(beforeIn);
    expect(inAudit.at).toBeLessThanOrEqual(afterIn);
    const inDetails = JSON.parse(inAudit.details ?? "{}");
    expect(inDetails.eventId).toBe(inBody.event.id);
    expect(inDetails.note).toBe("back");
    expect(inDetails.before).toEqual({
      status: "deployed",
      locationId: room.id,
    });
    expect(inDetails.after).toEqual({
      status: "in_stock",
      locationId: room.id,
    });
  });

  it("failed custody operations write no audit rows", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const asset = await createAsset(app, cookie, { name: "Spare Laptop" });

    // 400s: holder matrix, unknown holder, unknown location.
    await checkout(app, cookie, asset.id, {});
    await checkout(app, cookie, asset.id, {
      holderUserId: crypto.randomUUID(),
    });
    await checkout(app, cookie, asset.id, {
      holderLabel: "Visitor",
      locationId: crypto.randomUUID(),
    });
    // 409: checkin while idle.
    await checkin(app, cookie, asset.id);
    // 404: unknown asset.
    await checkout(app, cookie, crypto.randomUUID(), { holderLabel: "X" });

    expect(await countAuditFor(store, "custody.check_out")).toBe(0);
    expect(await countAuditFor(store, "custody.check_in")).toBe(0);

    // 409: double check-out after one success — exactly one audit row.
    await checkout(app, cookie, asset.id, { holderLabel: "First" });
    await checkout(app, cookie, asset.id, { holderLabel: "Second" });
    expect(await countAuditFor(store, "custody.check_out")).toBe(1);
  });
});

describe("custody OpenAPI", () => {
  it("documents the new custody and users/options paths", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(doc.paths["/api/v1/assets/{id}/checkout"]).toBeDefined();
    expect(doc.paths["/api/v1/assets/{id}/checkin"]).toBeDefined();
    expect(doc.paths["/api/v1/assets/{id}/custody"]).toBeDefined();
    expect(doc.paths["/api/v1/users/options"]).toBeDefined();
    // The heldByUserId filter is documented on the asset list.
    const list = JSON.stringify(doc.paths["/api/v1/assets"]);
    expect(list).toContain("heldByUserId");
  });
});
