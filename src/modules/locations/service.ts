// Domain logic for the locations hierarchy. Routes stay thin; every rule
// (rank-based parenting, sibling-name uniqueness, delete pre-checks) lives
// here and speaks only the engine-agnostic Store contract, which keeps the
// dual-DB invariant intact.
import type {
  LocationKind,
  LocationPatch,
  LocationQuery,
  LocationRecord,
  Store,
} from "../../db/store";

/**
 * Rank order for the hierarchy rule: a location's parent, when set, must
 * have a STRICTLY LOWER rank than the child. This single rule caps depth
 * at three levels and makes cycles structurally impossible (no location
 * can be placed under an equal-or-higher rank, so no path ever returns to
 * its start). parentId null is always valid for every kind (flat mode).
 */
export const LOCATION_RANK: Record<LocationKind, number> = {
  site: 0,
  building: 1,
  room: 2,
};

const PARENT_RULE =
  "a parent must be an existing location of a strictly higher level " +
  "(site > building > room), and sites cannot have a parent";

/** Before/after state recorded in audit entries for location mutations. */
export function locationSnapshot(location: LocationRecord) {
  return {
    name: location.name,
    kind: location.kind,
    parentId: location.parentId,
    description: location.description,
    isActive: location.isActive,
  };
}

export interface LocationFailure<S extends number> {
  ok: false;
  status: S;
  code: string;
  message: string;
}

export function fail<S extends number>(
  status: S,
  code: string,
  message: string,
): LocationFailure<S> {
  return { ok: false, status, code, message };
}

/**
 * Driver error classes and codes differ per engine (better-sqlite3,
 * bun:sqlite, postgres.js), so unique-index violations are detected by
 * message: SQLite says "UNIQUE constraint failed", PG says "duplicate key
 * value violates unique constraint". The drizzle postgres-js session
 * additionally wraps driver errors in DrizzleQueryError whose own message
 * is just "Failed query: ..." with the real PG text on err.cause, so both
 * predicates walk the cause chain (SQLite errors arrive unwrapped).
 */
export function errorMessages(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join("\n");
}

export function isUniqueViolation(err: unknown): boolean {
  return /unique constraint|duplicate key/i.test(errorMessages(err));
}

/** FK-restrict violations, same cross-engine caveat as isUniqueViolation. */
function isForeignKeyViolation(err: unknown): boolean {
  return /foreign key/i.test(errorMessages(err));
}

const PAGE_SIZE = 200;

/** Drains a filtered listing page by page (root and children checks). */
async function listAllLocations(
  store: Store,
  filters: Omit<LocationQuery, "limit" | "offset">,
): Promise<LocationRecord[]> {
  const out: LocationRecord[] = [];
  let offset = 0;
  for (;;) {
    const page = await store.listLocations({
      ...filters,
      limit: PAGE_SIZE,
      offset,
    });
    out.push(...page);
    if (page.length < PAGE_SIZE) return out;
    offset += PAGE_SIZE;
  }
}

/**
 * The DB unique index on (parentId, name) does not fire for NULL parents
 * (NULLs are distinct on both engines), so root-level uniqueness is
 * enforced here. Comparison is exact and case-sensitive to match the
 * index semantics for non-null parents. The q filter only narrows the
 * candidate set (it is a case-insensitive superset of exact matches).
 */
async function rootNameTaken(
  store: Store,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const candidates = await listAllLocations(store, {
    parentId: null,
    q: name,
    includeInactive: true,
  });
  return candidates.some(
    (location) => location.name === name && location.id !== excludeId,
  );
}

/** null when the parent exists and ranks strictly below childKind. */
async function checkParentRank(
  store: Store,
  parentId: string,
  childKind: LocationKind,
): Promise<LocationFailure<400> | null> {
  const parent = await store.getLocationById(parentId);
  if (parent === null) {
    return fail(400, "invalid_parent", `Parent location not found; ${PARENT_RULE}`);
  }
  if (LOCATION_RANK[parent.kind] >= LOCATION_RANK[childKind]) {
    return fail(
      400,
      "invalid_parent",
      `A ${childKind} cannot be placed under a ${parent.kind}; ${PARENT_RULE}`,
    );
  }
  return null;
}

export interface CreateLocationInput {
  name: string;
  kind?: LocationKind;
  parentId?: string | null;
  description?: string | null;
  isActive?: boolean;
}

export type CreateLocationResult =
  | { ok: true; location: LocationRecord }
  | LocationFailure<400 | 409>;

export async function createLocation(
  store: Store,
  input: CreateLocationInput,
): Promise<CreateLocationResult> {
  const name = input.name.trim();
  if (name === "") {
    return fail(400, "validation_error", "name must not be empty");
  }
  const kind = input.kind ?? "room";
  const parentId = input.parentId ?? null;

  if (parentId !== null) {
    const parentFailure = await checkParentRank(store, parentId, kind);
    if (parentFailure !== null) return parentFailure;
  } else if (await rootNameTaken(store, name)) {
    return fail(
      409,
      "name_in_use",
      "A root-level location with this name already exists",
    );
  }

  try {
    const location = await store.createLocation({
      name,
      kind,
      parentId,
      description: input.description ?? null,
      isActive: input.isActive ?? true,
    });
    return { ok: true, location };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(
        409,
        "name_in_use",
        "A sibling location with this name already exists under that parent",
      );
    }
    throw err;
  }
}

export interface UpdateLocationInput {
  name?: string;
  kind?: LocationKind;
  parentId?: string | null;
  description?: string | null;
  isActive?: boolean;
}

export type UpdateLocationResult =
  | { ok: true; before: LocationRecord; location: LocationRecord }
  | LocationFailure<400 | 404 | 409>;

export async function updateLocation(
  store: Store,
  id: string,
  input: UpdateLocationInput,
): Promise<UpdateLocationResult> {
  const existing = await store.getLocationById(id);
  if (existing === null) {
    return fail(404, "not_found", "Location not found");
  }

  const patch: LocationPatch = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name === "") {
      return fail(400, "validation_error", "name must not be empty");
    }
    patch.name = name;
  }
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.parentId !== undefined) patch.parentId = input.parentId;
  if (input.description !== undefined) patch.description = input.description;
  if (input.isActive !== undefined) patch.isActive = input.isActive;

  // Effective post-patch values drive every rule below.
  const nextKind = patch.kind ?? existing.kind;
  const nextParentId =
    patch.parentId !== undefined ? patch.parentId : existing.parentId;
  const nextName = patch.name ?? existing.name;

  if (nextParentId === id) {
    return fail(400, "invalid_parent", "A location cannot be its own parent");
  }

  // Re-validate the rank rule whenever the hierarchy could change: against
  // the (possibly new) parent, and against existing children when the kind
  // changes (their parent's rank is about to move).
  if (patch.kind !== undefined || patch.parentId !== undefined) {
    if (nextParentId !== null) {
      const parentFailure = await checkParentRank(store, nextParentId, nextKind);
      if (parentFailure !== null) return parentFailure;
    }
    if (patch.kind !== undefined && patch.kind !== existing.kind) {
      const children = await listAllLocations(store, {
        parentId: id,
        includeInactive: true,
      });
      const conflicting = children.find(
        (child) => LOCATION_RANK[nextKind] >= LOCATION_RANK[child.kind],
      );
      if (conflicting !== undefined) {
        return fail(
          409,
          "kind_conflicts_with_children",
          `Cannot change kind to ${nextKind}: child "${conflicting.name}" ` +
            `is a ${conflicting.kind}, which would no longer rank below ` +
            "its parent",
        );
      }
    }
  }

  // Root uniqueness is service-enforced (see rootNameTaken). Check on any
  // update that changes the name or moves the location to root.
  const nameChanges = patch.name !== undefined && patch.name !== existing.name;
  const movesToRoot = patch.parentId === null && existing.parentId !== null;
  if (nextParentId === null && (nameChanges || movesToRoot)) {
    if (await rootNameTaken(store, nextName, id)) {
      return fail(
        409,
        "name_in_use",
        "A root-level location with this name already exists",
      );
    }
  }

  try {
    const updated = await store.updateLocation(id, patch);
    if (updated === null) {
      return fail(404, "not_found", "Location not found");
    }
    return { ok: true, before: existing, location: updated };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(
        409,
        "name_in_use",
        "A sibling location with this name already exists under that parent",
      );
    }
    throw err;
  }
}

export type DeleteLocationResult =
  | { ok: true; before: LocationRecord }
  | LocationFailure<404 | 409>;

export async function deleteLocation(
  store: Store,
  id: string,
): Promise<DeleteLocationResult> {
  const existing = await store.getLocationById(id);
  if (existing === null) {
    return fail(404, "not_found", "Location not found");
  }
  const childCount = await store.countLocationChildren(id);
  if (childCount > 0) {
    return fail(
      409,
      "location_in_use",
      `Location still has ${childCount} child location(s)`,
    );
  }
  const assetCount = await store.countAssets({ locationId: id });
  if (assetCount > 0) {
    return fail(
      409,
      "location_in_use",
      `Location is still referenced by ${assetCount} asset(s)`,
    );
  }
  try {
    const deleted = await store.deleteLocation(id);
    if (!deleted) {
      return fail(404, "not_found", "Location not found");
    }
  } catch (err) {
    // A reference created between the pre-checks and the delete trips the
    // FK restriction; report it exactly like the pre-checks would have.
    if (isForeignKeyViolation(err)) {
      return fail(
        409,
        "location_in_use",
        "Location is still referenced by child locations or assets",
      );
    }
    throw err;
  }
  return { ok: true, before: existing };
}

export interface ListLocationsInput {
  limit: number;
  offset: number;
  parentId?: string;
  rootsOnly?: boolean;
  kind?: LocationKind;
  q?: string;
  includeInactive?: boolean;
}

export type ListLocationsResult =
  | { ok: true; items: LocationRecord[]; total: number }
  | LocationFailure<400>;

export async function listLocations(
  store: Store,
  input: ListLocationsInput,
): Promise<ListLocationsResult> {
  if (input.rootsOnly === true && input.parentId !== undefined) {
    return fail(
      400,
      "validation_error",
      "parentId and rootsOnly are mutually exclusive",
    );
  }
  const filters: Omit<LocationQuery, "limit" | "offset"> = {};
  if (input.rootsOnly === true) {
    filters.parentId = null;
  } else if (input.parentId !== undefined) {
    filters.parentId = input.parentId;
  }
  if (input.kind !== undefined) filters.kind = input.kind;
  if (input.q !== undefined) filters.q = input.q;
  if (input.includeInactive === true) filters.includeInactive = true;

  const items = await store.listLocations({
    ...filters,
    limit: input.limit,
    offset: input.offset,
  });
  // Same filters, so total stays consistent with the page contents.
  const total = await store.countLocations(filters);
  return { ok: true, items, total };
}
