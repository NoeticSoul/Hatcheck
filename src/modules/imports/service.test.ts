// Faults are injected into the actual transaction-bound store, so each test
// verifies committed database state rather than a wrapper that tx bypasses.
import { afterEach, describe, expect, it } from "vitest";
import type { Store } from "../../db/store";
import { createTestStore } from "../../test/store";
import { runAssetImport } from "./service";

const ACTOR = { actorUserId: "user-import-test", actorEmail: "importer@hatcheck.test" };
const stores: Store[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())); });

async function makeStore(): Promise<Store> {
  const store = await createTestStore();
  await store.migrate();
  stores.push(store);
  return store;
}

function inject(store: Store, overrides: (tx: Store) => Partial<Store>): Store {
  return {
    ...store,
    ...overrides(store),
    transaction: (work) => store.transaction((tx) => work(inject(tx, overrides))),
  };
}

const run = (store: Store, csvText = "name,serial\nA,SN-FAIL-1\nB,SN-FAIL-2\nC,SN-FAIL-3\n", mode: "commit" | "dry_run" = "commit") => runAssetImport(store, {
  csvText, mode, filename: "burst.csv", actor: ACTOR, ip: "203.0.113.10",
});

describe("runAssetImport failure atomicity", () => {
  it("preserves complete earlier rows when a later asset insert fails", async () => {
    const store = await makeStore();
    let creates = 0;
    const flaky = inject(store, (tx) => ({
      createAssetWithInterfaces(asset, interfaces) {
        if (++creates === 3) throw new Error("injected mid-run failure");
        return tx.createAssetWithInterfaces(asset, interfaces);
      },
    }));
    await expect(run(flaky)).rejects.toThrow("injected mid-run failure");
    expect(await store.countAssets({})).toBe(2);
    const audits = await store.listAudit({ limit: 10, action: "asset.create" });
    expect(audits).toHaveLength(2);
    for (const entry of audits) {
      expect(entry.actorUserId).toBe(ACTOR.actorUserId);
      expect(entry.actorEmail).toBe(ACTOR.actorEmail);
      expect(entry.ip).toBe("203.0.113.10");
      const details = JSON.parse(entry.details ?? "{}");
      expect(details.before).toBeNull();
      expect(details.importJobId).toBeTruthy();
    }
    const [job] = await store.listImportJobs({ limit: 10 });
    expect(job?.status).toBe("failed");
    expect(job?.createdCount).toBe(2);
    expect(await store.countImportRows(job!.id)).toBe(2);
    expect(await store.countAudit({ action: "import.failed" })).toBe(1);
  });

  it.each(["audit", "report", "progress"])("rolls back the current row when its %s write fails", async (failure) => {
    const store = await makeStore();
    let calls = 0;
    const flaky = inject(store, (tx) => ({
      appendAudit(entry) {
        if (failure === "audit" && entry.action === "asset.create" && ++calls === 2) throw new Error("row write failed");
        return tx.appendAudit(entry);
      },
      appendImportRow(row) {
        if (failure === "report" && ++calls === 2) throw new Error("row write failed");
        return tx.appendImportRow(row);
      },
      completeImportJob(id, completion) {
        if (failure === "progress" && completion.status === "running" && completion.createdCount === 2) throw new Error("row write failed");
        return tx.completeImportJob(id, completion);
      },
    }));
    await expect(run(flaky)).rejects.toThrow("row write failed");
    expect(await store.countAssets({})).toBe(1);
    expect(await store.countAudit({ action: "asset.create" })).toBe(1);
    const [job] = await store.listImportJobs({ limit: 10 });
    expect(job?.status).toBe("failed");
    expect(job?.createdCount).toBe(1);
    expect(await store.countImportRows(job!.id)).toBe(1);
  });

  it("keeps committed progress when failure cleanup also fails and preserves the original error", async () => {
    const store = await makeStore();
    let rowWrites = 0;
    const dying = inject(store, (tx) => ({
      appendImportRow(row) {
        if (++rowWrites >= 2) throw new Error("database has gone away");
        return tx.appendImportRow(row);
      },
      completeImportJob(id, completion) {
        if (completion.status === "failed") throw new Error("still down");
        return tx.completeImportJob(id, completion);
      },
    }));
    await expect(run(dying)).rejects.toThrow("database has gone away");
    const [job] = await store.listImportJobs({ limit: 10 });
    expect(job?.status).toBe("running");
    expect(job?.createdCount).toBe(1);
    expect(await store.countAssets({})).toBe(1);
    expect(await store.countImportRows(job!.id)).toBe(1);
  });

  it("never persists a job whose creation audit failed", async () => {
    const store = await makeStore();
    const flaky = inject(store, (tx) => ({ appendAudit(entry) {
      if (entry.action === "import.start") throw new Error("start audit failed");
      return tx.appendAudit(entry);
    } }));
    await expect(run(flaky)).rejects.toThrow("start audit failed");
    expect(await store.countImportJobs()).toBe(0);
  });

  it.each(["commit", "dry_run"] as const)("never publishes an unaudited successful %s state", async (mode) => {
    const store = await makeStore();
    const flaky = inject(store, (tx) => ({ appendAudit(entry) {
      if (entry.action === (mode === "commit" ? "import.commit" : "import.dry_run")) throw new Error("completion audit failed");
      return tx.appendAudit(entry);
    } }));
    await expect(run(flaky, "name,serial\nA,SN-COMPLETE-1\n", mode)).rejects.toThrow("completion audit failed");
    const [job] = await store.listImportJobs({ limit: 10 });
    expect(job?.status).toBe("failed");
    expect(job?.createdCount).toBe(1);
    expect(await store.countAssets({})).toBe(mode === "commit" ? 1 : 0);
    expect(await store.countAudit({ action: "import.progress" })).toBe(1);
  });

  it("rolls back collision exceptions together with their report and audit", async () => {
    const store = await makeStore();
    await store.createAssetWithInterfaces({ name: "Existing", assetTag: "TAG-ONE", assetTagNorm: "TAG-ONE", serialNumber: "OLD-SERIAL", serialNumberNorm: "OLD-SERIAL" }, []);
    const flaky = inject(store, (tx) => ({ appendAudit(entry) {
      if (entry.action === "exception.create") throw new Error("exception audit failed");
      return tx.appendAudit(entry);
    } }));
    await expect(run(flaky, "name,asset_tag,serial\nIncoming,TAG-ONE,NEW-SERIAL\n")).rejects.toThrow("exception audit failed");
    expect(await store.countExceptions()).toBe(0);
    const [job] = await store.listImportJobs({ limit: 10 });
    expect(job?.collisionCount).toBe(0);
    expect(await store.countImportRows(job!.id)).toBe(0);
  });

  it("deduplicates concurrent collision imports without merging identities", async () => {
    const store = await makeStore();
    await store.createAssetWithInterfaces({ name: "Existing", assetTag: "TAG-ONE", assetTagNorm: "TAG-ONE", serialNumber: "OLD-SERIAL", serialNumberNorm: "OLD-SERIAL" }, []);
    const csv = "name,asset_tag,serial\nIncoming,TAG-ONE,NEW-SERIAL\n";
    const results = await Promise.all([run(store, csv), run(store, csv)]);
    expect(results.every((result) => result.ok && result.job.collisionCount === 1)).toBe(true);
    expect(await store.countAssets({})).toBe(1);
    expect(await store.countExceptions()).toBe(1);
  });
});
