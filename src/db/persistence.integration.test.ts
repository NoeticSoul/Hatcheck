import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { Store } from "./store";
import { createPgStore } from "./store.pg";
import { createSqliteStore } from "./store.sqlite";

const pgUrl = process.env.HATCHECK_TEST_PG_URL;
const executeFile = promisify(execFile);

type Fixture = { store: Store; url: string; execute: (statement: string) => Promise<void> };

async function scratch<T>(kind: "sqlite" | "pg", work: (fixture: Fixture) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), "hatcheck-persistence-"));
  if (kind === "sqlite") {
    const path = join(folder, "fixture.sqlite");
    const store = await createSqliteStore(path);
    const raw = new Database(path);
    try {
      return await work({ store, url: path, execute: async (statement) => { raw.exec(statement); } });
    } finally {
      raw.close();
      await store.close();
      await rm(folder, { recursive: true, force: true });
    }
  }
  if (!pgUrl) throw new Error("PostgreSQL fixture requires HATCHECK_TEST_PG_URL");
  const name = `hc_persistence_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(pgUrl, { max: 1 });
  const url = new URL(pgUrl);
  url.pathname = `/${name}`;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    const store = createPgStore(url.toString());
    const raw = postgres(url.toString(), { max: 1 });
    try {
      return await work({ store, url: url.toString(), execute: async (statement) => { await raw.unsafe(statement); } });
    } finally {
      await raw.end();
      await store.close();
      await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    }
  } finally {
    await admin.end();
    await rm(folder, { recursive: true, force: true });
  }
}

async function migrateLegacy(fixture: Fixture, kind: "sqlite" | "pg") {
  const previous = await mkdtemp(join(tmpdir(), "hatcheck-legacy-migrations-"));
  const source = fileURLToPath(new URL(`./migrations/${kind}`, import.meta.url));
  const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.slice(0, 3);
  await mkdir(join(previous, "meta"));
  await writeFile(join(previous, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) await copyFile(join(source, `${entry.tag}.sql`), join(previous, `${entry.tag}.sql`));
  const key = kind === "pg" ? "HATCHECK_PG_MIGRATIONS_DIR" : "HATCHECK_SQLITE_MIGRATIONS_DIR";
  const existing = process.env[key];
  try {
    process.env[key] = previous;
    await fixture.store.migrate();
  } finally {
    if (existing === undefined) delete process.env[key]; else process.env[key] = existing;
    await rm(previous, { recursive: true, force: true });
  }
}

for (const kind of ["sqlite", "pg"] as const) {
  describe.runIf(kind === "sqlite" || Boolean(pgUrl))(`${kind} legacy integrity migration`, () => {
    it("backfills stable per-asset sequences and preserves users, sessions, assets, and event snapshots", async () => {
      await scratch(kind, async (fixture) => {
        await migrateLegacy(fixture, kind);
        await fixture.execute(`
          INSERT INTO users (id,email,display_name,role,auth_source,oidc_subject,created_at,updated_at)
            VALUES ('legacy-user','legacy@hatcheck.test','Legacy User','readonly','oidc','legacy-subject',1,1);
          INSERT INTO sessions (token_hash,user_id,created_at,expires_at)
            VALUES ('synthetic-token','legacy-user',1,9999999999999);
          INSERT INTO assets (id,name,created_at,updated_at) VALUES ('asset-one','Legacy One',1,1),('asset-two','Legacy Two',1,1);
          INSERT INTO custody_events (id,asset_id,at,type,holder_name,note) VALUES
            ('b','asset-one',1000,'check_out','Synthetic Holder','First checkout'),
            ('c','asset-one',1000,'check_in',NULL,'Final checkin'),
            ('a','asset-one',500,'check_out','Older Holder','Older imported event'),
            ('z','asset-two',200,'check_out','Other Holder','Other asset');
        `);
        await fixture.store.migrate();
        await fixture.store.migrate();
        const events = await fixture.store.listCustodyEvents("asset-one", { limit: 10 });
        expect(events.map((event) => [event.id, event.sequence])).toEqual([["c", 3], ["b", 2], ["a", 1]]);
        expect(events[0]?.note).toBe("Final checkin");
        expect(await fixture.store.getCurrentCustody("asset-one")).toBeNull();
        expect((await fixture.store.getCurrentCustody("asset-two"))?.sequence).toBe(1);
        expect(await fixture.store.countAssets({})).toBe(2);
        expect((await fixture.store.getUserById("legacy-user"))?.oidcIssuer).toBeNull();
        expect((await fixture.store.getSessionUser("synthetic-token", 2))?.user.id).toBe("legacy-user");
        const appended = await fixture.store.appendCustodyEvent({ assetId: "asset-one", type: "check_out" });
        expect(appended?.ok && appended.event.sequence).toBe(4);
      });
    });
  });
}

const workerSource = fileURLToPath(new URL("./store.pg.ts", import.meta.url));
async function appendInProcess(url: string, assetId: string, type: "check_out" | "check_in", randomPrefix: string) {
  const source = `
    import { createPgStore } from ${JSON.stringify(workerSource)};
    const store = createPgStore(process.env.HATCHECK_PERSIST_URL);
    Date.now = () => 1900000000000;
    crypto.randomUUID = () => ${JSON.stringify(`${randomPrefix.repeat(8)}-${randomPrefix.repeat(4)}-4${randomPrefix.repeat(3)}-8${randomPrefix.repeat(3)}-${randomPrefix.repeat(12)}`)};
    try {
      const result = await store.appendCustodyEvent({assetId: ${JSON.stringify(assetId)}, type: ${JSON.stringify(type)}} , ${JSON.stringify(type === "check_out" ? "deployed" : "in_stock")});
      console.log(JSON.stringify(result));
    } finally { await store.close(); }
  `;
  const { stdout } = await executeFile("bun", ["-e", source], {
    env: { ...process.env, HATCHECK_PERSIST_URL: url }, timeout: 10000,
  });
  return JSON.parse(stdout) as { ok: boolean; event: { id: string; sequence: number } };
}

describe.runIf(Boolean(pgUrl))("postgres independent writers", () => {
  it("uses persisted sequence when later equal-time events have smaller IDs from another process", async () => {
    await scratch("pg", async ({ store, url }) => {
      await store.migrate();
      const asset = await store.createAssetWithInterfaces({ name: "Process Laptop" }, []);
      const checkout = await appendInProcess(url, asset.id, "check_out", "f");
      const checkin = await appendInProcess(url, asset.id, "check_in", "0");
      expect(checkout.ok).toBe(true);
      expect(checkin.ok).toBe(true);
      expect(checkin.event.id < checkout.event.id).toBe(true);
      expect([checkout.event.sequence, checkin.event.sequence]).toEqual([1, 2]);
      expect(await store.getCurrentCustody(asset.id)).toBeNull();
      expect((await store.getAssetById(asset.id))?.status).toBe("in_stock");
      expect((await store.listCustodyEvents(asset.id, { limit: 1 }))[0]?.id).toBe(checkin.event.id);
      const again = await appendInProcess(url, asset.id, "check_out", "1");
      expect(again.event.sequence).toBe(3);
    });
  });

  it("serializes application prechecks across separate connection pools before either mutation", async () => {
    await scratch("pg", async ({ store, url }) => {
      await store.migrate();
      const first = await store.createUser({ email: "first@hatcheck.test", displayName: "First", role: "admin", authSource: "local" });
      const second = await store.createUser({ email: "second@hatcheck.test", displayName: "Second", role: "admin", authSource: "local" });
      const other = createPgStore(url);
      try {
        const demote = (connection: Store, id: string) => connection.transaction(async (tx) => {
          const active = (await tx.listUsers()).filter((user) => user.isActive && user.role === "admin");
          if (active.length <= 1) return false;
          await new Promise((resolve) => setTimeout(resolve, 30));
          await tx.updateUser(id, { role: "readonly" });
          await tx.appendAudit({ action: "user.updated", entityId: id });
          return true;
        });
        const results = await Promise.all([demote(store, first.id), demote(other, second.id)]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect((await store.listUsers()).filter((user) => user.isActive && user.role === "admin")).toHaveLength(1);
        expect(await store.countAudit()).toBe(1);
      } finally { await other.close(); }
    });
  });
});
