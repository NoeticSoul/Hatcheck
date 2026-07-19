// Domain logic for custody: check-out and check-in orchestration over the
// append-only event stream. Routes stay thin; every rule lives here and
// speaks only the engine-agnostic Store contract.
//
// Status/custody coupling (maintainer decision, binding): check-out is the
// ONLY path to "deployed" and check-in returns the asset to "in_stock".
// Judgment call, documented: check-out is allowed only from "in_stock" —
// a "retired" asset is 409 asset_retired and an "in_repair" asset is 409
// asset_unavailable (fix it or return it to stock first); a "deployed"
// asset surfaces as 409 already_checked_out. The pre-checks below are the
// friendly fast path; the real enforcement is IN the append transaction:
// requireStatus "in_stock" is verified under the store's per-asset lock,
// so an asset retired between pre-check and append can never be deployed.
import type {
  AssetRecord,
  AssetStatus,
  CustodyEventRecord,
  Store,
} from "../../db/store";
import { fail, type LocationFailure } from "../locations/service";

/** Actor fields stamped onto every custody event from the session user. */
export interface CustodyActor {
  actorUserId: string;
  actorEmail: string;
}

/** Pre-state captured for audit before/after records. */
export interface CustodyStateSnapshot {
  status: AssetStatus;
  locationId: string | null;
}

export interface CheckOutInput {
  holderUserId?: string;
  holderLabel?: string;
  locationId?: string;
  note?: string;
}

export interface CheckInInput {
  locationId?: string;
  note?: string;
}

export type CustodyActionResult =
  | {
      ok: true;
      event: CustodyEventRecord;
      asset: AssetRecord;
      /**
       * Captured inside the append transaction (store.appendCustodyEvent
       * returns them from under its lock), so audit records built from
       * these reflect the transition that actually happened even under
       * concurrent asset mutations.
       */
      before: CustodyStateSnapshot;
      after: CustodyStateSnapshot;
    }
  | LocationFailure<400 | 404 | 409>;

/** Resolved holder snapshot: denormalized name plus optional user link. */
type Holder =
  | { holderUserId: string; holderName: string }
  | { holderUserId: null; holderName: string };

async function resolveHolder(
  store: Store,
  input: CheckOutInput,
): Promise<Holder | LocationFailure<400>> {
  const hasUser = input.holderUserId !== undefined;
  const label = input.holderLabel?.trim();
  const hasLabel = label !== undefined && label !== "";
  if (hasUser === hasLabel) {
    return fail(
      400,
      "validation_error",
      "exactly one of holderUserId or holderLabel is required",
    );
  }
  if (input.holderUserId !== undefined) {
    const user = await store.getUserById(input.holderUserId);
    if (user === null || !user.isActive) {
      return fail(
        400,
        "invalid_holder",
        "holderUserId does not reference an active user",
      );
    }
    return { holderUserId: user.id, holderName: user.displayName };
  }
  // hasLabel is true here; re-narrow for the compiler.
  if (label === undefined || label === "") {
    return fail(400, "validation_error", "holderLabel must not be empty");
  }
  return { holderUserId: null, holderName: label };
}

/** null location input -> no snapshot; missing location -> 400. */
async function resolveLocation(
  store: Store,
  locationId: string | undefined,
): Promise<
  { locationId: string; locationName: string } | null | LocationFailure<400>
> {
  if (locationId === undefined) return null;
  const location = await store.getLocationById(locationId);
  if (location === null) {
    return fail(
      400,
      "invalid_location",
      "locationId does not reference an existing location",
    );
  }
  return { locationId: location.id, locationName: location.name };
}

function isFailure(value: unknown): value is LocationFailure<400> {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as { ok: unknown }).ok === false
  );
}

export async function checkOutAsset(
  store: Store,
  assetId: string,
  input: CheckOutInput,
  actor: CustodyActor,
): Promise<CustodyActionResult> {
  const holder = await resolveHolder(store, input);
  if (isFailure(holder)) return holder;

  const location = await resolveLocation(store, input.locationId);
  if (isFailure(location)) return location;

  const asset = await store.getAssetById(assetId);
  if (asset === null) {
    return fail(404, "not_found", "Asset not found");
  }
  if (asset.status === "retired") {
    return fail(409, "asset_retired", "A retired asset cannot be checked out");
  }
  if (asset.status === "in_repair") {
    return fail(
      409,
      "asset_unavailable",
      "An asset in repair cannot be checked out; return it to stock first",
    );
  }

  const result = await store.appendCustodyEvent(
    {
      assetId,
      type: "check_out",
      holderUserId: holder.holderUserId,
      holderName: holder.holderName,
      locationId: location?.locationId ?? null,
      locationName: location?.locationName ?? null,
      note: input.note ?? null,
      actorUserId: actor.actorUserId,
      actorEmail: actor.actorEmail,
    },
    "deployed",
    location === null ? undefined : location.locationId,
    "in_stock",
  );
  if (result === null) {
    return fail(404, "not_found", "Asset not found");
  }
  if (!result.ok) {
    if (result.conflict === "status_conflict") {
      if (result.actualStatus === "retired") {
        return fail(
          409,
          "asset_retired",
          "A retired asset cannot be checked out",
        );
      }
      if (result.actualStatus === "in_repair") {
        return fail(
          409,
          "asset_unavailable",
          "An asset in repair cannot be checked out; return it to stock first",
        );
      }
      return fail(409, "already_checked_out", "Asset is already checked out");
    }
    return fail(409, "already_checked_out", "Asset is already checked out");
  }
  const after = await store.getAssetById(assetId);
  if (after === null) {
    return fail(404, "not_found", "Asset not found");
  }
  return {
    ok: true,
    event: result.event,
    asset: after,
    before: result.assetBefore,
    after: result.assetAfter,
  };
}

export async function checkInAsset(
  store: Store,
  assetId: string,
  input: CheckInInput,
  actor: CustodyActor,
): Promise<CustodyActionResult> {
  const location = await resolveLocation(store, input.locationId);
  if (isFailure(location)) return location;

  const asset = await store.getAssetById(assetId);
  if (asset === null) {
    return fail(404, "not_found", "Asset not found");
  }

  const result = await store.appendCustodyEvent(
    {
      assetId,
      type: "check_in",
      locationId: location?.locationId ?? null,
      locationName: location?.locationName ?? null,
      note: input.note ?? null,
      actorUserId: actor.actorUserId,
      actorEmail: actor.actorEmail,
    },
    "in_stock",
    location === null ? undefined : location.locationId,
  );
  if (result === null) {
    return fail(404, "not_found", "Asset not found");
  }
  if (!result.ok) {
    return fail(409, "not_checked_out", "Asset is not checked out");
  }
  const after = await store.getAssetById(assetId);
  if (after === null) {
    return fail(404, "not_found", "Asset not found");
  }
  return {
    ok: true,
    event: result.event,
    asset: after,
    before: result.assetBefore,
    after: result.assetAfter,
  };
}

export type CustodyHistoryResult =
  | { ok: true; items: CustodyEventRecord[]; total: number }
  | LocationFailure<404>;

export async function getCustodyHistory(
  store: Store,
  assetId: string,
  opts: { limit: number; offset: number },
): Promise<CustodyHistoryResult> {
  const asset = await store.getAssetById(assetId);
  if (asset === null) {
    return fail(404, "not_found", "Asset not found");
  }
  const items = await store.listCustodyEvents(assetId, opts);
  const total = await store.countCustodyEvents(assetId);
  return { ok: true, items, total };
}
