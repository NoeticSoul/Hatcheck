// Domain logic for assets. Routes stay thin; every rule (identity-key
// uniqueness, MAC validation, the strict status/custody coupling) lives
// here and speaks only the engine-agnostic Store contract, which keeps the
// dual-DB invariant intact.
//
// Status/custody coupling (maintainer decision, binding): "deployed" is
// exclusively the result of a check-out. Nothing in this module may set
// it, and while an asset is deployed its status cannot change through
// PATCH at all — check the asset in first.
import type {
  AssetIdentityKey,
  AssetInterfaceRecord,
  AssetPatch,
  AssetQuery,
  AssetRecord,
  AssetStatus,
  AssetType,
  CustodyEventRecord,
  LocationRecord,
  NewAssetInterface,
  Store,
} from "../../db/store";
import {
  fail,
  isUniqueViolation,
  type LocationFailure,
} from "../locations/service";
import {
  normalizeIdentityKey,
  normalizeSystemUuid,
  parseMac,
} from "./identity";

const DEPLOYED_IS_CUSTODY =
  "deployed is set by checking an asset out, not through this endpoint";
const CHECKED_OUT_FIRST =
  "the asset is checked out; check the asset in first";

/**
 * Before/after state recorded in audit entries for asset mutations. Raw
 * identity values only — the *Norm shadows are derived and add no
 * information to the trail.
 */
export function assetSnapshot(asset: AssetRecord) {
  return {
    name: asset.name,
    assetType: asset.assetType,
    status: asset.status,
    locationId: asset.locationId,
    model: asset.model,
    manufacturer: asset.manufacturer,
    notes: asset.notes,
    assetTag: asset.assetTag,
    serialNumber: asset.serialNumber,
    systemUuid: asset.systemUuid,
  };
}

/** Trimmed as entered; empty-after-trim means "absent" and stores NULL. */
function trimToNull(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v === undefined || v === "" ? null : v;
}

/**
 * Friendly pre-check for an identity key: 409 when the normalized value is
 * already held by a different asset. The DB unique index remains the race
 * backstop (see the isUniqueViolation catches below).
 */
async function identityConflict(
  store: Store,
  key: AssetIdentityKey,
  field: string,
  norm: string | null,
  excludeId?: string,
): Promise<LocationFailure<409> | null> {
  if (norm === null) return null;
  const holder = await store.getAssetByIdentityKey(key, norm);
  if (holder === null || holder.id === excludeId) return null;
  return fail(
    409,
    "identity_in_use",
    `${field} is already in use by another asset`,
  );
}

export interface AssetInterfaceInput {
  mac: string;
  label?: string | null;
}

/** Canonicalizes interface MACs; 400 naming the first malformed value. */
function prepareInterfaces(
  inputs: AssetInterfaceInput[],
): NewAssetInterface[] | LocationFailure<400> {
  const out: NewAssetInterface[] = [];
  for (const input of inputs) {
    const mac = parseMac(input.mac);
    if (mac === null) {
      return fail(400, "invalid_mac", `invalid MAC address: ${input.mac}`);
    }
    out.push({ mac, label: trimToNull(input.label) });
  }
  return out;
}

export interface CreateAssetInput {
  name: string;
  assetType?: AssetType;
  status?: AssetStatus;
  locationId?: string | null;
  model?: string | null;
  manufacturer?: string | null;
  notes?: string | null;
  assetTag?: string | null;
  serialNumber?: string | null;
  systemUuid?: string | null;
  interfaces?: AssetInterfaceInput[];
}

export type CreateAssetResult =
  | { ok: true; asset: AssetRecord; interfaces: AssetInterfaceRecord[] }
  | LocationFailure<400 | 409>;

export async function createAsset(
  store: Store,
  input: CreateAssetInput,
): Promise<CreateAssetResult> {
  const name = input.name.trim();
  if (name === "") {
    return fail(400, "validation_error", "name must not be empty");
  }
  const status = input.status ?? "in_stock";
  if (status === "deployed") {
    return fail(400, "invalid_status", DEPLOYED_IS_CUSTODY);
  }
  const locationId = input.locationId ?? null;
  if (locationId !== null) {
    const location = await store.getLocationById(locationId);
    if (location === null) {
      return fail(
        400,
        "invalid_location",
        "locationId does not reference an existing location",
      );
    }
  }

  const assetTag = trimToNull(input.assetTag);
  const assetTagNorm = normalizeIdentityKey(assetTag);
  const serialNumber = trimToNull(input.serialNumber);
  const serialNumberNorm = normalizeIdentityKey(serialNumber);
  const systemUuid = trimToNull(input.systemUuid);
  const systemUuidNorm = normalizeSystemUuid(systemUuid);
  const identityChecks = [
    ["assetTagNorm", "assetTag", assetTagNorm],
    ["serialNumberNorm", "serialNumber", serialNumberNorm],
    ["systemUuidNorm", "systemUuid", systemUuidNorm],
  ] as const;
  for (const [key, field, norm] of identityChecks) {
    const conflict = await identityConflict(store, key, field, norm);
    if (conflict !== null) return conflict;
  }

  const interfaces = prepareInterfaces(input.interfaces ?? []);
  if (!Array.isArray(interfaces)) return interfaces;

  try {
    const asset = await store.createAssetWithInterfaces(
      {
        name,
        assetType: input.assetType,
        status,
        locationId,
        model: trimToNull(input.model),
        manufacturer: trimToNull(input.manufacturer),
        notes: input.notes ?? null,
        assetTag,
        assetTagNorm,
        serialNumber,
        serialNumberNorm,
        systemUuid,
        systemUuidNorm,
      },
      interfaces,
    );
    const created = await store.listAssetInterfaces(asset.id);
    return { ok: true, asset, interfaces: created };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(
        409,
        "identity_in_use",
        "An identity key is already in use by another asset",
      );
    }
    throw err;
  }
}

export interface UpdateAssetInput {
  name?: string;
  assetType?: AssetType;
  status?: AssetStatus;
  locationId?: string | null;
  model?: string | null;
  manufacturer?: string | null;
  notes?: string | null;
  assetTag?: string | null;
  serialNumber?: string | null;
  systemUuid?: string | null;
}

export type UpdateAssetResult =
  | { ok: true; before: AssetRecord; asset: AssetRecord }
  | LocationFailure<400 | 404 | 409>;

export async function updateAsset(
  store: Store,
  id: string,
  input: UpdateAssetInput,
): Promise<UpdateAssetResult> {
  const existing = await store.getAssetById(id);
  if (existing === null) {
    return fail(404, "not_found", "Asset not found");
  }

  const patch: AssetPatch = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name === "") {
      return fail(400, "validation_error", "name must not be empty");
    }
    patch.name = name;
  }
  if (input.assetType !== undefined) patch.assetType = input.assetType;
  if (input.status !== undefined) {
    if (input.status === "deployed") {
      return fail(400, "invalid_status", DEPLOYED_IS_CUSTODY);
    }
    if (existing.status === "deployed") {
      return fail(409, "asset_checked_out", CHECKED_OUT_FIRST);
    }
    patch.status = input.status;
  }
  if (input.locationId !== undefined) {
    if (input.locationId !== null) {
      const location = await store.getLocationById(input.locationId);
      if (location === null) {
        return fail(
          400,
          "invalid_location",
          "locationId does not reference an existing location",
        );
      }
    }
    patch.locationId = input.locationId;
  }
  if (input.model !== undefined) patch.model = trimToNull(input.model);
  if (input.manufacturer !== undefined) {
    patch.manufacturer = trimToNull(input.manufacturer);
  }
  if (input.notes !== undefined) patch.notes = input.notes;

  if (input.assetTag !== undefined) {
    const raw = trimToNull(input.assetTag);
    const norm = normalizeIdentityKey(raw);
    const conflict = await identityConflict(
      store,
      "assetTagNorm",
      "assetTag",
      norm,
      id,
    );
    if (conflict !== null) return conflict;
    patch.assetTag = raw;
    patch.assetTagNorm = norm;
  }
  if (input.serialNumber !== undefined) {
    const raw = trimToNull(input.serialNumber);
    const norm = normalizeIdentityKey(raw);
    const conflict = await identityConflict(
      store,
      "serialNumberNorm",
      "serialNumber",
      norm,
      id,
    );
    if (conflict !== null) return conflict;
    patch.serialNumber = raw;
    patch.serialNumberNorm = norm;
  }
  if (input.systemUuid !== undefined) {
    const raw = trimToNull(input.systemUuid);
    const norm = normalizeSystemUuid(raw);
    const conflict = await identityConflict(
      store,
      "systemUuidNorm",
      "systemUuid",
      norm,
      id,
    );
    if (conflict !== null) return conflict;
    patch.systemUuid = raw;
    patch.systemUuidNorm = norm;
  }

  try {
    // When the patch touches status, the UPDATE itself carries a
    // status <> 'deployed' guard: the pre-check above is only a friendly
    // fast path, and a check-out committing between that read and this
    // write must not be overwritten (the custody side is transactional;
    // this keeps the PATCH side symmetric).
    const guard =
      patch.status !== undefined
        ? ({ statusNot: "deployed" } as const)
        : undefined;
    const updated = await store.updateAsset(id, patch, guard);
    if (updated === null) {
      const now = await store.getAssetById(id);
      if (now !== null && guard !== undefined && now.status === "deployed") {
        return fail(409, "asset_checked_out", CHECKED_OUT_FIRST);
      }
      return fail(404, "not_found", "Asset not found");
    }
    return { ok: true, before: existing, asset: updated };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(
        409,
        "identity_in_use",
        "An identity key is already in use by another asset",
      );
    }
    throw err;
  }
}

export type DeleteAssetResult =
  | {
      ok: true;
      before: AssetRecord;
      interfaces: AssetInterfaceRecord[];
      custodyEventCount: number;
    }
  | LocationFailure<404>;

/**
 * Hard delete; interfaces and custody events cascade in the store. The
 * caller's audit record is the only surviving trace, so this result
 * carries everything that is about to be destroyed.
 */
export async function deleteAsset(
  store: Store,
  id: string,
): Promise<DeleteAssetResult> {
  const existing = await store.getAssetById(id);
  if (existing === null) {
    return fail(404, "not_found", "Asset not found");
  }
  const interfaces = await store.listAssetInterfaces(id);
  const custodyEventCount = await store.countCustodyEvents(id);
  const deleted = await store.deleteAsset(id);
  if (!deleted) {
    return fail(404, "not_found", "Asset not found");
  }
  return { ok: true, before: existing, interfaces, custodyEventCount };
}

export interface ListAssetsInput {
  limit: number;
  offset: number;
  status?: AssetStatus;
  assetType?: AssetType;
  locationId?: string;
  q?: string;
  heldByUserId?: string;
}

export interface AssetListItem extends AssetRecord {
  currentCustody: CustodyEventRecord | null;
}

export async function listAssets(
  store: Store,
  input: ListAssetsInput,
): Promise<{ items: AssetListItem[]; total: number }> {
  const filters: Omit<AssetQuery, "limit" | "offset"> = {};
  if (input.status !== undefined) filters.status = input.status;
  if (input.assetType !== undefined) filters.assetType = input.assetType;
  if (input.locationId !== undefined) filters.locationId = input.locationId;
  if (input.q !== undefined) filters.q = input.q;
  if (input.heldByUserId !== undefined) {
    filters.heldByUserId = input.heldByUserId;
  }

  const assets = await store.listAssets({
    ...filters,
    limit: input.limit,
    offset: input.offset,
  });
  // Same filters, so total stays consistent with the page contents.
  const total = await store.countAssets(filters);
  // One batch custody lookup for the whole page — never per item.
  const custody = await store.getCurrentCustodyForAssets(
    assets.map((asset) => asset.id),
  );
  const byAssetId = new Map(custody.map((event) => [event.assetId, event]));
  const items = assets.map((asset) => ({
    ...asset,
    currentCustody: byAssetId.get(asset.id) ?? null,
  }));
  return { items, total };
}

export type AssetDetailResult =
  | {
      ok: true;
      asset: AssetRecord;
      interfaces: AssetInterfaceRecord[];
      currentCustody: CustodyEventRecord | null;
      location: LocationRecord | null;
    }
  | LocationFailure<404>;

export async function getAssetDetail(
  store: Store,
  id: string,
): Promise<AssetDetailResult> {
  const asset = await store.getAssetById(id);
  if (asset === null) {
    return fail(404, "not_found", "Asset not found");
  }
  const interfaces = await store.listAssetInterfaces(id);
  const currentCustody = await store.getCurrentCustody(id);
  const location =
    asset.locationId === null
      ? null
      : await store.getLocationById(asset.locationId);
  return { ok: true, asset, interfaces, currentCustody, location };
}

export type AddInterfaceResult =
  | { ok: true; iface: AssetInterfaceRecord }
  | LocationFailure<400 | 404>;

export async function addInterface(
  store: Store,
  assetId: string,
  input: AssetInterfaceInput,
): Promise<AddInterfaceResult> {
  const mac = parseMac(input.mac);
  if (mac === null) {
    return fail(400, "invalid_mac", `invalid MAC address: ${input.mac}`);
  }
  const created = await store.addAssetInterface(assetId, {
    mac,
    label: trimToNull(input.label),
  });
  if (created === null) {
    return fail(404, "not_found", "Asset not found");
  }
  return { ok: true, iface: created };
}

export type RemoveInterfaceResult =
  | { ok: true; removed: AssetInterfaceRecord }
  | LocationFailure<404>;

export async function removeInterface(
  store: Store,
  assetId: string,
  interfaceId: string,
): Promise<RemoveInterfaceResult> {
  const asset = await store.getAssetById(assetId);
  if (asset === null) {
    return fail(404, "not_found", "Asset not found");
  }
  // Addressing is nested under the asset, so an interface id that exists
  // but belongs to a different asset is a 404, not a cross-asset delete.
  const interfaces = await store.listAssetInterfaces(assetId);
  const target = interfaces.find((iface) => iface.id === interfaceId);
  if (target === undefined) {
    return fail(404, "not_found", "Interface not found on this asset");
  }
  const deleted = await store.deleteAssetInterface(interfaceId);
  if (!deleted) {
    return fail(404, "not_found", "Interface not found on this asset");
  }
  return { ok: true, removed: target };
}
