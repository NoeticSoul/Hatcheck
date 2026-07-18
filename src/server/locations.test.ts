// Locations API tests: RBAC, rank-based hierarchy, sibling-name
// uniqueness, delete pre-checks, list filters, and audit records.
// Synthetic data only; the test password is a fixture, not a secret.
import { hash } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { createSqliteStore } from "../db/store.sqlite";
import type { LocationRecord, Role, Store } from "../db/store";
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

/** Creates a location through the API, failing loudly on any error. */
async function createLoc(
  app: ReturnType<typeof createApp>,
  cookie: string,
  body: Record<string, unknown>,
): Promise<LocationRecord> {
  const res = await jsonRequest(app, "/api/v1/locations", "POST", cookie, body);
  if (res.status !== 201) {
    throw new Error(
      `create location failed: ${res.status} ${await res.text()}`,
    );
  }
  const data = await res.json();
  return data.location as LocationRecord;
}

describe("locations RBAC", () => {
  it("401s on every endpoint when unauthenticated", async () => {
    const { app } = await makeApp();
    const id = crypto.randomUUID();
    const attempts = [
      app.request("/api/v1/locations"),
      app.request(`/api/v1/locations/${id}`),
      jsonRequest(app, "/api/v1/locations", "POST", null, { name: "Lab" }),
      jsonRequest(app, `/api/v1/locations/${id}`, "PATCH", null, { name: "L" }),
      jsonRequest(app, `/api/v1/locations/${id}`, "DELETE", null),
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
    const loc = await createLoc(app, cookie, { name: "Ops Closet" });
    await seedUser(store, "ro@hatcheck.test", "readonly");
    const ro = await loginAs(app, "ro@hatcheck.test");

    const list = await app.request("/api/v1/locations", {
      headers: { cookie: ro },
    });
    expect(list.status).toBe(200);

    const detail = await app.request(`/api/v1/locations/${loc.id}`, {
      headers: { cookie: ro },
    });
    expect(detail.status).toBe(200);

    const post = await jsonRequest(app, "/api/v1/locations", "POST", ro, {
      name: "Nope",
    });
    expect(post.status).toBe(403);

    const patch = await jsonRequest(
      app,
      `/api/v1/locations/${loc.id}`,
      "PATCH",
      ro,
      { name: "Nope" },
    );
    expect(patch.status).toBe(403);

    const del = await jsonRequest(
      app,
      `/api/v1/locations/${loc.id}`,
      "DELETE",
      ro,
    );
    expect(del.status).toBe(403);
  });

  it("technician can POST and PATCH but not DELETE", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "tech@hatcheck.test", "technician");
    const tech = await loginAs(app, "tech@hatcheck.test");

    const post = await jsonRequest(app, "/api/v1/locations", "POST", tech, {
      name: "Bench Area",
    });
    expect(post.status).toBe(201);
    const { location } = await post.json();

    const patch = await jsonRequest(
      app,
      `/api/v1/locations/${location.id}`,
      "PATCH",
      tech,
      { description: "Repair bench" },
    );
    expect(patch.status).toBe(200);

    const del = await jsonRequest(
      app,
      `/api/v1/locations/${location.id}`,
      "DELETE",
      tech,
    );
    expect(del.status).toBe(403);
  });

  it("admin can DELETE", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const loc = await createLoc(app, cookie, { name: "Doomed Room" });
    const del = await jsonRequest(
      app,
      `/api/v1/locations/${loc.id}`,
      "DELETE",
      cookie,
    );
    expect(del.status).toBe(204);
  });
});

describe("locations CRUD", () => {
  it("applies defaults and trims the name on create", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const loc = await createLoc(app, cookie, { name: "  Server Room  " });
    expect(loc.name).toBe("Server Room");
    expect(loc.kind).toBe("room");
    expect(loc.parentId).toBeNull();
    expect(loc.description).toBeNull();
    expect(loc.isActive).toBe(true);

    const detail = await app.request(`/api/v1/locations/${loc.id}`, {
      headers: { cookie },
    });
    expect(detail.status).toBe(200);
    const body = await detail.json();
    expect(body.location.id).toBe(loc.id);
    expect(body.location.name).toBe("Server Room");
  });

  it("honors explicit values on create", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const site = await createLoc(app, cookie, {
      name: "North Campus",
      kind: "site",
    });
    const loc = await createLoc(app, cookie, {
      name: "Annex",
      kind: "building",
      parentId: site.id,
      description: "Overflow storage",
      isActive: false,
    });
    expect(loc.kind).toBe("building");
    expect(loc.parentId).toBe(site.id);
    expect(loc.description).toBe("Overflow storage");
    expect(loc.isActive).toBe(false);
  });

  it("rejects a whitespace-only name with 400", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const res = await jsonRequest(app, "/api/v1/locations", "POST", cookie, {
      name: "   ",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation_error");
  });

  it("PATCH updates fields and trims the new name", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const loc = await createLoc(app, cookie, { name: "Old Name" });
    const res = await jsonRequest(
      app,
      `/api/v1/locations/${loc.id}`,
      "PATCH",
      cookie,
      { name: " New Name ", description: "Renamed", isActive: false },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.location.name).toBe("New Name");
    expect(body.location.description).toBe("Renamed");
    expect(body.location.isActive).toBe(false);
  });

  it("404s on unknown ids for GET, PATCH, and DELETE", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const id = crypto.randomUUID();
    const get = await app.request(`/api/v1/locations/${id}`, {
      headers: { cookie },
    });
    expect(get.status).toBe(404);
    const patch = await jsonRequest(
      app,
      `/api/v1/locations/${id}`,
      "PATCH",
      cookie,
      { name: "Ghost" },
    );
    expect(patch.status).toBe(404);
    const del = await jsonRequest(
      app,
      `/api/v1/locations/${id}`,
      "DELETE",
      cookie,
    );
    expect(del.status).toBe(404);
  });
});

describe("locations hierarchy", () => {
  it("builds a site -> building -> room chain", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const site = await createLoc(app, cookie, { name: "Main Site", kind: "site" });
    const building = await createLoc(app, cookie, {
      name: "Building A",
      kind: "building",
      parentId: site.id,
    });
    const room = await createLoc(app, cookie, {
      name: "Room 101",
      kind: "room",
      parentId: building.id,
    });
    expect(building.parentId).toBe(site.id);
    expect(room.parentId).toBe(building.id);
  });

  it("allows a room directly under a site", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const site = await createLoc(app, cookie, { name: "Tiny Site", kind: "site" });
    const room = await createLoc(app, cookie, {
      name: "The Only Room",
      kind: "room",
      parentId: site.id,
    });
    expect(room.parentId).toBe(site.id);
  });

  it("rejects a building under a building with 400 invalid_parent", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const b1 = await createLoc(app, cookie, { name: "Depot", kind: "building" });
    const res = await jsonRequest(app, "/api/v1/locations", "POST", cookie, {
      name: "Sub Depot",
      kind: "building",
      parentId: b1.id,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_parent");
  });

  it("rejects a site under anything", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const site = await createLoc(app, cookie, { name: "HQ", kind: "site" });
    const building = await createLoc(app, cookie, {
      name: "Wing B",
      kind: "building",
      parentId: site.id,
    });
    for (const parentId of [site.id, building.id]) {
      const res = await jsonRequest(app, "/api/v1/locations", "POST", cookie, {
        name: "Nested Site",
        kind: "site",
        parentId,
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_parent");
    }
  });

  it("rejects an unknown parent with 400 invalid_parent", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const res = await jsonRequest(app, "/api/v1/locations", "POST", cookie, {
      name: "Orphan",
      parentId: crypto.randomUUID(),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_parent");
  });

  it("rejects parent = self on PATCH with 400 invalid_parent", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const loc = await createLoc(app, cookie, { name: "Loop Room" });
    const res = await jsonRequest(
      app,
      `/api/v1/locations/${loc.id}`,
      "PATCH",
      cookie,
      { parentId: loc.id },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_parent");
  });

  it("rejects a kind change that conflicts with children", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const site = await createLoc(app, cookie, { name: "Campus", kind: "site" });
    await createLoc(app, cookie, {
      name: "Hall C",
      kind: "building",
      parentId: site.id,
    });
    // site -> building would give the child building a parent of equal rank.
    const res = await jsonRequest(
      app,
      `/api/v1/locations/${site.id}`,
      "PATCH",
      cookie,
      { kind: "building" },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("kind_conflicts_with_children");
  });

  it("allows a kind change when no child conflicts", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const building = await createLoc(app, cookie, {
      name: "Shed",
      kind: "building",
    });
    const res = await jsonRequest(
      app,
      `/api/v1/locations/${building.id}`,
      "PATCH",
      cookie,
      { kind: "room" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.location.kind).toBe("room");
  });

  it("rejects reparenting under an equal-rank location", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const b1 = await createLoc(app, cookie, { name: "East Block", kind: "building" });
    const b2 = await createLoc(app, cookie, { name: "West Block", kind: "building" });
    const res = await jsonRequest(
      app,
      `/api/v1/locations/${b2.id}`,
      "PATCH",
      cookie,
      { parentId: b1.id },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_parent");
  });
});

describe("location names", () => {
  it("rejects a duplicate sibling name under the same parent with 409", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const site = await createLoc(app, cookie, { name: "Twin Site", kind: "site" });
    await createLoc(app, cookie, { name: "Room X", parentId: site.id });
    const res = await jsonRequest(app, "/api/v1/locations", "POST", cookie, {
      name: "Room X",
      parentId: site.id,
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("name_in_use");
  });

  it("allows the same name under different parents", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const s1 = await createLoc(app, cookie, { name: "Site One", kind: "site" });
    const s2 = await createLoc(app, cookie, { name: "Site Two", kind: "site" });
    const r1 = await createLoc(app, cookie, { name: "Storage", parentId: s1.id });
    const r2 = await createLoc(app, cookie, { name: "Storage", parentId: s2.id });
    expect(r1.name).toBe(r2.name);
    expect(r1.id).not.toBe(r2.id);
  });

  it("rejects a duplicate ROOT name with 409 (service pre-check)", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    await createLoc(app, cookie, { name: "Lonely Closet" });
    const res = await jsonRequest(app, "/api/v1/locations", "POST", cookie, {
      name: "Lonely Closet",
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("name_in_use");
  });

  it("rejects renaming to a taken sibling name with 409", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const site = await createLoc(app, cookie, { name: "Rename Site", kind: "site" });
    await createLoc(app, cookie, { name: "Room A", parentId: site.id });
    const roomB = await createLoc(app, cookie, { name: "Room B", parentId: site.id });
    const res = await jsonRequest(
      app,
      `/api/v1/locations/${roomB.id}`,
      "PATCH",
      cookie,
      { name: "Room A" },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("name_in_use");
  });

  it("rejects renaming to a taken ROOT name with 409", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    await createLoc(app, cookie, { name: "Front Desk" });
    const other = await createLoc(app, cookie, { name: "Back Desk" });
    const res = await jsonRequest(
      app,
      `/api/v1/locations/${other.id}`,
      "PATCH",
      cookie,
      { name: "Front Desk" },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("name_in_use");
  });

  it("allows a rename to the location's own current name", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const loc = await createLoc(app, cookie, { name: "Same Name" });
    const res = await jsonRequest(
      app,
      `/api/v1/locations/${loc.id}`,
      "PATCH",
      cookie,
      { name: "Same Name" },
    );
    expect(res.status).toBe(200);
  });

  it("moving to root checks root-name uniqueness", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    await createLoc(app, cookie, { name: "Shared Label" });
    const site = await createLoc(app, cookie, { name: "Move Site", kind: "site" });
    const nested = await createLoc(app, cookie, {
      name: "Shared Label",
      parentId: site.id,
    });
    const res = await jsonRequest(
      app,
      `/api/v1/locations/${nested.id}`,
      "PATCH",
      cookie,
      { parentId: null },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("name_in_use");
  });
});

describe("location delete", () => {
  it("409s when the location still has children", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const site = await createLoc(app, cookie, { name: "Parent Site", kind: "site" });
    await createLoc(app, cookie, { name: "Child Room", parentId: site.id });
    const res = await jsonRequest(
      app,
      `/api/v1/locations/${site.id}`,
      "DELETE",
      cookie,
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("location_in_use");
  });

  it("409s when an asset still references the location", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const loc = await createLoc(app, cookie, { name: "Asset Room" });
    await store.createAssetWithInterfaces(
      { name: "Test Laptop", locationId: loc.id },
      [],
    );
    const res = await jsonRequest(
      app,
      `/api/v1/locations/${loc.id}`,
      "DELETE",
      cookie,
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("location_in_use");
  });

  it("cleanly deletes an unreferenced location: 204 then 404", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const loc = await createLoc(app, cookie, { name: "Ephemeral Room" });
    const del = await jsonRequest(
      app,
      `/api/v1/locations/${loc.id}`,
      "DELETE",
      cookie,
    );
    expect(del.status).toBe(204);
    const get = await app.request(`/api/v1/locations/${loc.id}`, {
      headers: { cookie },
    });
    expect(get.status).toBe(404);
  });
});

describe("location list", () => {
  async function seedTree() {
    const ctx = await makeAppWithAdmin();
    const { app, cookie } = ctx;
    const site = await createLoc(app, cookie, { name: "Alpha Site", kind: "site" });
    const building = await createLoc(app, cookie, {
      name: "Bravo Building",
      kind: "building",
      parentId: site.id,
    });
    const room1 = await createLoc(app, cookie, {
      name: "Room 101",
      parentId: building.id,
    });
    const room2 = await createLoc(app, cookie, {
      name: "Room 102",
      parentId: building.id,
    });
    const closet = await createLoc(app, cookie, { name: "Closet" });
    const inactive = await createLoc(app, cookie, {
      name: "Zulu Depot",
      kind: "site",
      isActive: false,
    });
    return { ...ctx, site, building, room1, room2, closet, inactive };
  }

  it("filters by parentId", async () => {
    const { app, cookie, building, room1, room2 } = await seedTree();
    const res = await app.request(
      `/api/v1/locations?parentId=${building.id}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.items.map((l: LocationRecord) => l.id).sort();
    expect(ids).toEqual([room1.id, room2.id].sort());
    expect(body.total).toBe(2);
  });

  it("rootsOnly returns only parentless locations", async () => {
    const { app, cookie, site, closet } = await seedTree();
    const res = await app.request("/api/v1/locations?rootsOnly=true", {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.items.map((l: LocationRecord) => l.id).sort();
    // The inactive Zulu Depot root is excluded by default.
    expect(ids).toEqual([site.id, closet.id].sort());
  });

  it("400s when parentId and rootsOnly are combined", async () => {
    const { app, cookie, building } = await seedTree();
    const res = await app.request(
      `/api/v1/locations?rootsOnly=true&parentId=${building.id}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation_error");
  });

  it("filters by kind", async () => {
    const { app, cookie, building } = await seedTree();
    const res = await app.request("/api/v1/locations?kind=building", {
      headers: { cookie },
    });
    const body = await res.json();
    expect(body.items.map((l: LocationRecord) => l.id)).toEqual([building.id]);
    expect(body.total).toBe(1);
  });

  it("q matches a case-insensitive substring", async () => {
    const { app, cookie, room1, room2 } = await seedTree();
    const res = await app.request("/api/v1/locations?q=room", {
      headers: { cookie },
    });
    const body = await res.json();
    const ids = body.items.map((l: LocationRecord) => l.id).sort();
    expect(ids).toEqual([room1.id, room2.id].sort());
  });

  it("includeInactive toggles inactive rows", async () => {
    const { app, cookie, inactive } = await seedTree();
    const without = await app.request("/api/v1/locations", {
      headers: { cookie },
    });
    const withoutBody = await without.json();
    const withoutIds = withoutBody.items.map((l: LocationRecord) => l.id);
    expect(withoutIds).not.toContain(inactive.id);
    expect(withoutBody.total).toBe(5);

    const withRes = await app.request(
      "/api/v1/locations?includeInactive=true",
      { headers: { cookie } },
    );
    const withBody = await withRes.json();
    const withIds = withBody.items.map((l: LocationRecord) => l.id);
    expect(withIds).toContain(inactive.id);
    expect(withBody.total).toBe(6);
  });

  it("paginates with disjoint pages and a consistent total", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const names = ["Page A", "Page B", "Page C", "Page D", "Page E"];
    const created: string[] = [];
    for (const name of names) {
      const loc = await createLoc(app, cookie, { name });
      created.push(loc.id);
    }
    const seen: string[] = [];
    for (const offset of [0, 2, 4]) {
      const res = await app.request(
        `/api/v1/locations?q=page&limit=2&offset=${offset}`,
        { headers: { cookie } },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(5);
      expect(body.limit).toBe(2);
      expect(body.offset).toBe(offset);
      for (const item of body.items as LocationRecord[]) {
        expect(seen).not.toContain(item.id);
        seen.push(item.id);
      }
    }
    expect(seen.sort()).toEqual(created.sort());
  });

  it("caps limit at 200 and rejects bad values", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const tooBig = await app.request("/api/v1/locations?limit=201", {
      headers: { cookie },
    });
    expect(tooBig.status).toBe(400);
    const zero = await app.request("/api/v1/locations?limit=0", {
      headers: { cookie },
    });
    expect(zero.status).toBe(400);
  });
});

// Phase gate assertion: every location mutation writes an audit entry with
// actor, timestamp, and before/after state.
describe("location audit records", () => {
  it("location.create records actor, timestamp, and the created state", async () => {
    const { app, store, admin, cookie } = await makeAppWithAdmin();
    const t0 = Date.now();
    const loc = await createLoc(app, cookie, {
      name: "Audit Room",
      description: "Traceable",
    });

    const [entry] = await store.listAudit({
      limit: 1,
      action: "location.create",
    });
    if (entry === undefined) throw new Error("no location.create audit entry");
    expect(entry.actorUserId).toBe(admin.id);
    expect(entry.actorEmail).toBe("admin@hatcheck.test");
    expect(entry.at).toBeGreaterThanOrEqual(t0);
    expect(entry.at).toBeLessThanOrEqual(Date.now());
    expect(entry.entityType).toBe("location");
    expect(entry.entityId).toBe(loc.id);
    const details = JSON.parse(entry.details ?? "null");
    expect(details.before).toBeNull();
    expect(details.after).toEqual({
      name: "Audit Room",
      kind: "room",
      parentId: null,
      description: "Traceable",
      isActive: true,
    });
  });

  it("location.update records fields and before/after snapshots", async () => {
    const { app, store, admin, cookie } = await makeAppWithAdmin();
    const loc = await createLoc(app, cookie, { name: "Before Room" });
    const t0 = Date.now();

    const res = await jsonRequest(
      app,
      `/api/v1/locations/${loc.id}`,
      "PATCH",
      cookie,
      { name: "After Room", isActive: false },
    );
    expect(res.status).toBe(200);

    const [entry] = await store.listAudit({
      limit: 1,
      action: "location.update",
    });
    if (entry === undefined) throw new Error("no location.update audit entry");
    expect(entry.actorUserId).toBe(admin.id);
    expect(entry.actorEmail).toBe("admin@hatcheck.test");
    expect(entry.at).toBeGreaterThanOrEqual(t0);
    expect(entry.at).toBeLessThanOrEqual(Date.now());
    expect(entry.entityType).toBe("location");
    expect(entry.entityId).toBe(loc.id);
    const details = JSON.parse(entry.details ?? "null");
    expect(details.fields.sort()).toEqual(["isActive", "name"]);
    expect(details.before.name).toBe("Before Room");
    expect(details.before.isActive).toBe(true);
    expect(details.after.name).toBe("After Room");
    expect(details.after.isActive).toBe(false);
  });

  it("location.delete records the final state with a null after", async () => {
    const { app, store, admin, cookie } = await makeAppWithAdmin();
    const loc = await createLoc(app, cookie, { name: "Last Room" });
    const t0 = Date.now();

    const res = await jsonRequest(
      app,
      `/api/v1/locations/${loc.id}`,
      "DELETE",
      cookie,
    );
    expect(res.status).toBe(204);

    const [entry] = await store.listAudit({
      limit: 1,
      action: "location.delete",
    });
    if (entry === undefined) throw new Error("no location.delete audit entry");
    expect(entry.actorUserId).toBe(admin.id);
    expect(entry.actorEmail).toBe("admin@hatcheck.test");
    expect(entry.at).toBeGreaterThanOrEqual(t0);
    expect(entry.at).toBeLessThanOrEqual(Date.now());
    expect(entry.entityType).toBe("location");
    expect(entry.entityId).toBe(loc.id);
    const details = JSON.parse(entry.details ?? "null");
    expect(details.after).toBeNull();
    expect(details.before).toEqual({
      name: "Last Room",
      kind: "room",
      parentId: null,
      description: null,
      isActive: true,
    });
  });

  it("rejected mutations write no audit entry", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    await createLoc(app, cookie, { name: "Only Root" });
    const countBefore = await store.countAudit();
    const res = await jsonRequest(app, "/api/v1/locations", "POST", cookie, {
      name: "Only Root",
    });
    expect(res.status).toBe(409);
    expect(await store.countAudit()).toBe(countBefore);
  });
});

describe("OpenAPI document", () => {
  it("includes all five location operations", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    const doc = await res.json();
    const collection = doc.paths["/api/v1/locations"];
    expect(collection).toBeDefined();
    expect(collection.get).toBeDefined();
    expect(collection.post).toBeDefined();
    const item = doc.paths["/api/v1/locations/{id}"];
    expect(item).toBeDefined();
    expect(item.get).toBeDefined();
    expect(item.patch).toBeDefined();
    expect(item.delete).toBeDefined();
  });
});
