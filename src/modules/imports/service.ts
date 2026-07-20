// Domain logic for CSV asset imports. Routes stay thin; every rule lives
// here and speaks only the engine-agnostic Store contract.
//
// Invariants (CLAUDE.md, binding):
// - Never force-merge: a row that collides with existing assets on any
//   identity field becomes an exception record for human review; the row
//   itself imports nothing.
// - Idempotent: re-running the same file creates no duplicates. Every row
//   must therefore carry at least one identity field (asset_tag,
//   serial_number, or system_uuid) so a re-run can recognize its own
//   assets; a row whose identity fields all exactly match one existing
//   asset is skipped.
// - Dry-run first: mode "dry_run" runs the identical pipeline and persists
//   the job + per-row report as a preview trail, but creates no assets and
//   no exception records.
// - Partial failures never abort the run: failed rows are reported with
//   reasons and the rest proceed (per-row result report, gate criterion 1).
// - MAC addresses are per-interface attributes, never identity keys: they
//   are parsed onto interfaces and play no part in matching.
// - Audit entries for created assets and exceptions are written by THIS
//   module, immediately after each mutation, so a run aborted mid-way
//   leaves nothing unaudited (hard rule 5); the route adds only the
//   per-run summary entry.
import { createHash } from "node:crypto";
import type {
  AssetRecord,
  AssetStatus,
  AssetType,
  ExceptionRecord,
  ImportJobRecord,
  ImportMode,
  ImportRowOutcome,
  ImportRowRecord,
  LocationRecord,
  NewAssetInterface,
  Store,
} from "../../db/store";
import { assetSnapshot } from "../assets/service";
import {
  normalizeIdentityKey,
  normalizeSystemUuid,
  parseMac,
} from "../assets/identity";
import {
  fail,
  isUniqueViolation,
  type LocationFailure,
} from "../locations/service";
import { parseCsv } from "./csv";

export const MAX_IMPORT_ROWS = 5000;
const MAX_INTERFACES_PER_ROW = 16;

type CanonicalColumn =
  | "name"
  | "asset_type"
  | "status"
  | "location"
  | "location_id"
  | "model"
  | "manufacturer"
  | "notes"
  | "asset_tag"
  | "serial_number"
  | "system_uuid"
  | "mac_addresses";

// Canonical CSV columns. Header names are normalized (lower-case, spaces
// and dashes to underscores) and then resolved through these aliases, so
// "Serial Number" and "serial" both land on serial_number.
const COLUMN_ALIASES: Record<string, CanonicalColumn> = {
  name: "name",
  asset_name: "name",
  asset_type: "asset_type",
  type: "asset_type",
  status: "status",
  location: "location",
  location_name: "location",
  location_id: "location_id",
  model: "model",
  manufacturer: "manufacturer",
  make: "manufacturer",
  vendor: "manufacturer",
  notes: "notes",
  note: "notes",
  asset_tag: "asset_tag",
  tag: "asset_tag",
  serial_number: "serial_number",
  serial: "serial_number",
  sn: "serial_number",
  system_uuid: "system_uuid",
  uuid: "system_uuid",
  mac_addresses: "mac_addresses",
  mac_address: "mac_addresses",
  macs: "mac_addresses",
  mac: "mac_addresses",
};

// Same per-field limits as the JSON asset API, so an import cannot smuggle
// in values the create endpoint would reject.
const FIELD_LIMITS: Partial<Record<CanonicalColumn, number>> = {
  name: 200,
  location: 200,
  location_id: 200,
  model: 200,
  manufacturer: 200,
  notes: 5000,
  asset_tag: 200,
  serial_number: 200,
  system_uuid: 200,
};

function normalizeHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function trimToNull(value: string | undefined): string | null {
  const v = value?.trim();
  return v === undefined || v === "" ? null : v;
}

export function hashCsv(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface ImportActor {
  actorUserId: string;
  actorEmail: string;
}

export interface RunAssetImportInput {
  csvText: string;
  mode: ImportMode;
  filename: string | null;
  actor: ImportActor;
  /** Client IP recorded on the audit entries this run writes. */
  ip: string | null;
}

export interface ImportRunSummary {
  ok: true;
  job: ImportJobRecord;
  /** Full per-row report in file order (gate criterion 1). */
  rows: ImportRowRecord[];
  /** Latest completed commit-mode job for the same file bytes, if any. */
  priorImport: ImportJobRecord | null;
  /** Commit mode only; empty on dry runs. */
  createdAssets: AssetRecord[];
  /** Commit mode only; empty on dry runs. */
  exceptions: ExceptionRecord[];
}

export type RunAssetImportResult = ImportRunSummary | LocationFailure<400>;

interface HeaderMap {
  /** Column index -> canonical column; dense because unknowns are a 400. */
  byIndex: CanonicalColumn[];
  /** Canonical column -> column index. */
  index: Partial<Record<CanonicalColumn, number>>;
}

function mapHeaders(cells: string[]): HeaderMap | LocationFailure<400> {
  const byIndex: CanonicalColumn[] = [];
  const index: Partial<Record<CanonicalColumn, number>> = {};
  const unknown: string[] = [];
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i] ?? "";
    const canonical = COLUMN_ALIASES[normalizeHeader(cell)];
    if (canonical === undefined) {
      unknown.push(cell.trim());
      continue;
    }
    if (index[canonical] !== undefined) {
      return fail(
        400,
        "invalid_csv",
        `duplicate column: ${cell.trim()} maps to ${canonical}, which is already present`,
      );
    }
    byIndex[i] = canonical;
    index[canonical] = i;
  }
  // Unknown headers are a hard error, not a warning: a typo like
  // "serail_number" would otherwise silently drop an identity field.
  if (unknown.length > 0) {
    return fail(
      400,
      "invalid_csv",
      `unknown column(s): ${unknown.join(", ")}. Known columns: ${[
        ...new Set(Object.values(COLUMN_ALIASES)),
      ].join(", ")}`,
    );
  }
  if (index.name === undefined) {
    return fail(400, "invalid_csv", "missing required column: name");
  }
  return { byIndex, index };
}

/** All locations, indexed for by-name and by-id resolution. */
interface LocationIndex {
  byName: Map<string, LocationRecord[]>;
  byId: Map<string, LocationRecord>;
}

/**
 * Snapshot reads are ONE statement, never offset pages: separate paged
 * queries are not a consistent snapshot (concurrent writes shift rows
 * across page boundaries, and equal-name ordering is not stable across
 * queries), which could double-count a location into a false "ambiguous"
 * error or drop one into a false "unknown". The cap is far beyond Phase 1
 * scale; a deployment that ever exceeds it would surface as honest
 * unknown-location row errors, not silent misimports.
 */
const SNAPSHOT_ROW_CAP = 100_000;

async function loadLocationIndex(store: Store): Promise<LocationIndex> {
  const byName = new Map<string, LocationRecord[]>();
  const byId = new Map<string, LocationRecord>();
  const all = await store.listLocations({
    limit: SNAPSHOT_ROW_CAP,
    offset: 0,
    includeInactive: true,
  });
  for (const location of all) {
    byId.set(location.id, location);
    const key = location.name.trim().toLowerCase();
    const bucket = byName.get(key);
    if (bucket === undefined) byName.set(key, [location]);
    else bucket.push(location);
  }
  return { byName, byId };
}

/** What a valid row wants to create; built before any matching. */
interface RowPlan {
  name: string;
  assetType: AssetType;
  status: AssetStatus;
  locationId: string | null;
  model: string | null;
  manufacturer: string | null;
  notes: string | null;
  assetTag: string | null;
  assetTagNorm: string | null;
  serialNumber: string | null;
  serialNumberNorm: string | null;
  systemUuid: string | null;
  systemUuidNorm: string | null;
  interfaces: NewAssetInterface[];
}

const ASSET_TYPES: AssetType[] = ["device", "peripheral", "license"];
// "deployed" is excluded on purpose: it is exclusively the result of a
// check-out (status/custody coupling), so no import may set it.
const IMPORT_STATUSES: AssetStatus[] = ["in_stock", "in_repair", "retired"];

function buildRowPlan(
  cells: string[],
  headers: HeaderMap,
  locations: LocationIndex,
): { plan: RowPlan } | { errors: string[] } {
  const errors: string[] = [];
  const get = (col: CanonicalColumn): string | null => {
    const i = headers.index[col];
    return i === undefined ? null : trimToNull(cells[i]);
  };

  for (const [col, limit] of Object.entries(FIELD_LIMITS)) {
    const value = get(col as CanonicalColumn);
    if (value !== null && value.length > limit) {
      errors.push(`${col} exceeds ${limit} characters`);
    }
  }

  const name = get("name");
  if (name === null) errors.push("name is required");

  const rawType = get("asset_type");
  let assetType: AssetType = "device";
  if (rawType !== null) {
    const normalized = normalizeHeader(rawType) as AssetType;
    if (!ASSET_TYPES.includes(normalized)) {
      errors.push(
        `invalid asset_type: ${rawType} (expected ${ASSET_TYPES.join(", ")})`,
      );
    } else {
      assetType = normalized;
    }
  }

  const rawStatus = get("status");
  let status: AssetStatus = "in_stock";
  if (rawStatus !== null) {
    const normalized = normalizeHeader(rawStatus) as AssetStatus;
    if (normalized === "deployed") {
      errors.push(
        "status deployed can only result from a check-out; import the asset as in_stock and check it out",
      );
    } else if (!IMPORT_STATUSES.includes(normalized)) {
      errors.push(
        `invalid status: ${rawStatus} (expected ${IMPORT_STATUSES.join(", ")})`,
      );
    } else {
      status = normalized;
    }
  }

  const locationName = get("location");
  const locationIdCell = get("location_id");
  let locationId: string | null = null;
  if (locationName !== null && locationIdCell !== null) {
    errors.push("provide either location or location_id, not both");
  } else if (locationIdCell !== null) {
    if (locations.byId.has(locationIdCell)) {
      locationId = locationIdCell;
    } else {
      errors.push(`unknown location_id: ${locationIdCell}`);
    }
  } else if (locationName !== null) {
    const bucket = locations.byName.get(locationName.toLowerCase()) ?? [];
    const single = bucket.length === 1 ? bucket[0] : undefined;
    if (bucket.length === 0) {
      errors.push(`unknown location: ${locationName}`);
    } else if (single === undefined) {
      errors.push(
        `ambiguous location: ${locationName} matches ${bucket.length} locations; use location_id`,
      );
    } else {
      locationId = single.id;
    }
  }

  const assetTag = get("asset_tag");
  const serialNumber = get("serial_number");
  const systemUuid = get("system_uuid");
  const assetTagNorm = normalizeIdentityKey(assetTag);
  const serialNumberNorm = normalizeIdentityKey(serialNumber);
  const systemUuidNorm = normalizeSystemUuid(systemUuid);
  if (
    assetTagNorm === null &&
    serialNumberNorm === null &&
    systemUuidNorm === null
  ) {
    errors.push(
      "at least one identity field (asset_tag, serial_number, system_uuid) is required so re-imports stay idempotent",
    );
  }

  const interfaces: NewAssetInterface[] = [];
  const macCell = get("mac_addresses");
  if (macCell !== null) {
    const seen = new Set<string>();
    for (const token of macCell.split(/[;\s]+/)) {
      if (token === "") continue;
      const mac = parseMac(token);
      if (mac === null) {
        errors.push(`invalid MAC address: ${token}`);
        continue;
      }
      if (seen.has(mac)) continue;
      seen.add(mac);
      interfaces.push({ mac });
    }
    if (interfaces.length > MAX_INTERFACES_PER_ROW) {
      errors.push(
        `too many MAC addresses: ${interfaces.length} exceeds the limit of ${MAX_INTERFACES_PER_ROW}`,
      );
    }
  }

  if (errors.length > 0) return { errors };
  return {
    plan: {
      // name is non-null here: a null pushed an error above.
      name: name as string,
      assetType,
      status,
      locationId,
      model: get("model"),
      manufacturer: get("manufacturer"),
      notes: get("notes"),
      assetTag,
      assetTagNorm,
      serialNumber,
      serialNumberNorm,
      systemUuid,
      systemUuidNorm,
      interfaces,
    },
  };
}

interface IdentitySpec {
  key: "assetTagNorm" | "serialNumberNorm" | "systemUuidNorm";
  field: "asset_tag" | "serial_number" | "system_uuid";
  norm: string | null;
}

function identitySpecs(plan: RowPlan): IdentitySpec[] {
  return [
    { key: "assetTagNorm", field: "asset_tag", norm: plan.assetTagNorm },
    {
      key: "serialNumberNorm",
      field: "serial_number",
      norm: plan.serialNumberNorm,
    },
    { key: "systemUuidNorm", field: "system_uuid", norm: plan.systemUuidNorm },
  ];
}

interface CollisionDetails {
  identity: {
    assetTag: string | null;
    serialNumber: string | null;
    systemUuid: string | null;
  };
  matches: {
    field: string;
    value: string;
    assetId: string;
    assetName: string;
  }[];
  reason: "multiple_assets" | "identity_mismatch" | "would_extend_identity";
}

type MatchOutcome =
  | { kind: "new" }
  | { kind: "duplicate"; asset: AssetRecord }
  | {
      kind: "collision";
      assets: AssetRecord[];
      message: string;
      details: CollisionDetails;
    };

/**
 * Exception-first matching. A row is a duplicate only when every identity
 * field it carries exactly matches ONE existing asset; anything else that
 * touches an existing asset — a differing field, a field the asset lacks,
 * or matches spread across several assets — is a collision for human
 * review. Nothing here ever updates an existing asset.
 */
async function matchExisting(
  store: Store,
  plan: RowPlan,
): Promise<MatchOutcome> {
  const specs = identitySpecs(plan).filter((s) => s.norm !== null);
  const matches: { spec: IdentitySpec; asset: AssetRecord }[] = [];
  for (const spec of specs) {
    const asset = await store.getAssetByIdentityKey(
      spec.key,
      spec.norm as string,
    );
    if (asset !== null) matches.push({ spec, asset });
  }
  const firstMatch = matches[0];
  if (firstMatch === undefined) return { kind: "new" };

  const distinct = new Map(matches.map((m) => [m.asset.id, m.asset]));
  const identity = {
    assetTag: plan.assetTag,
    serialNumber: plan.serialNumber,
    systemUuid: plan.systemUuid,
  };
  const matchDetails = matches.map((m) => ({
    field: m.spec.field,
    value: m.spec.norm as string,
    assetId: m.asset.id,
    assetName: m.asset.name,
  }));

  if (distinct.size > 1) {
    return {
      kind: "collision",
      assets: [...distinct.values()],
      message: `identity fields match ${distinct.size} different assets (${matchDetails
        .map((m) => `${m.field} -> ${m.assetId}`)
        .join(", ")}); review required`,
      details: { identity, matches: matchDetails, reason: "multiple_assets" },
    };
  }

  const asset = firstMatch.asset;
  const mismatched: string[] = [];
  const missingOnAsset: string[] = [];
  for (const spec of specs) {
    const assetValue = asset[spec.key];
    if (assetValue === spec.norm) continue;
    if (assetValue === null) missingOnAsset.push(spec.field);
    else mismatched.push(spec.field);
  }
  if (mismatched.length === 0 && missingOnAsset.length === 0) {
    return { kind: "duplicate", asset };
  }
  const matchedFields = matches.map((m) => m.spec.field).join(", ");
  const problems: string[] = [];
  if (mismatched.length > 0) {
    problems.push(`${mismatched.join(", ")} differs`);
  }
  if (missingOnAsset.length > 0) {
    problems.push(
      `would add ${missingOnAsset.join(", ")} to the existing asset`,
    );
  }
  return {
    kind: "collision",
    assets: [asset],
    message: `matches existing asset ${asset.id} on ${matchedFields} but ${problems.join(
      " and ",
    )}; review required`,
    details: {
      identity,
      matches: matchDetails,
      reason:
        mismatched.length > 0 ? "identity_mismatch" : "would_extend_identity",
    },
  };
}

/**
 * Stable fingerprint of a collision so re-running the same file does not
 * pile up duplicate OPEN exceptions. Resolved or dismissed exceptions do
 * not suppress a recurrence: if the conflict comes back after a human
 * closed it, that is new information and deserves a new record.
 */
function collisionSignature(plan: RowPlan, assetIds: string[]): string {
  return JSON.stringify({
    kind: "import_identity_collision",
    assetTagNorm: plan.assetTagNorm,
    serialNumberNorm: plan.serialNumberNorm,
    systemUuidNorm: plan.systemUuidNorm,
    assets: [...assetIds].sort(),
  });
}

async function loadOpenCollisionSignatures(
  store: Store,
): Promise<Set<string>> {
  const signatures = new Set<string>();
  // Single-statement snapshot for the same reason as loadLocationIndex.
  const open = await store.listExceptions({
    limit: SNAPSHOT_ROW_CAP,
    offset: 0,
    status: "open",
  });
  for (const exception of open) {
    if (exception.details === null) continue;
    try {
      const details = JSON.parse(exception.details) as {
        signature?: unknown;
      };
      if (typeof details.signature === "string") {
        signatures.add(details.signature);
      }
    } catch {
      // Not this module's JSON; ignore.
    }
  }
  return signatures;
}

/** In-file identity claims: norm value -> first row that used it. */
interface ClaimMaps {
  assetTagNorm: Map<string, number>;
  serialNumberNorm: Map<string, number>;
  systemUuidNorm: Map<string, number>;
}

interface RowResult {
  outcome: ImportRowOutcome;
  message: string | null;
  assetId: string | null;
  createdAsset: AssetRecord | null;
  collision: {
    plan: RowPlan;
    match: Extract<MatchOutcome, { kind: "collision" }>;
  } | null;
}

/** Actor/job context stamped onto audit entries written mid-run. */
interface RunAuditContext {
  jobId: string;
  actor: ImportActor;
  ip: string | null;
}

async function processRow(
  store: Store,
  cells: string[],
  headers: HeaderMap,
  locations: LocationIndex,
  claims: ClaimMaps,
  rowNumber: number,
  commit: boolean,
  audit: RunAuditContext,
): Promise<RowResult> {
  const rowError = (message: string): RowResult => ({
    outcome: "error",
    message,
    assetId: null,
    createdAsset: null,
    collision: null,
  });

  if (cells.length > headers.byIndex.length) {
    return rowError(
      `row has ${cells.length} cells but the header has ${headers.byIndex.length} columns`,
    );
  }
  const built = buildRowPlan(cells, headers, locations);
  if ("errors" in built) return rowError(built.errors.join("; "));
  const plan = built.plan;

  // In-file duplicates are file defects, not collisions: nothing exists in
  // the database to review. The first row wins the claim (whatever its own
  // later outcome) so a fix-and-re-run cannot create one identity twice.
  let duplicateOf: { field: string; row: number } | null = null;
  for (const spec of identitySpecs(plan)) {
    if (spec.norm === null) continue;
    const prior = claims[spec.key].get(spec.norm);
    if (prior !== undefined && duplicateOf === null) {
      duplicateOf = { field: spec.field, row: prior };
    }
    if (prior === undefined) claims[spec.key].set(spec.norm, rowNumber);
  }
  if (duplicateOf !== null) {
    return rowError(
      `duplicate ${duplicateOf.field} within the file (also in row ${duplicateOf.row})`,
    );
  }

  let match = await matchExisting(store, plan);
  if (match.kind === "new") {
    if (!commit) {
      return {
        outcome: "created",
        message: "would be created (dry run)",
        assetId: null,
        createdAsset: null,
        collision: null,
      };
    }
    try {
      const asset = await store.createAssetWithInterfaces(
        {
          name: plan.name,
          assetType: plan.assetType,
          status: plan.status,
          locationId: plan.locationId,
          model: plan.model,
          manufacturer: plan.manufacturer,
          notes: plan.notes,
          assetTag: plan.assetTag,
          assetTagNorm: plan.assetTagNorm,
          serialNumber: plan.serialNumber,
          serialNumberNorm: plan.serialNumberNorm,
          systemUuid: plan.systemUuid,
          systemUuidNorm: plan.systemUuidNorm,
        },
        plan.interfaces,
      );
      // Audited HERE, not after the whole run: if a later row aborts the
      // run, this asset is already persisted and must already be on the
      // trail (CLAUDE.md hard rule 5 / gate criterion 2).
      await store.appendAudit({
        action: "asset.create",
        actorUserId: audit.actor.actorUserId,
        actorEmail: audit.actor.actorEmail,
        entityType: "asset",
        entityId: asset.id,
        details: {
          before: null,
          after: assetSnapshot(asset),
          importJobId: audit.jobId,
        },
        ip: audit.ip,
      });
      return {
        outcome: "created",
        message: null,
        assetId: asset.id,
        createdAsset: asset,
        collision: null,
      };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Lost a race with a concurrent create: re-match so the row reports
      // the duplicate or collision it now is.
      match = await matchExisting(store, plan);
      if (match.kind === "new") {
        return rowError(
          "identity key conflict during create; re-run the import",
        );
      }
    }
  }
  if (match.kind === "duplicate") {
    return {
      outcome: "skipped_duplicate",
      message: "identical to existing asset",
      assetId: match.asset.id,
      createdAsset: null,
      collision: null,
    };
  }
  return {
    outcome: "collision",
    message: match.message,
    assetId: null,
    createdAsset: null,
    collision: { plan, match },
  };
}

export async function runAssetImport(
  store: Store,
  input: RunAssetImportInput,
): Promise<RunAssetImportResult> {
  const parsed = parseCsv(input.csvText);
  if (!parsed.ok) {
    return fail(400, "invalid_csv", parsed.message);
  }
  if (parsed.records.length === 0) {
    return fail(400, "invalid_csv", "empty CSV: a header row is required");
  }
  const headerRecord = parsed.records[0];
  if (headerRecord === undefined) {
    return fail(400, "invalid_csv", "empty CSV: a header row is required");
  }
  const headers = mapHeaders(headerRecord.cells);
  if ("ok" in headers) return headers;
  const dataRecords = parsed.records.slice(1);
  if (dataRecords.length === 0) {
    return fail(400, "invalid_csv", "no data rows after the header");
  }
  if (dataRecords.length > MAX_IMPORT_ROWS) {
    return fail(
      400,
      "too_many_rows",
      `too many rows: ${dataRecords.length} exceeds the limit of ${MAX_IMPORT_ROWS}`,
    );
  }

  const fileHash = hashCsv(input.csvText);
  const priorImport = await store.findCompletedImportByHash(fileHash);
  const locations = await loadLocationIndex(store);
  const commit = input.mode === "commit";
  // Snapshotted once per run. Two commits racing on the same conflict can
  // therefore still each raise an exception — accepted: duplicate OPEN
  // exceptions are review noise, never a merged identity, and later runs
  // dedupe against both.
  const openSignatures = commit
    ? await loadOpenCollisionSignatures(store)
    : new Set<string>();

  const job = await store.createImportJob({
    actorUserId: input.actor.actorUserId,
    actorEmail: input.actor.actorEmail,
    filename: input.filename,
    fileHash,
    mode: input.mode,
  });

  const rows: ImportRowRecord[] = [];
  const createdAssets: AssetRecord[] = [];
  const exceptions: ExceptionRecord[] = [];
  const counts = { created: 0, skipped: 0, collision: 0, error: 0 };
  const countKey = {
    created: "created",
    skipped_duplicate: "skipped",
    collision: "collision",
    error: "error",
  } as const;
  const claims: ClaimMaps = {
    assetTagNorm: new Map(),
    serialNumberNorm: new Map(),
    systemUuidNorm: new Map(),
  };

  try {
    for (let i = 0; i < dataRecords.length; i += 1) {
      const rowNumber = i + 1;
      const record = dataRecords[i];
      if (record === undefined) continue;
      const raw: Record<string, string> = {};
      for (let col = 0; col < headers.byIndex.length; col += 1) {
        const canonical = headers.byIndex[col];
        if (canonical === undefined) continue;
        raw[canonical] = record.cells[col] ?? "";
      }

      const result = await processRow(
        store,
        record.cells,
        headers,
        locations,
        claims,
        rowNumber,
        commit,
        { jobId: job.id, actor: input.actor, ip: input.ip },
      );
      const importRow = await store.appendImportRow({
        jobId: job.id,
        rowNumber,
        outcome: result.outcome,
        message: result.message,
        assetId: result.assetId,
        raw,
      });
      rows.push(importRow);
      counts[countKey[result.outcome]] += 1;
      if (result.createdAsset !== null) {
        createdAssets.push(result.createdAsset);
      }

      if (result.collision !== null && commit) {
        const assetIds = result.collision.match.assets.map((a) => a.id);
        const signature = collisionSignature(result.collision.plan, assetIds);
        if (!openSignatures.has(signature)) {
          openSignatures.add(signature);
          const exception = await store.createException({
            kind: "import_identity_collision",
            assetId: assetIds[0] ?? null,
            importRowId: importRow.id,
            details: {
              signature,
              jobId: job.id,
              rowNumber,
              ...result.collision.match.details,
            },
          });
          exceptions.push(exception);
          // Audited immediately for the same reason as asset.create in
          // processRow: a later abort must not orphan this mutation.
          await store.appendAudit({
            action: "exception.create",
            actorUserId: input.actor.actorUserId,
            actorEmail: input.actor.actorEmail,
            entityType: "exception",
            entityId: exception.id,
            details: {
              before: null,
              after: {
                kind: exception.kind,
                status: exception.status,
                assetId: exception.assetId,
                importRowId: exception.importRowId,
              },
              importJobId: job.id,
            },
            ip: input.ip,
          });
        }
      }
    }
  } catch (err) {
    // The rows processed so far are already persisted (and already
    // audited, entry by entry); mark the job failed with honest partial
    // counts and let the API surface the 500.
    try {
      await store.completeImportJob(job.id, {
        status: "failed",
        totalRows: dataRecords.length,
        createdCount: counts.created,
        skippedCount: counts.skipped,
        collisionCount: counts.collision,
        errorCount: counts.error,
      });
    } catch {
      // A dead DB here must not replace the original error.
    }
    throw err;
  }

  const completed = await store.completeImportJob(job.id, {
    status: "completed",
    totalRows: dataRecords.length,
    createdCount: counts.created,
    skippedCount: counts.skipped,
    collisionCount: counts.collision,
    errorCount: counts.error,
  });

  return {
    ok: true,
    job: completed ?? job,
    rows,
    priorImport,
    createdAssets,
    exceptions,
  };
}
