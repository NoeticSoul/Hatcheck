import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config";
import { createStore } from "../db/client";
import { initializeStore } from "./initialize";

const baseUrl = process.env.HATCHECK_TEST_PG_URL;
describe.skipIf(!baseUrl)("PostgreSQL startup ownership and runtime privileges", () => {
  it("serializes initialization and restricts runtime history/schema writes with encoded passwords", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const database = `hcop_${suffix}`;
    const ownerRole = `hcop_owner_${suffix}`;
    const runtimeRole = `hcop_app_${suffix}`;
    const ownerPassword = `${randomUUID()}/?#@:%+$`;
    const runtimePassword = `${randomUUID()}/?#@:%+$`;
    const admin = postgres(baseUrl!, { max: 1 });
    let ownerCreated = false;
    let runtimeCreated = false;
    let databaseCreated = false;
    const connectionUrl = (role: string, password: string) => {
      const url = new URL(baseUrl!);
      url.username = encodeURIComponent(role);
      url.password = encodeURIComponent(password);
      url.pathname = `/${database}`;
      return url.toString();
    };
    const previousRuntimeRole = process.env.POSTGRES_RUNTIME_ROLE;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // PostgreSQL utility statements require password string literals;
      // these values are generated synthetic fixtures and are quoted here.
      await admin.unsafe(`CREATE ROLE "${ownerRole}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${ownerPassword.replaceAll("'", "''")}'`);
      ownerCreated = true;
      await admin.unsafe(`CREATE ROLE "${runtimeRole}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${runtimePassword.replaceAll("'", "''")}'`);
      runtimeCreated = true;
      await admin.unsafe(`CREATE DATABASE "${database}" OWNER "${ownerRole}"`);
      databaseCreated = true;
      process.env.POSTGRES_RUNTIME_ROLE = runtimeRole;
      const ownerConfig = loadConfig({ NODE_ENV: "test", HATCHECK_DB: "postgres", DATABASE_URL: connectionUrl(ownerRole, ownerPassword) });
      const owners = await Promise.all([createStore(ownerConfig), createStore(ownerConfig)]);
      try {
        await Promise.all(owners.map((store) => initializeStore(ownerConfig, store)));
        expect(await owners[0]!.countUsers()).toBe(1);
        expect(await owners[0]!.countAudit({ action: "user.create" })).toBe(1);
      } finally { await Promise.all(owners.map((store) => store.close())); }

      const runtimeUrl = connectionUrl(runtimeRole, runtimePassword);
      const runtime = postgres(runtimeUrl, { max: 1 });
      const store = await createStore(loadConfig({ NODE_ENV: "test", HATCHECK_DB: "postgres", DATABASE_URL: runtimeUrl, HATCHECK_SKIP_MIGRATIONS: "true", HATCHECK_SKIP_BOOTSTRAP: "true" }));
      try {
        await store.readiness();
        const asset = await store.transaction(async (tx) => {
          const asset = await tx.createAssetWithInterfaces({ name: "Privilege test laptop" }, []);
          await tx.appendCustodyEvent({ assetId: asset.id, type: "check_out", holderName: "Synthetic holder" }, "deployed");
          await tx.appendAudit({ action: "asset.check_out", entityType: "asset", entityId: asset.id });
          return asset;
        });
        expect(await store.getCurrentCustody(asset.id)).not.toBeNull();
        for (const command of [
          "CREATE TABLE forbidden_runtime_table(id text)",
          "UPDATE audit_log SET action='tampered'",
          "DELETE FROM custody_events",
          "TRUNCATE audit_log",
          "UPDATE document_revisions SET title='tampered'",
        ]) {
          await expect(runtime.unsafe(command)).rejects.toMatchObject({ code: "42501" });
        }
      } finally { await store.close(); await runtime.end(); }
    } finally {
      log.mockRestore();
      if (previousRuntimeRole === undefined) delete process.env.POSTGRES_RUNTIME_ROLE;
      else process.env.POSTGRES_RUNTIME_ROLE = previousRuntimeRole;
      if (databaseCreated) await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
      if (runtimeCreated) await admin.unsafe(`DROP ROLE "${runtimeRole}"`);
      if (ownerCreated) await admin.unsafe(`DROP ROLE "${ownerRole}"`);
      await admin.end();
    }
  }, 30_000);
});
