// CSV import API tests: RBAC, CSV/header validation, dry-run preview,
// commit, idempotent re-runs (gate criterion: re-running a file creates no
// duplicates), exception-first collision handling, per-row partial-failure
// reporting, import views, and the 500-row single-run gate test (gate
// criterion 1). Synthetic data only: *.test emails, invented names, and
// locally-administered (x2-prefixed) MAC addresses. The test password is a
// fixture, not a secret.
import { hash } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { createSqliteStore } from "../db/store.sqlite";
import type {
  AssetRecord,
  ExceptionRecord,
  ImportJobRecord,
  ImportRowRecord,
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

function importCsv(
  app: ReturnType<typeof createApp>,
  cookie: string | null,
  csv: string,
  query = "mode=commit",
) {
  const headers: Record<string, string> = { "content-type": "text/csv" };
  if (cookie !== null) headers["cookie"] = cookie;
  return app.request(`/api/v1/imports/assets?${query}`, {
    method: "POST",
    headers,
    body: csv,
  });
}

interface ImportRunBody {
  job: ImportJobRecord;
  rows: ImportRowRecord[];
  priorImport: ImportJobRecord | null;
}

async function runImport(
  app: ReturnType<typeof createApp>,
  cookie: string,
  csv: string,
  query = "mode=commit",
): Promise<ImportRunBody> {
  const res = await importCsv(app, cookie, csv, query);
  if (res.status !== 200) {
    throw new Error(`import failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ImportRunBody;
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

async function listAssetsTotal(
  app: ReturnType<typeof createApp>,
  cookie: string,
): Promise<number> {
  const res = await jsonRequest(app, "/api/v1/assets?limit=1", "GET", cookie);
  if (res.status !== 200) throw new Error(`list assets: ${res.status}`);
  const json = (await res.json()) as { total: number };
  return json.total;
}

function outcomes(body: ImportRunBody): string[] {
  return body.rows.map((r) => r.outcome);
}

describe("import RBAC", () => {
  it("requires authentication", async () => {
    const { app } = await makeApp();
    const res = await importCsv(app, null, "name,serial\nA,SN-1\n");
    expect(res.status).toBe(401);
    const list = await app.request("/api/v1/imports");
    expect(list.status).toBe(401);
  });

  it("rejects readonly users from running and viewing imports", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "viewer@hatcheck.test", "readonly");
    const cookie = await loginAs(app, "viewer@hatcheck.test");
    const run = await importCsv(app, cookie, "name,serial\nA,SN-1\n");
    expect(run.status).toBe(403);
    const list = await jsonRequest(app, "/api/v1/imports", "GET", cookie);
    expect(list.status).toBe(403);
  });

  it("allows technicians to run imports", async () => {
    const { app, store } = await makeApp();
    await seedUser(store, "tech@hatcheck.test", "technician");
    const cookie = await loginAs(app, "tech@hatcheck.test");
    const body = await runImport(app, cookie, "name,serial\nLoaner,SN-T1\n");
    expect(body.job.status).toBe("completed");
    expect(body.job.createdCount).toBe(1);
  });
});

describe("import validation", () => {
  it("requires a valid mode query parameter", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const missing = await importCsv(app, cookie, "name,serial\nA,SN-1\n", "");
    expect(missing.status).toBe(400);
    const bad = await importCsv(
      app,
      cookie,
      "name,serial\nA,SN-1\n",
      "mode=apply",
    );
    expect(bad.status).toBe(400);
  });

  it("rejects an empty body and a header-only file", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const empty = await importCsv(app, cookie, "");
    expect(empty.status).toBe(400);
    const headerOnly = await importCsv(app, cookie, "name,serial\n");
    expect(headerOnly.status).toBe(400);
    const headerOnlyBody = (await headerOnly.json()) as {
      error: { message: string };
    };
    expect(headerOnlyBody.error.message).toContain("no data rows");
  });

  it("rejects unknown, duplicate, and missing-name columns by name", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const unknown = await importCsv(
      app,
      cookie,
      "name,serail_number\nA,SN-1\n",
    );
    expect(unknown.status).toBe(400);
    const unknownBody = (await unknown.json()) as {
      error: { code: string; message: string };
    };
    expect(unknownBody.error.code).toBe("invalid_csv");
    expect(unknownBody.error.message).toContain("serail_number");

    const dup = await importCsv(app, cookie, "name,serial,sn\nA,SN-1,SN-1\n");
    expect(dup.status).toBe(400);
    const dupBody = (await dup.json()) as { error: { message: string } };
    expect(dupBody.error.message).toContain("duplicate column");

    const noName = await importCsv(app, cookie, "serial\nSN-1\n");
    expect(noName.status).toBe(400);
    const noNameBody = (await noName.json()) as { error: { message: string } };
    expect(noNameBody.error.message).toContain("name");
  });

  it("rejects malformed CSV with the parser's message", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const res = await importCsv(app, cookie, 'name\n"unclosed\n');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("unterminated quoted field");
  });

  it("rejects files above the row limit", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const lines = ["name,serial"];
    for (let i = 0; i < 5001; i += 1) lines.push(`Asset ${i},SN-${i}`);
    const res = await importCsv(app, cookie, lines.join("\n"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("too_many_rows");
  });

  it("rejects a CSV body over the size limit with 413", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const big = `name,notes\nA,"${"x".repeat(2 * 1024 * 1024)}"\n`;
    const res = await importCsv(app, cookie, big);
    expect(res.status).toBe(413);
  });

  it("accepts a CSV body above the 256 KiB JSON limit (carve-out works)", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    // ~330 KiB: over the general API body limit, under the CSV cap.
    const note = "n".repeat(1024);
    const lines = ["name,serial,notes"];
    for (let i = 0; i < 320; i += 1) {
      lines.push(`Bulk ${i},SN-BIG-${i},${note}`);
    }
    const csv = lines.join("\n");
    expect(csv.length).toBeGreaterThan(256 * 1024);
    const body = await runImport(app, cookie, csv);
    expect(body.job.createdCount).toBe(320);
  });
});

describe("dry run", () => {
  it("reports per-row results but creates nothing", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const csv =
      "name,serial_number,status\n" +
      "Loaner A,SN-DRY-1,in_stock\n" +
      "Loaner B,SN-DRY-2,deployed\n" +
      "Loaner C,,\n";
    const body = await runImport(app, cookie, csv, "mode=dry_run");

    expect(body.job.mode).toBe("dry_run");
    expect(body.job.status).toBe("completed");
    expect(body.job.totalRows).toBe(3);
    expect(body.job.createdCount).toBe(1);
    expect(body.job.errorCount).toBe(2);
    expect(outcomes(body)).toEqual(["created", "error", "error"]);
    expect(body.rows[0]?.message).toContain("dry run");
    expect(body.rows[1]?.message).toContain("check-out");
    expect(body.rows[2]?.message).toContain("identity field");

    // Nothing was created: no assets, and the per-row report is the only
    // trace besides the job itself.
    expect(await listAssetsTotal(app, cookie)).toBe(0);
    expect(await store.countExceptions()).toBe(0);

    // The preview trail persists and is audited as a dry run.
    const jobRes = await jsonRequest(
      app,
      `/api/v1/imports/${body.job.id}`,
      "GET",
      cookie,
    );
    expect(jobRes.status).toBe(200);
    const audit = await store.listAudit({ limit: 10, action: "import.dry_run" });
    expect(audit).toHaveLength(1);
    expect(await store.listAudit({ limit: 10, action: "asset.create" })).toEqual(
      [],
    );
  });

  it("does not create exception records for collisions", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    await createAsset(app, cookie, {
      name: "Existing",
      serialNumber: "SN-COLL-1",
      assetTag: "HT-0001",
    });
    const body = await runImport(
      app,
      cookie,
      "name,serial_number,asset_tag\nIncoming,SN-COLL-1,HT-9999\n",
      "mode=dry_run",
    );
    expect(outcomes(body)).toEqual(["collision"]);
    expect(body.job.collisionCount).toBe(1);
    expect(await store.countExceptions()).toBe(0);
  });
});

describe("commit", () => {
  it("creates assets with resolved locations, interfaces, and audit records", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const locRes = await jsonRequest(app, "/api/v1/locations", "POST", cookie, {
      name: "North Lab",
      kind: "room",
    });
    expect(locRes.status).toBe(201);
    const { location } = (await locRes.json()) as {
      location: { id: string };
    };

    const csv =
      "name,asset_type,status,location,model,manufacturer,asset_tag,serial_number,system_uuid,mac_addresses\n" +
      'Cart Laptop 01,device,in_stock,North Lab,Fictionbook 13,Example Systems,HT-1001,SN-M5-001,11111111-2222-3333-4444-555555555555,"02:00:5E:AB:CD:01; 02-00-5E-AB-CD-02"\n' +
      "Spare Dock,peripheral,in_repair,,Dockmaster,Example Systems,HT-1002,SN-M5-002,,\n";
    const body = await runImport(app, cookie, csv);

    expect(body.job.status).toBe("completed");
    expect(body.job.createdCount).toBe(2);
    expect(outcomes(body)).toEqual(["created", "created"]);
    expect(body.priorImport).toBeNull();

    const laptopId = body.rows[0]?.assetId;
    expect(laptopId).toBeTruthy();
    const detailRes = await jsonRequest(
      app,
      `/api/v1/assets/${laptopId}`,
      "GET",
      cookie,
    );
    const detail = (await detailRes.json()) as {
      asset: AssetRecord;
      interfaces: { mac: string }[];
    };
    expect(detail.asset.name).toBe("Cart Laptop 01");
    expect(detail.asset.assetType).toBe("device");
    expect(detail.asset.status).toBe("in_stock");
    expect(detail.asset.locationId).toBe(location.id);
    expect(detail.asset.assetTag).toBe("HT-1001");
    expect(detail.asset.serialNumber).toBe("SN-M5-001");
    expect(detail.asset.systemUuid).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    // MACs are canonicalized to lower-case colon form, both separators.
    expect(detail.interfaces.map((i) => i.mac).sort()).toEqual([
      "02:00:5e:ab:cd:01",
      "02:00:5e:ab:cd:02",
    ]);

    // Every created asset has its own audit record, plus the run summary.
    const created = await store.listAudit({ limit: 10, action: "asset.create" });
    expect(created).toHaveLength(2);
    for (const entry of created) {
      const details = JSON.parse(entry.details ?? "{}") as {
        importJobId?: string;
        before: unknown;
        after: { name: string };
      };
      expect(details.importJobId).toBe(body.job.id);
      expect(details.before).toBeNull();
      expect(details.after.name).toBeTruthy();
      expect(entry.actorEmail).toBe("admin@hatcheck.test");
    }
    const summary = await store.listAudit({ limit: 10, action: "import.commit" });
    expect(summary).toHaveLength(1);
    const summaryDetails = JSON.parse(summary[0]?.details ?? "{}") as {
      totalRows: number;
      createdCount: number;
    };
    expect(summaryDetails.totalRows).toBe(2);
    expect(summaryDetails.createdCount).toBe(2);
  });

  it("defaults asset_type to device and status to in_stock", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const body = await runImport(app, cookie, "name,serial\nPlain,SN-D1\n");
    const res = await jsonRequest(
      app,
      `/api/v1/assets/${body.rows[0]?.assetId}`,
      "GET",
      cookie,
    );
    const detail = (await res.json()) as { asset: AssetRecord };
    expect(detail.asset.assetType).toBe("device");
    expect(detail.asset.status).toBe("in_stock");
  });

  it("reports failed rows with reasons and imports the rest", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const csv =
      "name,serial_number,status,location,mac_addresses\n" +
      "Good One,SN-P1,in_stock,,\n" +
      ",SN-P2,,,\n" +
      "Bad Status,SN-P3,deployed,,\n" +
      "Bad Location,SN-P4,,Atlantis Annex,\n" +
      "Bad Mac,SN-P5,,,not-a-mac\n" +
      "No Identity,,,,\n" +
      "Dup Serial,SN-P1,,,\n" +
      "Good Two,SN-P6,in_repair,,\n";
    const body = await runImport(app, cookie, csv);

    expect(body.job.totalRows).toBe(8);
    expect(body.job.createdCount).toBe(2);
    expect(body.job.errorCount).toBe(6);
    expect(outcomes(body)).toEqual([
      "created",
      "error",
      "error",
      "error",
      "error",
      "error",
      "error",
      "created",
    ]);
    expect(body.rows[1]?.message).toContain("name is required");
    expect(body.rows[2]?.message).toContain("check-out");
    expect(body.rows[3]?.message).toContain("unknown location");
    expect(body.rows[4]?.message).toContain("invalid MAC");
    expect(body.rows[5]?.message).toContain("identity field");
    expect(body.rows[6]?.message).toContain("duplicate serial_number");
    expect(body.rows[6]?.message).toContain("row 1");
    expect(await listAssetsTotal(app, cookie)).toBe(2);
  });

  it("resolves ambiguous location names to an error, not a guess", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const northRes = await jsonRequest(
      app,
      "/api/v1/locations",
      "POST",
      cookie,
      { name: "North Campus", kind: "site" },
    );
    const { location: north } = (await northRes.json()) as {
      location: { id: string };
    };
    const southRes = await jsonRequest(
      app,
      "/api/v1/locations",
      "POST",
      cookie,
      { name: "South Campus", kind: "site" },
    );
    const { location: south } = (await southRes.json()) as {
      location: { id: string };
    };
    await jsonRequest(app, "/api/v1/locations", "POST", cookie, {
      name: "Storage",
      kind: "building",
      parentId: north.id,
    });
    const roomRes = await jsonRequest(app, "/api/v1/locations", "POST", cookie, {
      name: "Storage",
      kind: "building",
      parentId: south.id,
    });
    expect(roomRes.status).toBe(201);
    const { location: room } = (await roomRes.json()) as {
      location: { id: string };
    };

    const body = await runImport(
      app,
      cookie,
      "name,serial,location,location_id\n" +
        "Ambiguous,SN-L1,Storage,\n" +
        `By Id,SN-L2,,${room.id}\n` +
        `Both,SN-L3,Storage,${room.id}\n`,
    );
    expect(outcomes(body)).toEqual(["error", "created", "error"]);
    expect(body.rows[0]?.message).toContain("ambiguous location");
    expect(body.rows[2]?.message).toContain("not both");
    const res = await jsonRequest(
      app,
      `/api/v1/assets/${body.rows[1]?.assetId}`,
      "GET",
      cookie,
    );
    const detail = (await res.json()) as { asset: AssetRecord };
    expect(detail.asset.locationId).toBe(room.id);
  });
});

describe("idempotent re-runs", () => {
  it("skips every row of an already-committed file and links the prior job", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const csv =
      "name,serial_number,asset_tag\n" +
      "Repeat A,SN-R1,HT-2001\n" +
      "Repeat B,SN-R2,HT-2002\n";
    const first = await runImport(app, cookie, csv);
    expect(first.job.createdCount).toBe(2);

    const second = await runImport(app, cookie, csv);
    expect(second.priorImport?.id).toBe(first.job.id);
    expect(second.job.createdCount).toBe(0);
    expect(second.job.skippedCount).toBe(2);
    expect(outcomes(second)).toEqual([
      "skipped_duplicate",
      "skipped_duplicate",
    ]);
    // Skipped rows still point at the asset they matched.
    expect(second.rows.map((r) => r.assetId).sort()).toEqual(
      first.rows.map((r) => r.assetId).sort(),
    );
    expect(await listAssetsTotal(app, cookie)).toBe(2);
  });

  it("imports only the fixed rows when a corrected file is re-run", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const first = await runImport(
      app,
      cookie,
      "name,serial\nKeeper,SN-F1\n,SN-F2\n",
    );
    expect(first.job.createdCount).toBe(1);
    expect(first.job.errorCount).toBe(1);

    const second = await runImport(
      app,
      cookie,
      "name,serial\nKeeper,SN-F1\nFixed Row,SN-F2\n",
    );
    expect(second.job.skippedCount).toBe(1);
    expect(second.job.createdCount).toBe(1);
    expect(second.priorImport).toBeNull();
    expect(await listAssetsTotal(app, cookie)).toBe(2);
  });

  it("matches identity case-insensitively on re-import", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const first = await runImport(app, cookie, "name,serial\nCased,sn-c1\n");
    expect(first.job.createdCount).toBe(1);
    const second = await runImport(app, cookie, "name,serial\nCased,SN-C1\n");
    expect(second.job.skippedCount).toBe(1);
    expect(await listAssetsTotal(app, cookie)).toBe(1);
  });
});

describe("collisions become exceptions", () => {
  async function firstException(store: Store): Promise<ExceptionRecord> {
    const list = await store.listExceptions({ limit: 10 });
    const exception = list[0];
    if (exception === undefined) throw new Error("no exception found");
    return exception;
  }

  it("records a mismatch collision as an open exception, without merging", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const existing = await createAsset(app, cookie, {
      name: "Existing Laptop",
      serialNumber: "SN-X1",
      assetTag: "HT-3001",
    });

    const body = await runImport(
      app,
      cookie,
      "name,serial_number,asset_tag\nIncoming,SN-X1,HT-3999\n",
    );
    expect(outcomes(body)).toEqual(["collision"]);
    expect(body.job.collisionCount).toBe(1);
    expect(body.rows[0]?.message).toContain(existing.id);
    expect(await listAssetsTotal(app, cookie)).toBe(1);

    const exception = await firstException(store);
    expect(exception.kind).toBe("import_identity_collision");
    expect(exception.status).toBe("open");
    expect(exception.assetId).toBe(existing.id);
    expect(exception.importRowId).toBe(body.rows[0]?.id);
    const details = JSON.parse(exception.details ?? "{}") as {
      reason: string;
      signature: string;
      jobId: string;
      rowNumber: number;
      matches: { field: string; assetId: string }[];
    };
    expect(details.reason).toBe("identity_mismatch");
    expect(details.signature).toBeTruthy();
    expect(details.jobId).toBe(body.job.id);
    expect(details.rowNumber).toBe(1);
    expect(details.matches[0]?.assetId).toBe(existing.id);

    const audit = await store.listAudit({
      limit: 10,
      action: "exception.create",
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.entityId).toBe(exception.id);
    expect(audit[0]?.actorEmail).toBe("admin@hatcheck.test");
    expect(audit[0]?.actorUserId).toBeTruthy();
    const auditDetails = JSON.parse(audit[0]?.details ?? "{}") as {
      before: unknown;
      after: { kind: string; status: string; importRowId: string };
      importJobId: string;
    };
    expect(auditDetails.before).toBeNull();
    expect(auditDetails.after.kind).toBe("import_identity_collision");
    expect(auditDetails.after.status).toBe("open");
    expect(auditDetails.after.importRowId).toBe(body.rows[0]?.id);
    expect(auditDetails.importJobId).toBe(body.job.id);
  });

  it("treats extending an existing asset's identity as a collision", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    await createAsset(app, cookie, {
      name: "Serial Only",
      serialNumber: "SN-X2",
    });
    const body = await runImport(
      app,
      cookie,
      "name,serial_number,asset_tag\nIncoming,SN-X2,HT-4001\n",
    );
    expect(outcomes(body)).toEqual(["collision"]);
    expect(body.rows[0]?.message).toContain("would add asset_tag");
    const exception = await firstException(store);
    const details = JSON.parse(exception.details ?? "{}") as {
      reason: string;
    };
    expect(details.reason).toBe("would_extend_identity");
  });

  it("reports a row matching two different assets", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    const byTag = await createAsset(app, cookie, {
      name: "Tagged",
      assetTag: "HT-5001",
    });
    const bySerial = await createAsset(app, cookie, {
      name: "Serialed",
      serialNumber: "SN-X3",
    });
    const body = await runImport(
      app,
      cookie,
      "name,serial_number,asset_tag\nChimera,SN-X3,HT-5001\n",
    );
    expect(outcomes(body)).toEqual(["collision"]);
    const exception = await firstException(store);
    const details = JSON.parse(exception.details ?? "{}") as {
      reason: string;
      matches: { assetId: string }[];
    };
    expect(details.reason).toBe("multiple_assets");
    expect(new Set(details.matches.map((m) => m.assetId))).toEqual(
      new Set([byTag.id, bySerial.id]),
    );
  });

  it("does not stack duplicate open exceptions across re-runs", async () => {
    const { app, store, cookie } = await makeAppWithAdmin();
    await createAsset(app, cookie, {
      name: "Existing",
      serialNumber: "SN-X4",
      assetTag: "HT-6001",
    });
    const csv = "name,serial_number,asset_tag\nIncoming,SN-X4,HT-6999\n";
    await runImport(app, cookie, csv);
    await runImport(app, cookie, csv);
    expect(await store.countExceptions()).toBe(1);

    // A closed decision does not suppress a NEW occurrence of the same
    // conflict: the next run raises a fresh exception for review.
    const exception = await firstException(store);
    const resolveRes = await jsonRequest(
      app,
      `/api/v1/exceptions/${exception.id}/resolve`,
      "POST",
      cookie,
      { status: "dismissed" },
    );
    expect(resolveRes.status).toBe(200);
    await runImport(app, cookie, csv);
    expect(await store.countExceptions()).toBe(2);
    expect(await store.countExceptions("open")).toBe(1);
  });
});

describe("import views", () => {
  it("lists jobs newest first with pagination and serves rows by job", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const first = await runImport(app, cookie, "name,serial\nA,SN-V1\n");
    const second = await runImport(app, cookie, "name,serial\nB,SN-V2\n");

    const listRes = await jsonRequest(
      app,
      "/api/v1/imports?limit=1",
      "GET",
      cookie,
    );
    const list = (await listRes.json()) as {
      items: ImportJobRecord[];
      total: number;
    };
    expect(list.total).toBe(2);
    expect(list.items[0]?.id).toBe(second.job.id);

    const rowsRes = await jsonRequest(
      app,
      `/api/v1/imports/${first.job.id}/rows`,
      "GET",
      cookie,
    );
    const rows = (await rowsRes.json()) as {
      items: ImportRowRecord[];
      total: number;
    };
    expect(rows.total).toBe(1);
    expect(rows.items[0]?.outcome).toBe("created");
    const raw = JSON.parse(rows.items[0]?.raw ?? "{}") as {
      name: string;
      serial_number: string;
    };
    expect(raw.name).toBe("A");
    expect(raw.serial_number).toBe("SN-V1");
  });

  it("404s for a missing job on detail and rows", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const detail = await jsonRequest(
      app,
      "/api/v1/imports/missing-id",
      "GET",
      cookie,
    );
    expect(detail.status).toBe(404);
    const rows = await jsonRequest(
      app,
      "/api/v1/imports/missing-id/rows",
      "GET",
      cookie,
    );
    expect(rows.status).toBe(404);
  });
});

describe("OpenAPI document", () => {
  it("documents every import and exception operation", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const res = await jsonRequest(app, "/api/v1/openapi.json", "GET", cookie);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(doc.paths["/api/v1/imports/assets"]?.["post"]).toBeTruthy();
    expect(doc.paths["/api/v1/imports"]?.["get"]).toBeTruthy();
    expect(doc.paths["/api/v1/imports/{id}"]?.["get"]).toBeTruthy();
    expect(doc.paths["/api/v1/imports/{id}/rows"]?.["get"]).toBeTruthy();
    expect(doc.paths["/api/v1/exceptions"]?.["get"]).toBeTruthy();
    expect(doc.paths["/api/v1/exceptions/{id}"]?.["get"]).toBeTruthy();
    expect(
      doc.paths["/api/v1/exceptions/{id}/resolve"]?.["post"],
    ).toBeTruthy();
    const post = doc.paths["/api/v1/imports/assets"]?.["post"] as {
      requestBody: { content: Record<string, unknown> };
    };
    expect(Object.keys(post.requestBody.content)).toEqual(["text/csv"]);
  });
});

describe("gate: 500 synthetic assets in one run", () => {
  function gateCsv(): string {
    const lines = [
      "name,asset_type,status,asset_tag,serial_number,mac_addresses",
    ];
    for (let i = 1; i <= 500; i += 1) {
      const n = String(i).padStart(4, "0");
      const mac = `02:00:5e:${String(Math.floor(i / 256)).padStart(2, "0")}:${(
        i % 256
      )
        .toString(16)
        .padStart(2, "0")}:aa`;
      lines.push(
        `Fleet Laptop ${n},device,in_stock,HT-G${n},SN-GATE-${n},${mac}`,
      );
    }
    return lines.join("\n") + "\n";
  }

  it("imports 500 assets via CSV in one run with a per-row report", async () => {
    const { app, cookie } = await makeAppWithAdmin();
    const body = await runImport(app, cookie, gateCsv());

    expect(body.job.status).toBe("completed");
    expect(body.job.totalRows).toBe(500);
    expect(body.job.createdCount).toBe(500);
    expect(body.job.skippedCount).toBe(0);
    expect(body.job.collisionCount).toBe(0);
    expect(body.job.errorCount).toBe(0);

    // The per-row result report covers every row, in file order.
    expect(body.rows).toHaveLength(500);
    expect(body.rows.every((r) => r.outcome === "created")).toBe(true);
    expect(body.rows.every((r) => r.assetId !== null)).toBe(true);
    expect(body.rows.map((r) => r.rowNumber)).toEqual(
      Array.from({ length: 500 }, (_, i) => i + 1),
    );

    expect(await listAssetsTotal(app, cookie)).toBe(500);

    // The full report also remains retrievable after the fact.
    const rowsRes = await jsonRequest(
      app,
      `/api/v1/imports/${body.job.id}/rows?limit=1000`,
      "GET",
      cookie,
    );
    const rows = (await rowsRes.json()) as { items: unknown[]; total: number };
    expect(rows.total).toBe(500);
    expect(rows.items).toHaveLength(500);

    // Idempotency at gate scale: the same file again creates nothing.
    const rerun = await runImport(app, cookie, gateCsv());
    expect(rerun.job.skippedCount).toBe(500);
    expect(rerun.job.createdCount).toBe(0);
    expect(rerun.priorImport?.id).toBe(body.job.id);
    expect(await listAssetsTotal(app, cookie)).toBe(500);
  }, 30000);
});
