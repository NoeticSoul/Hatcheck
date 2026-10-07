import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteStore } from "../db/store.sqlite";
import { hashPassword, verifyPassword } from "./password";
import { backupSqlite, restoreSqlite } from "./recovery";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("SQLite recovery", () => {
  it("snapshots committed WAL data and restores accounts, custody, audits and sessions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hatcheck-recovery-test-"));
    directories.push(directory);
    const live = join(directory, "live.db");
    const backup = join(directory, "backup.db");
    const restored = join(directory, "restored.db");
    const store = await createSqliteStore(live);
    try {
      await store.migrate();
      const password = randomUUID();
      const user = await store.createUser({ email: "recovery@hatcheck.test", displayName: "Recovery Tester", role: "admin", authSource: "local", passwordHash: await hashPassword(password) });
      const tokenHash = randomUUID();
      await store.createSession({ userId: user.id, tokenHash, expiresAt: Date.now() + 3600_000 });
      const asset = await store.createAssetWithInterfaces({ name: "Recovery laptop", assetTag: "RECOVERY-001", assetTagNorm: "recovery-001" }, [{ mac: "02:00:00:00:00:01" }]);
      await store.appendCustodyEvent({ assetId: asset.id, type: "check_out", holderUserId: user.id, holderName: user.displayName, actorUserId: user.id }, "deployed");
      await store.appendAudit({ action: "asset.check_out", actorUserId: user.id, entityId: asset.id, entityType: "asset" });
      expect(statSync(`${live}-wal`).size).toBeGreaterThan(0);

      // Keep the source open: this proves the backup includes uncheckpointed
      // WAL commits and does not depend on stopping the live application.
      await backupSqlite(live, backup);
      await restoreSqlite(backup, restored);
      const recovered = await createSqliteStore(restored);
      try {
        const account = await recovered.getUserById(user.id);
        expect(account?.email).toBe(user.email);
        expect(await verifyPassword(account?.passwordHash ?? "", password)).toBe(true);
        expect(await recovered.getAssetById(asset.id)).toEqual(await store.getAssetById(asset.id));
        expect(await recovered.listCustodyEvents(asset.id, { limit: 10 })).toEqual(await store.listCustodyEvents(asset.id, { limit: 10 }));
        expect(await recovered.listAudit({ limit: 10 })).toEqual(await store.listAudit({ limit: 10 }));
        expect((await recovered.getSessionUser(tokenHash, Date.now()))?.user.id).toBe(user.id);
        expect(statSync(backup).mode & 0o777).toBe(0o600);
      } finally { await recovered.close(); }

      await expect(backupSqlite(live, backup)).rejects.toThrow("already exists");
      await expect(restoreSqlite(backup, restored)).rejects.toThrow("already exist");
    } finally { await store.close(); }
  });

  it("refuses damaged snapshots and orphaned live WAL files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hatcheck-recovery-test-"));
    directories.push(directory);
    const invalid = join(directory, "invalid.db");
    const target = join(directory, "target.db");
    writeFileSync(invalid, "not a SQLite database");
    await expect(restoreSqlite(invalid, target)).rejects.toThrow();
    writeFileSync(`${target}-wal`, "synthetic stale sidecar");
    await expect(restoreSqlite(invalid, target)).rejects.toThrow("sidecar");
  });
});
