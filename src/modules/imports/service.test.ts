// Import-service failure-path tests. The API suite (src/server/
// imports.test.ts) covers the happy paths; these tests inject store
// faults to prove the properties that only show up when a run aborts
// mid-way: every already-persisted mutation is already audited (hard
// rule 5 / gate criterion 2), the job is marked failed with honest
// partial counts, and the original error survives the cleanup path.
// Synthetic data only.
import { describe, expect, it } from "vitest";
import { createSqliteStore } from "../../db/store.sqlite";
import type { NewImportRow, Store } from "../../db/store";
import { runAssetImport } from "./service";

const ACTOR = {
  actorUserId: "user-import-test",
  actorEmail: "importer@hatcheck.test",
};

async function makeStore(): Promise<Store> {
  const store = await createSqliteStore(":memory:");
  await store.migrate();
  return store;
}

describe("runAssetImport failure path", () => {
  it("leaves no unaudited asset behind when the run aborts mid-way", async () => {
    const store = await makeStore();
    // Fault injection: the third row's asset insert dies with a
    // non-unique-violation error (stand-in for any transient DB error
    // mid-run). Rows 1 and 2 have already created real assets by then.
    let creates = 0;
    const flaky: Store = {
      ...store,
      createAssetWithInterfaces(asset, interfaces) {
        creates += 1;
        if (creates === 3) {
          throw new Error("injected mid-run failure");
        }
        return store.createAssetWithInterfaces(asset, interfaces);
      },
    };

    const csv =
      "name,serial\n" +
      "Survivor A,SN-FAIL-1\n" +
      "Survivor B,SN-FAIL-2\n" +
      "Never Created,SN-FAIL-3\n";
    await expect(
      runAssetImport(flaky, {
        csvText: csv,
        mode: "commit",
        filename: "burst.csv",
        actor: ACTOR,
        ip: "203.0.113.10",
      }),
    ).rejects.toThrow("injected mid-run failure");

    // Both persisted assets are on the audit trail even though the run
    // never completed and no route-level code ran.
    const audits = await store.listAudit({ limit: 10, action: "asset.create" });
    expect(audits).toHaveLength(2);
    for (const entry of audits) {
      expect(entry.actorUserId).toBe(ACTOR.actorUserId);
      expect(entry.actorEmail).toBe(ACTOR.actorEmail);
      expect(entry.ip).toBe("203.0.113.10");
      const details = JSON.parse(entry.details ?? "{}") as {
        before: unknown;
        after: { serialNumber: string };
        importJobId: string;
      };
      expect(details.before).toBeNull();
      expect(details.importJobId).toBeTruthy();
      expect(["SN-FAIL-1", "SN-FAIL-2"]).toContain(
        details.after.serialNumber,
      );
    }

    // The job records the abort honestly: failed, with partial counts.
    const jobs = await store.listImportJobs({ limit: 10 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("failed");
    expect(jobs[0]?.createdCount).toBe(2);

    await store.close();
  });

  it("surfaces the original error even when marking the job failed also fails", async () => {
    const store = await makeStore();
    let rowWrites = 0;
    const dying: Store = {
      ...store,
      appendImportRow(row: NewImportRow) {
        rowWrites += 1;
        if (rowWrites >= 2) {
          throw new Error("database has gone away");
        }
        return store.appendImportRow(row);
      },
      completeImportJob() {
        throw new Error("still down");
      },
    };

    await expect(
      runAssetImport(dying, {
        csvText: "name,serial\nA,SN-DEAD-1\nB,SN-DEAD-2\n",
        mode: "commit",
        filename: null,
        actor: ACTOR,
        ip: null,
      }),
    ).rejects.toThrow("database has gone away");

    await store.close();
  });
});
