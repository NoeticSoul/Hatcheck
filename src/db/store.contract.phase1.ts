// Phase 1 contract suite: locations, assets, interfaces, custody, imports,
// and exceptions. Invoked from store.test.ts against both engines
// (CLAUDE.md hard rule 1). The semantics under test are the doc comments
// on the Store interface in ./store.ts; every assertion here pins a
// behavior both store.sqlite.* and store.pg.ts must reproduce exactly.
//
// All fixture data is synthetic: *.test emails and MAC addresses only from
// the RFC 7042 documentation range 00:00:5e:00:53:xx.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CustodyAppendResult,
  CustodyEventRecord,
  NewAsset,
  Store,
} from "./store";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeAsset(overrides: Partial<NewAsset> = {}): NewAsset {
  return {
    name: "Spare Laptop",
    ...overrides,
  };
}

/** Narrows a custody append result to its success branch or fails loudly. */
function custodyOk(res: CustodyAppendResult | null): CustodyEventRecord {
  if (res === null || !res.ok) {
    throw new Error(
      `expected successful custody append, got ${JSON.stringify(res)}`,
    );
  }
  return res.event;
}

export function phase1ContractTests(
  name: string,
  makeStore: () => Promise<Store>,
): void {
  describe(name, () => {
    let store: Store;

    beforeEach(async () => {
      store = await makeStore();
    });

    afterEach(async () => {
      await store.close();
    });

    describe("locations", () => {
      it("creates a location with defaults and reads it back", async () => {
        const loc = await store.createLocation({ name: "Room 101" });
        expect(loc.id).toBeTruthy();
        expect(loc.name).toBe("Room 101");
        expect(loc.kind).toBe("room");
        expect(loc.parentId).toBeNull();
        expect(loc.description).toBeNull();
        expect(loc.isActive).toBe(true);
        expect(loc.createdAt).toBeGreaterThan(0);
        expect(loc.updatedAt).toBe(loc.createdAt);
        expect(await store.getLocationById(loc.id)).toEqual(loc);
      });

      it("creates a location with explicit values", async () => {
        const site = await store.createLocation({
          name: "North Campus",
          kind: "site",
        });
        const annex = await store.createLocation({
          name: "Annex",
          kind: "building",
          parentId: site.id,
          description: "Overflow storage",
          isActive: false,
        });
        expect(annex.kind).toBe("building");
        expect(annex.parentId).toBe(site.id);
        expect(annex.description).toBe("Overflow storage");
        expect(annex.isActive).toBe(false);
        expect(await store.getLocationById(annex.id)).toEqual(annex);
      });

      it("returns null for a missing location id", async () => {
        expect(await store.getLocationById("missing-id")).toBeNull();
      });

      it("rejects a duplicate sibling name under the same parent", async () => {
        const site = await store.createLocation({
          name: "North Campus",
          kind: "site",
        });
        await store.createLocation({ name: "Annex", parentId: site.id });
        await expect(
          store.createLocation({ name: "Annex", parentId: site.id }),
        ).rejects.toThrow();
      });

      it("rejects two root locations with the same name (partial-index backstop)", async () => {
        // NULLs are distinct in the (parent_id, name) unique index on both
        // engines, so a dedicated partial unique index on name WHERE
        // parent_id IS NULL backs up the service-layer pre-check; without
        // it a check-then-insert race could persist duplicate roots.
        await store.createLocation({ name: "Annex" });
        await expect(store.createLocation({ name: "Annex" })).rejects.toThrow();
        expect(await store.countLocations({ parentId: null })).toBe(1);
        // Same name under a parent remains fine.
        const site = await store.createLocation({ name: "Campus", kind: "site" });
        const nested = await store.createLocation({
          name: "Annex",
          parentId: site.id,
        });
        expect(nested.parentId).toBe(site.id);
      });

      it("filters by parentId: undefined, null, and a concrete value", async () => {
        const site = await store.createLocation({
          name: "North Campus",
          kind: "site",
        });
        const dock = await store.createLocation({ name: "Loading Dock" });
        const annex = await store.createLocation({
          name: "Annex",
          kind: "building",
          parentId: site.id,
        });

        const any = await store.listLocations({ limit: 10 });
        expect(new Set(any.map((l) => l.id))).toEqual(
          new Set([site.id, dock.id, annex.id]),
        );

        const roots = await store.listLocations({ limit: 10, parentId: null });
        expect(new Set(roots.map((l) => l.id))).toEqual(
          new Set([site.id, dock.id]),
        );

        const children = await store.listLocations({
          limit: 10,
          parentId: site.id,
        });
        expect(children.map((l) => l.id)).toEqual([annex.id]);

        expect(await store.countLocations({})).toBe(3);
        expect(await store.countLocations({ parentId: null })).toBe(2);
        expect(await store.countLocations({ parentId: site.id })).toBe(1);
      });

      it("filters by kind and by case-insensitive substring", async () => {
        const site = await store.createLocation({
          name: "North Campus",
          kind: "site",
        });
        const annex = await store.createLocation({
          name: "Annex",
          kind: "building",
          parentId: site.id,
        });
        const room = await store.createLocation({
          name: "Room 101",
          parentId: annex.id,
        });

        const buildings = await store.listLocations({
          limit: 10,
          kind: "building",
        });
        expect(buildings.map((l) => l.id)).toEqual([annex.id]);
        expect(await store.countLocations({ kind: "building" })).toBe(1);

        // ASCII-case-insensitive substring on name.
        const found = await store.listLocations({ limit: 10, q: "aNNex" });
        expect(found.map((l) => l.id)).toEqual([annex.id]);
        expect(await store.countLocations({ q: "aNNex" })).toBe(1);

        const rooms = await store.listLocations({ limit: 10, q: "room" });
        expect(rooms.map((l) => l.id)).toEqual([room.id]);

        expect(await store.listLocations({ limit: 10, q: "atrium" })).toEqual(
          [],
        );
      });

      it("excludes inactive locations unless includeInactive is set", async () => {
        const active = await store.createLocation({ name: "Room 101" });
        const inactive = await store.createLocation({
          name: "Old Server Closet",
          isActive: false,
        });

        const defaults = await store.listLocations({ limit: 10 });
        expect(defaults.map((l) => l.id)).toEqual([active.id]);
        expect(await store.countLocations({})).toBe(1);

        const all = await store.listLocations({
          limit: 10,
          includeInactive: true,
        });
        expect(new Set(all.map((l) => l.id))).toEqual(
          new Set([active.id, inactive.id]),
        );
        expect(await store.countLocations({ includeInactive: true })).toBe(2);

        // Filters compose with includeInactive.
        expect(await store.listLocations({ limit: 10, q: "closet" })).toEqual(
          [],
        );
        const closets = await store.listLocations({
          limit: 10,
          q: "closet",
          includeInactive: true,
        });
        expect(closets.map((l) => l.id)).toEqual([inactive.id]);
      });

      it("paginates locations consistently with countLocations", async () => {
        const created: string[] = [];
        for (let i = 1; i <= 5; i++) {
          const loc = await store.createLocation({ name: `Room ${i}` });
          created.push(loc.id);
        }
        // Ordering is engine-defined but must be stable: pages are
        // disjoint and their union is the full set.
        const pageA = await store.listLocations({ limit: 2 });
        const pageB = await store.listLocations({ limit: 2, offset: 2 });
        const pageC = await store.listLocations({ limit: 2, offset: 4 });
        expect(pageA).toHaveLength(2);
        expect(pageB).toHaveLength(2);
        expect(pageC).toHaveLength(1);
        const ids = [...pageA, ...pageB, ...pageC].map((l) => l.id);
        expect(new Set(ids).size).toBe(5);
        expect(new Set(ids)).toEqual(new Set(created));
        expect(await store.countLocations({})).toBe(5);
      });

      it("counts direct children only", async () => {
        const site = await store.createLocation({
          name: "North Campus",
          kind: "site",
        });
        const annex = await store.createLocation({
          name: "Annex",
          kind: "building",
          parentId: site.id,
        });
        await store.createLocation({
          name: "Depot",
          kind: "building",
          parentId: site.id,
        });
        await store.createLocation({ name: "Room 101", parentId: annex.id });
        expect(await store.countLocationChildren(site.id)).toBe(2);
        expect(await store.countLocationChildren(annex.id)).toBe(1);
        expect(await store.countLocationChildren("missing-id")).toBe(0);
      });

      it("patches a location and bumps updatedAt", async () => {
        const site = await store.createLocation({
          name: "North Campus",
          kind: "site",
        });
        const room = await store.createLocation({ name: "Room 101" });
        await sleep(5);
        const updated = await store.updateLocation(room.id, {
          name: "Room 102",
          parentId: site.id,
          description: "Renumbered",
          isActive: false,
        });
        expect(updated).not.toBeNull();
        expect(updated?.name).toBe("Room 102");
        expect(updated?.kind).toBe("room");
        expect(updated?.parentId).toBe(site.id);
        expect(updated?.description).toBe("Renumbered");
        expect(updated?.isActive).toBe(false);
        expect(updated?.createdAt).toBe(room.createdAt);
        expect(updated?.updatedAt).toBeGreaterThan(room.updatedAt);
        expect(await store.getLocationById(room.id)).toEqual(updated);
      });

      it("updateLocation returns null for a missing id", async () => {
        expect(
          await store.updateLocation("missing-id", { name: "Nowhere" }),
        ).toBeNull();
      });

      it("deletes a leaf location and returns false for a missing one", async () => {
        const leaf = await store.createLocation({ name: "Spare Room" });
        expect(await store.deleteLocation(leaf.id)).toBe(true);
        expect(await store.getLocationById(leaf.id)).toBeNull();
        expect(await store.deleteLocation(leaf.id)).toBe(false);
      });

      it("refuses to delete a location with a child location", async () => {
        const site = await store.createLocation({
          name: "North Campus",
          kind: "site",
        });
        await store.createLocation({ name: "Annex", parentId: site.id });
        await expect(store.deleteLocation(site.id)).rejects.toThrow();
        expect(await store.getLocationById(site.id)).not.toBeNull();
      });

      it("refuses to delete a location referenced by an asset", async () => {
        const room = await store.createLocation({ name: "Room 101" });
        await store.createAssetWithInterfaces(
          makeAsset({ locationId: room.id }),
          [],
        );
        await expect(store.deleteLocation(room.id)).rejects.toThrow();
        expect(await store.getLocationById(room.id)).not.toBeNull();
      });
    });

    describe("assets", () => {
      it("creates an asset with no interfaces and default fields", async () => {
        const asset = await store.createAssetWithInterfaces(
          makeAsset(),
          [],
        );
        expect(asset.id).toBeTruthy();
        expect(asset.name).toBe("Spare Laptop");
        expect(asset.assetType).toBe("device");
        expect(asset.status).toBe("in_stock");
        expect(asset.locationId).toBeNull();
        expect(asset.model).toBeNull();
        expect(asset.manufacturer).toBeNull();
        expect(asset.notes).toBeNull();
        expect(asset.assetTag).toBeNull();
        expect(asset.assetTagNorm).toBeNull();
        expect(asset.serialNumber).toBeNull();
        expect(asset.serialNumberNorm).toBeNull();
        expect(asset.systemUuid).toBeNull();
        expect(asset.systemUuidNorm).toBeNull();
        expect(asset.createdAt).toBeGreaterThan(0);
        expect(asset.updatedAt).toBe(asset.createdAt);
        expect(await store.getAssetById(asset.id)).toEqual(asset);
        expect(await store.listAssetInterfaces(asset.id)).toEqual([]);
      });

      it("creates an asset together with two interfaces", async () => {
        const asset = await store.createAssetWithInterfaces(
          makeAsset({ name: "Loaner Laptop" }),
          [
            { mac: "00:00:5e:00:53:01", label: "onboard" },
            { mac: "00:00:5e:00:53:02" },
          ],
        );
        const ifaces = await store.listAssetInterfaces(asset.id);
        expect(ifaces).toHaveLength(2);
        for (const iface of ifaces) {
          expect(iface.id).toBeTruthy();
          expect(iface.assetId).toBe(asset.id);
          expect(iface.createdAt).toBeGreaterThan(0);
        }
        expect(new Set(ifaces.map((i) => i.mac))).toEqual(
          new Set(["00:00:5e:00:53:01", "00:00:5e:00:53:02"]),
        );
        expect(
          ifaces.find((i) => i.mac === "00:00:5e:00:53:01")?.label,
        ).toBe("onboard");
        expect(
          ifaces.find((i) => i.mac === "00:00:5e:00:53:02")?.label,
        ).toBeNull();
      });

      it("rolls back interfaces when the asset row collides (atomicity)", async () => {
        const original = await store.createAssetWithInterfaces(
          makeAsset({
            name: "Original Laptop",
            serialNumber: "sn-alpha-01",
            serialNumberNorm: "SN-ALPHA-01",
          }),
          [{ mac: "00:00:5e:00:53:0a" }],
        );
        await expect(
          store.createAssetWithInterfaces(
            makeAsset({
              name: "Colliding Laptop",
              serialNumberNorm: "SN-ALPHA-01",
            }),
            [{ mac: "00:00:5e:00:53:0b" }, { mac: "00:00:5e:00:53:0c" }],
          ),
        ).rejects.toThrow();
        // No second asset row exists...
        expect(await store.countAssets({})).toBe(1);
        expect(
          await store.getAssetByIdentityKey("serialNumberNorm", "SN-ALPHA-01"),
        ).toEqual(original);
        // ...and no interface rows leaked: interfaces FK to assets (the FK
        // enforcement is proven by the deleteLocation restrict tests), so
        // with the colliding asset row absent its interfaces cannot exist.
        // The surviving asset's interface list is untouched.
        const ifaces = await store.listAssetInterfaces(original.id);
        expect(ifaces.map((i) => i.mac)).toEqual(["00:00:5e:00:53:0a"]);
      });

      it("allows multiple assets with all-null identity keys (NULL-distinct)", async () => {
        await store.createAssetWithInterfaces(
          makeAsset({ name: "Mystery Box 1" }),
          [],
        );
        await store.createAssetWithInterfaces(
          makeAsset({ name: "Mystery Box 2" }),
          [],
        );
        expect(await store.countAssets({})).toBe(2);
      });

      it("rejects duplicates on each normalized identity key", async () => {
        await store.createAssetWithInterfaces(
          makeAsset({
            name: "Keyed Asset",
            assetTagNorm: "IT-0001",
            serialNumberNorm: "SN-ALPHA-01",
            systemUuidNorm: "9f8e7d6c-1234-4abc-8def-000000000001",
          }),
          [],
        );
        await expect(
          store.createAssetWithInterfaces(
            makeAsset({ assetTagNorm: "IT-0001" }),
            [],
          ),
        ).rejects.toThrow();
        await expect(
          store.createAssetWithInterfaces(
            makeAsset({ serialNumberNorm: "SN-ALPHA-01" }),
            [],
          ),
        ).rejects.toThrow();
        await expect(
          store.createAssetWithInterfaces(
            makeAsset({
              systemUuidNorm: "9f8e7d6c-1234-4abc-8def-000000000001",
            }),
            [],
          ),
        ).rejects.toThrow();
        expect(await store.countAssets({})).toBe(1);
      });

      it("looks up assets by each identity key", async () => {
        const asset = await store.createAssetWithInterfaces(
          makeAsset({
            name: "Front Desk Laptop",
            assetTag: "it-0001",
            assetTagNorm: "IT-0001",
            serialNumber: "sn-alpha-01",
            serialNumberNorm: "SN-ALPHA-01",
            systemUuid: "9F8E7D6C-1234-4ABC-8DEF-000000000001",
            systemUuidNorm: "9f8e7d6c-1234-4abc-8def-000000000001",
          }),
          [],
        );
        expect(
          await store.getAssetByIdentityKey("assetTagNorm", "IT-0001"),
        ).toEqual(asset);
        expect(
          await store.getAssetByIdentityKey("serialNumberNorm", "SN-ALPHA-01"),
        ).toEqual(asset);
        expect(
          await store.getAssetByIdentityKey(
            "systemUuidNorm",
            "9f8e7d6c-1234-4abc-8def-000000000001",
          ),
        ).toEqual(asset);
        expect(
          await store.getAssetByIdentityKey("assetTagNorm", "IT-9999"),
        ).toBeNull();
        expect(
          await store.getAssetByIdentityKey("serialNumberNorm", "SN-NOPE"),
        ).toBeNull();
        expect(
          await store.getAssetByIdentityKey("systemUuidNorm", "no-such-uuid"),
        ).toBeNull();
      });

      it("filters assets by status, location, type, and q", async () => {
        const room = await store.createLocation({ name: "Room 101" });
        const laptop = await store.createAssetWithInterfaces(
          makeAsset({
            name: "Front Desk Laptop",
            model: "NL-Book 14",
            manufacturer: "Northlight",
            assetTag: "it-0001",
            assetTagNorm: "IT-0001",
            serialNumber: "sn-alpha-01",
            serialNumberNorm: "SN-ALPHA-01",
            status: "deployed",
            locationId: room.id,
          }),
          [],
        );
        const projector = await store.createAssetWithInterfaces(
          makeAsset({
            name: "Conference Projector",
            model: "QV-200",
            manufacturer: "Quorvex",
            assetType: "peripheral",
          }),
          [],
        );
        const license = await store.createAssetWithInterfaces(
          makeAsset({ name: "Office Suite License", assetType: "license" }),
          [],
        );

        const deployed = await store.listAssets({
          limit: 10,
          status: "deployed",
        });
        expect(deployed.map((a) => a.id)).toEqual([laptop.id]);
        expect(await store.countAssets({ status: "deployed" })).toBe(1);

        const inRoom = await store.listAssets({
          limit: 10,
          locationId: room.id,
        });
        expect(inRoom.map((a) => a.id)).toEqual([laptop.id]);
        expect(await store.countAssets({ locationId: room.id })).toBe(1);

        const peripherals = await store.listAssets({
          limit: 10,
          assetType: "peripheral",
        });
        expect(peripherals.map((a) => a.id)).toEqual([projector.id]);

        const inStockLicenses = await store.listAssets({
          limit: 10,
          status: "in_stock",
          assetType: "license",
        });
        expect(inStockLicenses.map((a) => a.id)).toEqual([license.id]);

        // q matches each of name, model, manufacturer, assetTag, and
        // serialNumber, ASCII-case-insensitively.
        const byName = await store.listAssets({ limit: 10, q: "FRONT desk" });
        expect(byName.map((a) => a.id)).toEqual([laptop.id]);
        const byModel = await store.listAssets({ limit: 10, q: "nl-BOOK" });
        expect(byModel.map((a) => a.id)).toEqual([laptop.id]);
        const byMaker = await store.listAssets({ limit: 10, q: "quorvex" });
        expect(byMaker.map((a) => a.id)).toEqual([projector.id]);
        const byTag = await store.listAssets({ limit: 10, q: "IT-0001" });
        expect(byTag.map((a) => a.id)).toEqual([laptop.id]);
        const bySerial = await store.listAssets({ limit: 10, q: "sn-alpha" });
        expect(bySerial.map((a) => a.id)).toEqual([laptop.id]);
        expect(await store.countAssets({ q: "sn-alpha" })).toBe(1);
        expect(await store.listAssets({ limit: 10, q: "zzz-none" })).toEqual(
          [],
        );
      });

      it("paginates assets consistently with countAssets", async () => {
        const created: string[] = [];
        for (let i = 1; i <= 5; i++) {
          const asset = await store.createAssetWithInterfaces(
            makeAsset({ name: `Cart Laptop ${i}` }),
            [],
          );
          created.push(asset.id);
        }
        const pageA = await store.listAssets({ limit: 2 });
        const pageB = await store.listAssets({ limit: 2, offset: 2 });
        const pageC = await store.listAssets({ limit: 2, offset: 4 });
        expect(pageA).toHaveLength(2);
        expect(pageB).toHaveLength(2);
        expect(pageC).toHaveLength(1);
        const ids = [...pageA, ...pageB, ...pageC].map((a) => a.id);
        expect(new Set(ids).size).toBe(5);
        expect(new Set(ids)).toEqual(new Set(created));
        expect(await store.countAssets({})).toBe(5);
      });

      it("patches an asset and bumps updatedAt", async () => {
        const room = await store.createLocation({ name: "Room 101" });
        const asset = await store.createAssetWithInterfaces(makeAsset(), []);
        await sleep(5);
        const updated = await store.updateAsset(asset.id, {
          name: "Renamed Laptop",
          status: "in_repair",
          locationId: room.id,
          model: "NL-Book 14",
          notes: "screen flicker",
        });
        expect(updated).not.toBeNull();
        expect(updated?.name).toBe("Renamed Laptop");
        expect(updated?.status).toBe("in_repair");
        expect(updated?.locationId).toBe(room.id);
        expect(updated?.model).toBe("NL-Book 14");
        expect(updated?.notes).toBe("screen flicker");
        expect(updated?.createdAt).toBe(asset.createdAt);
        expect(updated?.updatedAt).toBeGreaterThan(asset.updatedAt);
        expect(await store.getAssetById(asset.id)).toEqual(updated);
      });

      it("updateAsset returns null for a missing id", async () => {
        expect(
          await store.updateAsset("missing-id", { name: "Nobody" }),
        ).toBeNull();
      });

      it("updateAsset statusNot guard blocks the write when the status matches", async () => {
        // The guard closes the read-then-write race: a PATCH prepared
        // against an in_stock asset must not land after a concurrent
        // check-out has set the status to deployed.
        const asset = await store.createAssetWithInterfaces(
          makeAsset({ name: "Guarded Laptop" }),
          [],
        );
        const out = await store.appendCustodyEvent(
          { assetId: asset.id, type: "check_out", holderName: "Kai Holder" },
          "deployed",
        );
        expect(out !== null && out.ok).toBe(true);

        const blocked = await store.updateAsset(
          asset.id,
          { status: "retired" },
          { statusNot: "deployed" },
        );
        expect(blocked).toBeNull();
        expect((await store.getAssetById(asset.id))?.status).toBe("deployed");

        // Guard passes once the status no longer matches.
        await store.appendCustodyEvent(
          { assetId: asset.id, type: "check_in" },
          "in_stock",
        );
        const allowed = await store.updateAsset(
          asset.id,
          { status: "retired" },
          { statusNot: "deployed" },
        );
        expect(allowed?.status).toBe("retired");
      });

      it("clearing an identity key frees the value for another asset", async () => {
        const first = await store.createAssetWithInterfaces(
          makeAsset({
            name: "First Holder",
            serialNumber: "sn-alpha-01",
            serialNumberNorm: "SN-ALPHA-01",
          }),
          [],
        );
        const cleared = await store.updateAsset(first.id, {
          serialNumber: null,
          serialNumberNorm: null,
        });
        expect(cleared?.serialNumber).toBeNull();
        expect(cleared?.serialNumberNorm).toBeNull();
        const second = await store.createAssetWithInterfaces(
          makeAsset({
            name: "Second Holder",
            serialNumber: "SN-ALPHA-01",
            serialNumberNorm: "SN-ALPHA-01",
          }),
          [],
        );
        expect(
          await store.getAssetByIdentityKey("serialNumberNorm", "SN-ALPHA-01"),
        ).toEqual(second);
      });

      it("deleteAsset cascades interfaces and custody events", async () => {
        const asset = await store.createAssetWithInterfaces(
          makeAsset({ name: "Doomed Laptop" }),
          [{ mac: "00:00:5e:00:53:20" }],
        );
        custodyOk(
          await store.appendCustodyEvent({
            assetId: asset.id,
            type: "check_out",
            holderName: "Taylor Tech",
          }),
        );
        expect(await store.countCustodyEvents(asset.id)).toBe(1);

        expect(await store.deleteAsset(asset.id)).toBe(true);
        expect(await store.getAssetById(asset.id)).toBeNull();
        expect(await store.listAssetInterfaces(asset.id)).toEqual([]);
        expect(
          await store.listCustodyEvents(asset.id, { limit: 10 }),
        ).toEqual([]);
        expect(await store.countCustodyEvents(asset.id)).toBe(0);
        expect(await store.deleteAsset(asset.id)).toBe(false);
      });
    });

    describe("asset interfaces", () => {
      it("adds an interface and returns null for a missing asset", async () => {
        const asset = await store.createAssetWithInterfaces(makeAsset(), []);
        const iface = await store.addAssetInterface(asset.id, {
          mac: "00:00:5e:00:53:10",
          label: "dock",
        });
        expect(iface).not.toBeNull();
        expect(iface?.id).toBeTruthy();
        expect(iface?.assetId).toBe(asset.id);
        expect(iface?.mac).toBe("00:00:5e:00:53:10");
        expect(iface?.label).toBe("dock");
        expect(iface?.createdAt).toBeGreaterThan(0);
        expect(await store.listAssetInterfaces(asset.id)).toEqual([iface]);

        expect(
          await store.addAssetInterface("missing-id", {
            mac: "00:00:5e:00:53:11",
          }),
        ).toBeNull();
      });

      it("lists interfaces in insertion order", async () => {
        const asset = await store.createAssetWithInterfaces(makeAsset(), []);
        // Sleeps guarantee distinct createdAt values so the ordering is
        // deterministic across engines.
        await store.addAssetInterface(asset.id, { mac: "00:00:5e:00:53:31" });
        await sleep(5);
        await store.addAssetInterface(asset.id, { mac: "00:00:5e:00:53:32" });
        await sleep(5);
        await store.addAssetInterface(asset.id, { mac: "00:00:5e:00:53:33" });
        const ifaces = await store.listAssetInterfaces(asset.id);
        expect(ifaces.map((i) => i.mac)).toEqual([
          "00:00:5e:00:53:31",
          "00:00:5e:00:53:32",
          "00:00:5e:00:53:33",
        ]);
      });

      it("deletes an interface and returns false when already gone", async () => {
        const asset = await store.createAssetWithInterfaces(makeAsset(), [
          { mac: "00:00:5e:00:53:40" },
          { mac: "00:00:5e:00:53:41" },
        ]);
        const ifaces = await store.listAssetInterfaces(asset.id);
        const target = ifaces.find((i) => i.mac === "00:00:5e:00:53:40");
        expect(target).toBeDefined();
        if (!target) throw new Error("interface not found");
        expect(await store.deleteAssetInterface(target.id)).toBe(true);
        const remaining = await store.listAssetInterfaces(asset.id);
        expect(remaining.map((i) => i.mac)).toEqual(["00:00:5e:00:53:41"]);
        expect(await store.deleteAssetInterface(target.id)).toBe(false);
        expect(await store.deleteAssetInterface("missing-id")).toBe(false);
      });

      it("allows the same MAC on two different assets", async () => {
        // MAC index is deliberately non-unique (docks repeat) and MAC is
        // never an identity key.
        const alpha = await store.createAssetWithInterfaces(
          makeAsset({ name: "Laptop Alpha" }),
          [],
        );
        const beta = await store.createAssetWithInterfaces(
          makeAsset({ name: "Laptop Beta" }),
          [],
        );
        const onAlpha = await store.addAssetInterface(alpha.id, {
          mac: "00:00:5e:00:53:50",
          label: "shared dock",
        });
        const onBeta = await store.addAssetInterface(beta.id, {
          mac: "00:00:5e:00:53:50",
          label: "shared dock",
        });
        expect(onAlpha).not.toBeNull();
        expect(onBeta).not.toBeNull();
        expect(onAlpha?.id).not.toBe(onBeta?.id);
      });
    });

    describe("custody", () => {
      it("checks out a fresh asset and records the full snapshot", async () => {
        const room = await store.createLocation({ name: "Room 101" });
        const asset = await store.createAssetWithInterfaces(makeAsset(), []);
        const res = await store.appendCustodyEvent({
          assetId: asset.id,
          type: "check_out",
          holderUserId: "user-1",
          holderName: "Taylor Tech",
          locationId: room.id,
          locationName: "Room 101",
          note: "loaner for the week",
          actorUserId: "user-9",
          actorEmail: "admin@hatcheck.test",
        });
        const event = custodyOk(res);
        expect(event.id).toBeTruthy();
        expect(event.assetId).toBe(asset.id);
        expect(event.at).toBeGreaterThan(0);
        expect(event.type).toBe("check_out");
        expect(event.holderUserId).toBe("user-1");
        expect(event.holderName).toBe("Taylor Tech");
        expect(event.locationId).toBe(room.id);
        expect(event.locationName).toBe("Room 101");
        expect(event.note).toBe("loaner for the week");
        expect(event.actorUserId).toBe("user-9");
        expect(event.actorEmail).toBe("admin@hatcheck.test");
        expect(await store.getCurrentCustody(asset.id)).toEqual(event);
      });

      it("defaults optional custody fields to null", async () => {
        const asset = await store.createAssetWithInterfaces(makeAsset(), []);
        const event = custodyOk(
          await store.appendCustodyEvent({
            assetId: asset.id,
            type: "check_out",
          }),
        );
        expect(event.holderUserId).toBeNull();
        expect(event.holderName).toBeNull();
        expect(event.locationId).toBeNull();
        expect(event.locationName).toBeNull();
        expect(event.note).toBeNull();
        expect(event.actorUserId).toBeNull();
        expect(event.actorEmail).toBeNull();
      });

      it("enforces the check_out/check_in alternation matrix", async () => {
        const asset = await store.createAssetWithInterfaces(makeAsset(), []);

        // check_in on a never-touched asset.
        expect(
          await store.appendCustodyEvent({
            assetId: asset.id,
            type: "check_in",
          }),
        ).toEqual({ ok: false, conflict: "not_checked_out" });

        // First check_out succeeds.
        custodyOk(
          await store.appendCustodyEvent({
            assetId: asset.id,
            type: "check_out",
          }),
        );

        // Second check_out conflicts.
        expect(
          await store.appendCustodyEvent({
            assetId: asset.id,
            type: "check_out",
          }),
        ).toEqual({ ok: false, conflict: "already_checked_out" });

        // check_in succeeds.
        custodyOk(
          await store.appendCustodyEvent({
            assetId: asset.id,
            type: "check_in",
          }),
        );

        // Second check_in conflicts.
        expect(
          await store.appendCustodyEvent({
            assetId: asset.id,
            type: "check_in",
          }),
        ).toEqual({ ok: false, conflict: "not_checked_out" });

        // Conflicts never wrote events.
        expect(await store.countCustodyEvents(asset.id)).toBe(2);
      });

      it("returns null for a nonexistent asset", async () => {
        expect(
          await store.appendCustodyEvent({
            assetId: "missing-id",
            type: "check_out",
          }),
        ).toBeNull();
        expect(
          await store.appendCustodyEvent({
            assetId: "missing-id",
            type: "check_in",
          }),
        ).toBeNull();
      });

      it("updates asset status atomically with the event", async () => {
        const asset = await store.createAssetWithInterfaces(makeAsset(), []);
        expect(asset.status).toBe("in_stock");

        custodyOk(
          await store.appendCustodyEvent(
            { assetId: asset.id, type: "check_out", holderName: "Taylor Tech" },
            "deployed",
          ),
        );
        expect((await store.getAssetById(asset.id))?.status).toBe("deployed");

        // A conflicting append must not write the status either.
        expect(
          await store.appendCustodyEvent(
            { assetId: asset.id, type: "check_out" },
            "in_repair",
          ),
        ).toEqual({ ok: false, conflict: "already_checked_out" });
        expect((await store.getAssetById(asset.id))?.status).toBe("deployed");

        custodyOk(
          await store.appendCustodyEvent(
            { assetId: asset.id, type: "check_in" },
            "in_stock",
          ),
        );
        expect((await store.getAssetById(asset.id))?.status).toBe("in_stock");
      });

      it("leaves asset status untouched when newAssetStatus is omitted", async () => {
        const asset = await store.createAssetWithInterfaces(makeAsset(), []);
        custodyOk(
          await store.appendCustodyEvent({
            assetId: asset.id,
            type: "check_out",
          }),
        );
        expect((await store.getAssetById(asset.id))?.status).toBe("in_stock");
      });

      it("derives current custody from the event stream", async () => {
        const asset = await store.createAssetWithInterfaces(makeAsset(), []);
        expect(await store.getCurrentCustody(asset.id)).toBeNull();
        const out = custodyOk(
          await store.appendCustodyEvent({
            assetId: asset.id,
            type: "check_out",
            holderName: "Taylor Tech",
          }),
        );
        expect(await store.getCurrentCustody(asset.id)).toEqual(out);
        custodyOk(
          await store.appendCustodyEvent({
            assetId: asset.id,
            type: "check_in",
          }),
        );
        expect(await store.getCurrentCustody(asset.id)).toBeNull();
        const again = custodyOk(
          await store.appendCustodyEvent({
            assetId: asset.id,
            type: "check_out",
            holderName: "Rowan Report",
          }),
        );
        expect(await store.getCurrentCustody(asset.id)).toEqual(again);
        expect(await store.getCurrentCustody("missing-id")).toBeNull();
      });

      it("keeps a same-millisecond burst fully ordered and complete", async () => {
        // Gate-criterion evidence: an append-only stream where nothing is
        // overwritten, ordered by time-ordered ids even when many events
        // share one millisecond timestamp.
        const asset = await store.createAssetWithInterfaces(makeAsset(), []);
        const appended: CustodyEventRecord[] = [];
        for (let i = 0; i < 25; i++) {
          appended.push(
            custodyOk(
              await store.appendCustodyEvent({
                assetId: asset.id,
                type: "check_out",
                holderName: `Holder ${i}`,
              }),
            ),
          );
          appended.push(
            custodyOk(
              await store.appendCustodyEvent({
                assetId: asset.id,
                type: "check_in",
              }),
            ),
          );
        }
        // Ids are strictly increasing in generation order.
        let prev = "";
        for (const event of appended) {
          expect(event.id > prev).toBe(true);
          prev = event.id;
        }
        // Nothing was overwritten and listing is newest-first.
        expect(await store.countCustodyEvents(asset.id)).toBe(50);
        const listed = await store.listCustodyEvents(asset.id, { limit: 100 });
        expect(listed.map((e) => e.id)).toEqual(
          [...appended].reverse().map((e) => e.id),
        );
        expect(await store.getCurrentCustody(asset.id)).toBeNull();
      });

      it("paginates custody events per asset", async () => {
        const asset = await store.createAssetWithInterfaces(makeAsset(), []);
        const other = await store.createAssetWithInterfaces(
          makeAsset({ name: "Other Laptop" }),
          [],
        );
        for (let i = 0; i < 6; i++) {
          custodyOk(
            await store.appendCustodyEvent({
              assetId: asset.id,
              type: "check_out",
            }),
          );
          custodyOk(
            await store.appendCustodyEvent({
              assetId: asset.id,
              type: "check_in",
            }),
          );
        }
        custodyOk(
          await store.appendCustodyEvent({
            assetId: other.id,
            type: "check_out",
          }),
        );

        expect(await store.countCustodyEvents(asset.id)).toBe(12);
        expect(await store.countCustodyEvents(other.id)).toBe(1);
        const full = await store.listCustodyEvents(asset.id, { limit: 100 });
        expect(full).toHaveLength(12);
        const page = await store.listCustodyEvents(asset.id, {
          limit: 4,
          offset: 3,
        });
        expect(page).toEqual(full.slice(3, 7));
      });

      it("returns current custody for exactly the held assets in a batch", async () => {
        const held = await store.createAssetWithInterfaces(
          makeAsset({ name: "Held Laptop" }),
          [],
        );
        const alsoHeld = await store.createAssetWithInterfaces(
          makeAsset({ name: "Also Held Laptop" }),
          [],
        );
        const released = await store.createAssetWithInterfaces(
          makeAsset({ name: "Released Laptop" }),
          [],
        );
        const idle = await store.createAssetWithInterfaces(
          makeAsset({ name: "Idle Laptop" }),
          [],
        );
        const heldEvent = custodyOk(
          await store.appendCustodyEvent({
            assetId: held.id,
            type: "check_out",
            holderName: "Taylor Tech",
          }),
        );
        const alsoHeldEvent = custodyOk(
          await store.appendCustodyEvent({
            assetId: alsoHeld.id,
            type: "check_out",
            holderName: "Rowan Report",
          }),
        );
        custodyOk(
          await store.appendCustodyEvent({
            assetId: released.id,
            type: "check_out",
          }),
        );
        custodyOk(
          await store.appendCustodyEvent({
            assetId: released.id,
            type: "check_in",
          }),
        );

        const events = await store.getCurrentCustodyForAssets([
          held.id,
          alsoHeld.id,
          released.id,
          idle.id,
          "missing-id",
        ]);
        expect(events).toHaveLength(2);
        const byAsset = new Map(events.map((e) => [e.assetId, e]));
        expect(byAsset.get(held.id)).toEqual(heldEvent);
        expect(byAsset.get(alsoHeld.id)).toEqual(alsoHeldEvent);

        expect(await store.getCurrentCustodyForAssets([])).toEqual([]);
      });
    });

    describe("imports", () => {
      it("creates a job as running with zeroed counts", async () => {
        const job = await store.createImportJob({
          fileHash: "hash-alpha",
          mode: "commit",
          filename: "assets.csv",
          actorEmail: "admin@hatcheck.test",
        });
        expect(job.id).toBeTruthy();
        expect(job.at).toBeGreaterThan(0);
        expect(job.status).toBe("running");
        expect(job.mode).toBe("commit");
        expect(job.fileHash).toBe("hash-alpha");
        expect(job.filename).toBe("assets.csv");
        expect(job.actorUserId).toBeNull();
        expect(job.actorEmail).toBe("admin@hatcheck.test");
        expect(job.totalRows).toBe(0);
        expect(job.createdCount).toBe(0);
        expect(job.skippedCount).toBe(0);
        expect(job.collisionCount).toBe(0);
        expect(job.errorCount).toBe(0);
        expect(await store.getImportJobById(job.id)).toEqual(job);
        expect(await store.getImportJobById("missing-id")).toBeNull();
      });

      it("completes a job with final counts and status", async () => {
        const job = await store.createImportJob({
          fileHash: "hash-alpha",
          mode: "commit",
        });
        const done = await store.completeImportJob(job.id, {
          status: "completed",
          totalRows: 5,
          createdCount: 3,
          skippedCount: 1,
          collisionCount: 1,
          errorCount: 0,
        });
        expect(done).not.toBeNull();
        expect(done?.status).toBe("completed");
        expect(done?.totalRows).toBe(5);
        expect(done?.createdCount).toBe(3);
        expect(done?.skippedCount).toBe(1);
        expect(done?.collisionCount).toBe(1);
        expect(done?.errorCount).toBe(0);
        expect(await store.getImportJobById(job.id)).toEqual(done);

        expect(
          await store.completeImportJob("missing-id", {
            status: "failed",
            totalRows: 0,
            createdCount: 0,
            skippedCount: 0,
            collisionCount: 0,
            errorCount: 0,
          }),
        ).toBeNull();
      });

      it("round-trips the raw row payload as JSON", async () => {
        const job = await store.createImportJob({
          fileHash: "hash-alpha",
          mode: "dry_run",
        });
        const raw = { name: "Loaner Laptop", serial: "SN-ALPHA-77" };
        const row = await store.appendImportRow({
          jobId: job.id,
          rowNumber: 1,
          outcome: "created",
          raw,
        });
        expect(row.id).toBeTruthy();
        expect(row.jobId).toBe(job.id);
        expect(row.rowNumber).toBe(1);
        expect(row.outcome).toBe("created");
        expect(row.message).toBeNull();
        expect(row.assetId).toBeNull();
        expect(row.raw).toBe(JSON.stringify(raw));

        const bare = await store.appendImportRow({
          jobId: job.id,
          rowNumber: 2,
          outcome: "error",
          message: "missing name column",
        });
        expect(bare.raw).toBeNull();
        expect(bare.message).toBe("missing name column");
      });

      it("lists rows in insertion order with pagination, scoped by job", async () => {
        const job = await store.createImportJob({
          fileHash: "hash-alpha",
          mode: "commit",
        });
        const otherJob = await store.createImportJob({
          fileHash: "hash-beta",
          mode: "commit",
        });
        for (let i = 1; i <= 6; i++) {
          await store.appendImportRow({
            jobId: job.id,
            rowNumber: i,
            outcome: "created",
          });
        }
        await store.appendImportRow({
          jobId: otherJob.id,
          rowNumber: 1,
          outcome: "error",
        });

        const all = await store.listImportRows(job.id, { limit: 10 });
        expect(all.map((r) => r.rowNumber)).toEqual([1, 2, 3, 4, 5, 6]);
        // Time-ordered ids make insertion order == id order.
        let prev = "";
        for (const row of all) {
          expect(row.id > prev).toBe(true);
          prev = row.id;
        }
        const page = await store.listImportRows(job.id, {
          limit: 2,
          offset: 2,
        });
        expect(page.map((r) => r.rowNumber)).toEqual([3, 4]);
        expect(await store.countImportRows(job.id)).toBe(6);
        expect(await store.countImportRows(otherJob.id)).toBe(1);
        expect(await store.countImportRows("missing-id")).toBe(0);
      });

      it("paginates jobs consistently with countImportJobs", async () => {
        const created: string[] = [];
        for (const hash of ["hash-a", "hash-b", "hash-c"]) {
          const job = await store.createImportJob({
            fileHash: hash,
            mode: "commit",
          });
          created.push(job.id);
        }
        const pageA = await store.listImportJobs({ limit: 2 });
        const pageB = await store.listImportJobs({ limit: 2, offset: 2 });
        expect(pageA).toHaveLength(2);
        expect(pageB).toHaveLength(1);
        const ids = [...pageA, ...pageB].map((j) => j.id);
        expect(new Set(ids).size).toBe(3);
        expect(new Set(ids)).toEqual(new Set(created));
        expect(await store.countImportJobs()).toBe(3);
      });

      it("findCompletedImportByHash ignores dry runs and unfinished jobs", async () => {
        expect(await store.findCompletedImportByHash("hash-h")).toBeNull();

        // Completed dry run: ignored.
        const dry = await store.createImportJob({
          fileHash: "hash-h",
          mode: "dry_run",
        });
        await store.completeImportJob(dry.id, {
          status: "completed",
          totalRows: 1,
          createdCount: 0,
          skippedCount: 1,
          collisionCount: 0,
          errorCount: 0,
        });
        // Still-running commit: ignored.
        await store.createImportJob({ fileHash: "hash-h", mode: "commit" });
        // Failed commit: ignored.
        const failed = await store.createImportJob({
          fileHash: "hash-h",
          mode: "commit",
        });
        await store.completeImportJob(failed.id, {
          status: "failed",
          totalRows: 1,
          createdCount: 0,
          skippedCount: 0,
          collisionCount: 0,
          errorCount: 1,
        });
        // Completed commit with a different hash: ignored.
        const other = await store.createImportJob({
          fileHash: "hash-other",
          mode: "commit",
        });
        await store.completeImportJob(other.id, {
          status: "completed",
          totalRows: 1,
          createdCount: 1,
          skippedCount: 0,
          collisionCount: 0,
          errorCount: 0,
        });
        expect(await store.findCompletedImportByHash("hash-h")).toBeNull();

        // Two completed commits with the hash: newest wins.
        const first = await store.createImportJob({
          fileHash: "hash-h",
          mode: "commit",
        });
        await store.completeImportJob(first.id, {
          status: "completed",
          totalRows: 2,
          createdCount: 2,
          skippedCount: 0,
          collisionCount: 0,
          errorCount: 0,
        });
        await sleep(5);
        const second = await store.createImportJob({
          fileHash: "hash-h",
          mode: "commit",
        });
        await store.completeImportJob(second.id, {
          status: "completed",
          totalRows: 2,
          createdCount: 0,
          skippedCount: 2,
          collisionCount: 0,
          errorCount: 0,
        });
        expect((await store.findCompletedImportByHash("hash-h"))?.id).toBe(
          second.id,
        );
      });
    });

    describe("exceptions", () => {
      it("creates an open exception with serialized details", async () => {
        const details = {
          conflictKey: "serialNumberNorm",
          value: "SN-ALPHA-01",
        };
        const exc = await store.createException({
          kind: "import_identity_collision",
          assetId: "asset-1",
          importRowId: "row-1",
          details,
        });
        expect(exc.id).toBeTruthy();
        expect(exc.at).toBeGreaterThan(0);
        expect(exc.kind).toBe("import_identity_collision");
        expect(exc.status).toBe("open");
        expect(exc.assetId).toBe("asset-1");
        expect(exc.importRowId).toBe("row-1");
        expect(exc.details).toBe(JSON.stringify(details));
        expect(exc.resolvedByUserId).toBeNull();
        expect(exc.resolvedAt).toBeNull();
        expect(exc.resolutionNote).toBeNull();
        expect(await store.getExceptionById(exc.id)).toEqual(exc);
        expect(await store.getExceptionById("missing-id")).toBeNull();
      });

      it("defaults optional exception fields to null", async () => {
        const exc = await store.createException({
          kind: "import_identity_collision",
        });
        expect(exc.assetId).toBeNull();
        expect(exc.importRowId).toBeNull();
        expect(exc.details).toBeNull();
      });

      it("filters and counts exceptions by status", async () => {
        const open = await store.createException({
          kind: "import_identity_collision",
        });
        const toResolve = await store.createException({
          kind: "import_identity_collision",
        });
        const toDismiss = await store.createException({
          kind: "import_identity_collision",
        });
        await store.resolveException(toResolve.id, {
          status: "resolved",
          resolvedByUserId: "user-1",
        });
        await store.resolveException(toDismiss.id, { status: "dismissed" });

        expect(await store.countExceptions()).toBe(3);
        expect(await store.countExceptions("open")).toBe(1);
        expect(await store.countExceptions("resolved")).toBe(1);
        expect(await store.countExceptions("dismissed")).toBe(1);

        const openList = await store.listExceptions({
          limit: 10,
          status: "open",
        });
        expect(openList.map((e) => e.id)).toEqual([open.id]);
        const resolvedList = await store.listExceptions({
          limit: 10,
          status: "resolved",
        });
        expect(resolvedList.map((e) => e.id)).toEqual([toResolve.id]);
      });

      it("paginates exceptions consistently with countExceptions", async () => {
        const created: string[] = [];
        for (let i = 0; i < 5; i++) {
          const exc = await store.createException({
            kind: "import_identity_collision",
          });
          created.push(exc.id);
        }
        const pageA = await store.listExceptions({ limit: 2 });
        const pageB = await store.listExceptions({ limit: 2, offset: 2 });
        const pageC = await store.listExceptions({ limit: 2, offset: 4 });
        expect(pageA).toHaveLength(2);
        expect(pageB).toHaveLength(2);
        expect(pageC).toHaveLength(1);
        const ids = [...pageA, ...pageB, ...pageC].map((e) => e.id);
        expect(new Set(ids).size).toBe(5);
        expect(new Set(ids)).toEqual(new Set(created));
        expect(await store.countExceptions()).toBe(5);
      });

      it("resolves an exception with resolver metadata", async () => {
        const exc = await store.createException({
          kind: "import_identity_collision",
        });
        const resolved = await store.resolveException(exc.id, {
          status: "resolved",
          resolvedByUserId: "user-1",
          resolutionNote: "merged by hand after review",
        });
        expect(resolved).not.toBeNull();
        expect(resolved?.status).toBe("resolved");
        expect(resolved?.resolvedByUserId).toBe("user-1");
        expect(resolved?.resolvedAt).toBeGreaterThan(0);
        expect(resolved?.resolutionNote).toBe("merged by hand after review");
        expect(await store.getExceptionById(exc.id)).toEqual(resolved);
      });

      it("dismisses an exception with defaulted resolver fields", async () => {
        const exc = await store.createException({
          kind: "import_identity_collision",
        });
        const dismissed = await store.resolveException(exc.id, {
          status: "dismissed",
        });
        expect(dismissed?.status).toBe("dismissed");
        expect(dismissed?.resolvedByUserId).toBeNull();
        expect(dismissed?.resolvedAt).toBeGreaterThan(0);
        expect(dismissed?.resolutionNote).toBeNull();
      });

      it("resolveException returns null for a missing id", async () => {
        expect(
          await store.resolveException("missing-id", { status: "dismissed" }),
        ).toBeNull();
      });
    });
  });
}
