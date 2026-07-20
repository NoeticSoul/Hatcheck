// Exceptions API tests: RBAC, list/filter/pagination, the review workflow
// (resolve/dismiss with finality), and audit records. Exceptions are
// raised through real import collisions so the tests exercise the same
// path production does. Synthetic data only: *.test emails and invented
// names. The test password is a fixture, not a secret.
import { hash } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { createSqliteStore } from "../db/store.sqlite";
import type {
  ExceptionRecord,
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

/**
 * Raises a real import-collision exception: creates an asset that owns a
 * serial, then imports a row using that serial with a different tag.
 */
async function raiseException(
  app: ReturnType<typeof createApp>,
  cookie: string,
  serial: string,
): Promise<ExceptionRecord> {
  const assetRes = await jsonRequest(app, "/api/v1/assets", "POST", cookie, {
    name: `Owner of ${serial}`,
    serialNumber: serial,
    assetTag: `HT-${serial}`,
  });
  if (assetRes.status !== 201) {
    throw new Error(`asset create failed: ${assetRes.status}`);
  }
  const importRes = await app.request("/api/v1/imports/assets?mode=commit", {
    method: "POST",
    headers: { "content-type": "text/csv", cookie },
    body: `name,serial_number,asset_tag\nIncoming,${serial},HT-OTHER-${serial}\n`,
  });
  if (importRes.status !== 200) {
    throw new Error(`import failed: ${importRes.status}`);
  }
  const body = (await importRes.json()) as {
    rows: { id: string; outcome: string }[];
  };
  if (body.rows[0]?.outcome !== "collision") {
    throw new Error(`expected collision, got ${body.rows[0]?.outcome}`);
  }
  const listRes = await jsonRequest(
    app,
    "/api/v1/exceptions?status=open&limit=200",
    "GET",
    cookie,
  );
  const list = (await listRes.json()) as { items: ExceptionRecord[] };
  const exception = list.items.find(
    (e) => e.importRowId === body.rows[0]?.id,
  );
  if (exception === undefined) throw new Error("exception not found");
  return exception;
}

describe("exceptions RBAC", () => {
  it("requires authentication", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/v1/exceptions");
    expect(res.status).toBe(401);
  });

  it("rejects readonly users from viewing and resolving", async () => {
    const { app, store } = await makeAppWithAdmin();
    await seedUser(store, "viewer@hatcheck.test", "readonly");
    const viewer = await loginAs(app, "viewer@hatcheck.test");
    const list = await jsonRequest(app, "/api/v1/exceptions", "GET", viewer);
    expect(list.status).toBe(403);
    const resolve = await jsonRequest(
      app,
      "/api/v1/exceptions/any-id/resolve",
      "POST",
      viewer,
      { status: "resolved" },
    );
    expect(resolve.status).toBe(403);
  });
});

describe("exception views", () => {
  it("lists newest first, filters by status, and paginates consistently", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const first = await raiseException(app, cookie, "SN-E1");
    const second = await raiseException(app, cookie, "SN-E2");
    const third = await raiseException(app, cookie, "SN-E3");

    const resolveRes = await jsonRequest(
      app,
      `/api/v1/exceptions/${second.id}/resolve`,
      "POST",
      cookie,
      { status: "dismissed" },
    );
    expect(resolveRes.status).toBe(200);

    const allRes = await jsonRequest(
      app,
      "/api/v1/exceptions?limit=2",
      "GET",
      cookie,
    );
    const all = (await allRes.json()) as {
      items: ExceptionRecord[];
      total: number;
    };
    expect(all.total).toBe(3);
    expect(all.items).toHaveLength(2);
    expect(all.items[0]?.id).toBe(third.id);

    const openRes = await jsonRequest(
      app,
      "/api/v1/exceptions?status=open",
      "GET",
      cookie,
    );
    const open = (await openRes.json()) as {
      items: ExceptionRecord[];
      total: number;
    };
    expect(open.total).toBe(2);
    expect(new Set(open.items.map((e) => e.id))).toEqual(
      new Set([first.id, third.id]),
    );

    const dismissedRes = await jsonRequest(
      app,
      "/api/v1/exceptions?status=dismissed",
      "GET",
      cookie,
    );
    const dismissed = (await dismissedRes.json()) as {
      items: ExceptionRecord[];
      total: number;
    };
    expect(dismissed.total).toBe(1);
    expect(dismissed.items[0]?.id).toBe(second.id);
  });

  it("serves a single exception and 404s for a missing id", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const raised = await raiseException(app, cookie, "SN-E4");
    const res = await jsonRequest(
      app,
      `/api/v1/exceptions/${raised.id}`,
      "GET",
      cookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exception: ExceptionRecord };
    expect(body.exception.id).toBe(raised.id);
    expect(body.exception.status).toBe("open");

    const missing = await jsonRequest(
      app,
      "/api/v1/exceptions/missing-id",
      "GET",
      cookie,
    );
    expect(missing.status).toBe(404);
  });
});

describe("exception review workflow", () => {
  it("resolves an open exception with actor, note, and audit trail", async () => {
    const { app, store, admin, cookie } = await makeAppWithAdmin();
    const raised = await raiseException(app, cookie, "SN-E5");

    const res = await jsonRequest(
      app,
      `/api/v1/exceptions/${raised.id}/resolve`,
      "POST",
      cookie,
      { status: "resolved", note: "  merged by hand after review  " },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exception: ExceptionRecord };
    expect(body.exception.status).toBe("resolved");
    expect(body.exception.resolvedByUserId).toBe(admin.id);
    expect(body.exception.resolvedAt).toBeGreaterThan(0);
    expect(body.exception.resolutionNote).toBe("merged by hand after review");

    const audit = await store.listAudit({
      limit: 10,
      action: "exception.resolve",
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.entityId).toBe(raised.id);
    expect(audit[0]?.actorUserId).toBe(admin.id);
    const details = JSON.parse(audit[0]?.details ?? "{}") as {
      before: { status: string };
      after: { status: string; resolutionNote: string };
    };
    expect(details.before.status).toBe("open");
    expect(details.after.status).toBe("resolved");
    expect(details.after.resolutionNote).toBe("merged by hand after review");
  });

  it("dismisses without a note, storing null", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const raised = await raiseException(app, cookie, "SN-E6");
    const res = await jsonRequest(
      app,
      `/api/v1/exceptions/${raised.id}/resolve`,
      "POST",
      cookie,
      { status: "dismissed" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exception: ExceptionRecord };
    expect(body.exception.status).toBe("dismissed");
    expect(body.exception.resolutionNote).toBeNull();
  });

  it("treats decisions as final: a closed exception cannot be re-decided", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const raised = await raiseException(app, cookie, "SN-E7");
    const first = await jsonRequest(
      app,
      `/api/v1/exceptions/${raised.id}/resolve`,
      "POST",
      cookie,
      { status: "resolved" },
    );
    expect(first.status).toBe(200);
    const second = await jsonRequest(
      app,
      `/api/v1/exceptions/${raised.id}/resolve`,
      "POST",
      cookie,
      { status: "dismissed" },
    );
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_open");
  });

  it("404s when resolving a missing exception and 400s on a bad status", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const missing = await jsonRequest(
      app,
      "/api/v1/exceptions/missing-id/resolve",
      "POST",
      cookie,
      { status: "resolved" },
    );
    expect(missing.status).toBe(404);

    const raised = await raiseException(app, cookie, "SN-E8");
    const bad = await jsonRequest(
      app,
      `/api/v1/exceptions/${raised.id}/resolve`,
      "POST",
      cookie,
      { status: "reopened" },
    );
    expect(bad.status).toBe(400);
  });
});
