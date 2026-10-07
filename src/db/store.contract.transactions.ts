import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Store } from "./store";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export function transactionContractTests(name: string, makeStore: () => Promise<Store>): void {
  describe(name, () => {
    let store: Store;
    beforeEach(async () => { store = await makeStore(); });
    afterEach(async () => { vi.restoreAllMocks(); await store.close(); });

    it("rolls back asset, interfaces, custody, setting, and audit as one asynchronous unit", async () => {
      let assetId = "";
      await expect(store.transaction(async (tx) => {
        const asset = await tx.createAssetWithInterfaces({ name: "Atomic Laptop" }, [
          { mac: "00:00:5e:00:53:01" },
        ]);
        assetId = asset.id;
        const result = await tx.appendCustodyEvent({ assetId, type: "check_out" }, "deployed");
        expect(result?.ok).toBe(true);
        await tx.setSetting("transaction-check", { success: true });
        await tx.appendAudit({ action: "asset.created", entityId: assetId });
        await Promise.resolve();
        throw new Error("audit backend unavailable");
      })).rejects.toThrow("audit backend unavailable");
      expect(await store.getAssetById(assetId)).toBeNull();
      expect(await store.listAssetInterfaces(assetId)).toEqual([]);
      expect(await store.listCustodyEvents(assetId, { limit: 10 })).toEqual([]);
      expect(await store.getSetting("transaction-check")).toBeNull();
      expect(await store.countAudit()).toBe(0);
    });

    it("rolls back nested savepoints and can continue after a constraint failure", async () => {
      await store.transaction(async (tx) => {
        await tx.createAssetWithInterfaces({ name: "Original", assetTagNorm: "ATOMIC-1" }, []);
        await expect(tx.transaction(async (nested) => {
          await nested.setSetting("rolled-back-inner", true);
          await nested.createAssetWithInterfaces({ name: "Duplicate", assetTagNorm: "ATOMIC-1" }, []);
        })).rejects.toThrow();
        expect(await tx.getSetting("rolled-back-inner")).toBeNull();
        await tx.transaction(async (nested) => {
          await nested.transaction(async (deep) => { await deep.setSetting("deeply-nested", true); });
        });
        await tx.appendAudit({ action: "transaction.recovered" });
      });
      expect(await store.countAssets({})).toBe(1);
      expect(await store.getSetting("deeply-nested")).toBe(true);
      expect(await store.countAudit()).toBe(1);
    });

    it("queues unrelated reads and writes until rollback and never joins them to an open unit", async () => {
      const started = deferred<void>();
      const release = deferred<void>();
      const transaction = store.transaction(async (tx) => {
        await tx.setSetting("uncommitted", true);
        started.resolve();
        await release.promise;
        throw new Error("rollback isolated unit");
      });
      // Attach the expected rejection before releasing to avoid unhandled promises.
      const rejected = expect(transaction).rejects.toThrow("rollback isolated unit");
      await started.promise;
      let outsideFinished = false;
      const outside = (async () => {
        const value = await store.getSetting("uncommitted");
        await store.setSetting("outside-write", true);
        outsideFinished = true;
        return value;
      })();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(outsideFinished).toBe(false);
      release.resolve();
      await rejected;
      expect(await outside).toBeNull();
      expect(await store.getSetting("outside-write")).toBe(true);
    });

    it("rejects use of a transaction store after its unit completes", async () => {
      let escaped!: Store;
      await store.transaction(async (tx) => { escaped = tx; await tx.setSetting("committed", true); });
      await expect(escaped.getSetting("committed")).rejects.toThrow("no longer active");
      await expect(escaped.transaction(async () => undefined)).rejects.toThrow("no longer active");
      expect(await store.getSetting("committed")).toBe(true);
    });

    it("derives all custody authority from sequence when timestamps move backward or tie", async () => {
      const asset = await store.createAssetWithInterfaces({ name: "Clock Laptop" }, []);
      const now = vi.spyOn(Date, "now");
      now.mockReturnValue(1900000000000);
      const first = await store.appendCustodyEvent({ assetId: asset.id, type: "check_out", holderUserId: "holder-one" }, "deployed");
      now.mockReturnValue(1800000000000);
      const second = await store.appendCustodyEvent({ assetId: asset.id, type: "check_in" }, "in_stock");
      expect(first?.ok && first.event.sequence).toBe(1);
      expect(second?.ok && second.event.sequence).toBe(2);
      expect(await store.getCurrentCustody(asset.id)).toBeNull();
      expect(await store.getCurrentCustodyForAssets([asset.id])).toEqual([]);
      expect(await store.countAssets({ heldByUserId: "holder-one" })).toBe(0);
      expect((await store.listCustodyEvents(asset.id, { limit: 1 }))[0]?.type).toBe("check_in");
      const third = await store.appendCustodyEvent({ assetId: asset.id, type: "check_out", holderUserId: "holder-two" }, "deployed");
      expect(third?.ok && third.event.sequence).toBe(3);
      expect((await store.getCurrentCustody(asset.id))?.holderUserId).toBe("holder-two");
      expect(await store.countAssets({ heldByUserId: "holder-two" })).toBe(1);
      expect((await store.listCustodyEvents(asset.id, { limit: 10 })).map((row) => row.sequence)).toEqual([3, 2, 1]);
      expect((await store.listCustodyEvents(asset.id, { limit: 1, offset: 1 }))[0]?.sequence).toBe(2);
    });

    it("applies byte ordering to complete asset and location result sets before pagination", async () => {
      const names = ["a", "Z", "A", "_first", "!first", "z", "a-first", "a first", "\u00e4", "\ud83d\ude00"];
      for (const name of names) {
        await store.createAssetWithInterfaces({ name }, []);
        await store.createLocation({ name });
      }
      const ordered = [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      const assetNames: string[] = [];
      const locationNames: string[] = [];
      for (let offset = 0; offset < names.length; offset += 2) {
        assetNames.push(...(await store.listAssets({ limit: 2, offset })).map((row) => row.name));
        locationNames.push(...(await store.listLocations({ limit: 2, offset })).map((row) => row.name));
      }
      expect(assetNames).toEqual(ordered);
      expect(locationNames).toEqual(ordered);
    });

    it("scopes identical OIDC subjects to exact issuers and leaves legacy identities unbound", async () => {
      const one = await store.createUser({ email: "issuer.one@hatcheck.test", displayName: "One", role: "readonly", authSource: "oidc", oidcSubject: "shared-subject", oidcIssuer: "https://one.identity.test" });
      const two = await store.createUser({ email: "issuer.two@hatcheck.test", displayName: "Two", role: "readonly", authSource: "oidc", oidcSubject: "shared-subject", oidcIssuer: "https://two.identity.test" });
      const legacy = await store.createUser({ email: "legacy@hatcheck.test", displayName: "Legacy", role: "readonly", authSource: "oidc", oidcSubject: "legacy-subject" });
      expect(await store.getUserByOidcSubject("shared-subject", "https://one.identity.test")).toEqual(one);
      expect(await store.getUserByOidcSubject("shared-subject", "https://two.identity.test")).toEqual(two);
      expect(await store.getUserByOidcSubject("shared-subject", "https://other.identity.test")).toBeNull();
      expect(await store.getUserByOidcSubject("legacy-subject", "https://one.identity.test")).toBeNull();
      expect(await store.getUserByOidcSubject("legacy-subject")).toEqual(legacy);
      await expect(store.createUser({ email: "duplicate@hatcheck.test", displayName: "Duplicate", role: "readonly", authSource: "oidc", oidcSubject: "shared-subject", oidcIssuer: "https://one.identity.test" })).rejects.toThrow();
    });
  });
}
