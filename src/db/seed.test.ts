import { afterEach, describe, expect, it } from "vitest";
import { createTestStore } from "../test/store";
import type { Store } from "./store";
import { seed } from "./seed";

const stores: Store[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())); });

async function fixture() {
  const store = await createTestStore();
  await store.migrate();
  stores.push(store);
  return store;
}
function failAudit(store: Store, action: string): Store {
  return {
    ...store,
    transaction: (work) => store.transaction((tx) => work({
      ...tx, appendAudit: (entry) => {
        if (entry.action === action) throw new Error("Synthetic seed audit failure");
        return tx.appendAudit(entry);
      },
    })),
  };
}

describe("audited seed transactions", () => {
  it.each(["user.create", "seed.run"])("rolls back users and settings when %s auditing fails, without printing credential handoffs", async (action) => {
    const store = await fixture();
    const existing = await store.createUser({ email: "existing@seed.hatcheck.test", displayName: "Synthetic Existing", role: "admin", authSource: "local" });
    await store.setSetting("instance", { name: "Synthetic Existing Instance" });
    const logs: string[] = [];
    await expect(seed(failAudit(store, action), { adminPassword: "synthetic-admin-password", log: (message) => logs.push(message) })).rejects.toThrow("Synthetic seed audit failure");
    expect(await store.listUsers()).toEqual([existing]);
    expect(await store.getSetting("instance")).toEqual({ name: "Synthetic Existing Instance" });
    expect(await store.countAudit()).toBe(0);
    expect(logs).toEqual([]);
  });

  it("creates audited synthetic users once and preserves existing credentials on repeat", async () => {
    const store = await fixture();
    const logs: string[] = [];
    await seed(store, { adminPassword: "synthetic-admin-password", log: (message) => logs.push(message) });
    const original = await store.getUserByEmail("admin@hatcheck.test");
    expect(await store.countUsers()).toBe(3);
    expect(await store.countAudit({ action: "user.create" })).toBe(3);
    expect(await store.countAudit({ action: "seed.run" })).toBe(1);
    expect(logs.filter((line) => line.includes("password:"))).toHaveLength(3);
    logs.length = 0;
    await seed(store, { adminPassword: "unused-second-password", log: (message) => logs.push(message) });
    expect(await store.getUserByEmail("admin@hatcheck.test")).toEqual(original);
    expect(await store.countUsers()).toBe(3);
    expect(await store.countAudit({ action: "user.create" })).toBe(3);
    expect(await store.countAudit({ action: "seed.run" })).toBe(2);
    expect(logs.every((line) => !line.includes("password:"))).toBe(true);
    for (const audit of await store.listAudit({ limit: 10 })) {
      expect(audit.details).not.toContain("synthetic-admin-password");
      expect(audit.details).not.toContain("passwordHash");
    }
  });
});
