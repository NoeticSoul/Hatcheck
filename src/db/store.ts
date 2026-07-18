// Engine-agnostic data-access contract. Everything above this layer
// (routes, modules, seed) speaks only this interface, which is what keeps
// the dual-DB invariant enforceable: both store.sqlite.ts and store.pg.ts
// must satisfy this exact contract or the build fails.
import type { DbKind } from "../config";

export type Role = "admin" | "technician" | "readonly";
export type AuthSource = "local" | "oidc";

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  authSource: AuthSource;
  passwordHash: string | null;
  oidcSubject: string | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface NewUser {
  email: string;
  displayName: string;
  role: Role;
  authSource: AuthSource;
  passwordHash?: string | null;
  oidcSubject?: string | null;
  isActive?: boolean;
}

export interface UserPatch {
  displayName?: string;
  role?: Role;
  isActive?: boolean;
  passwordHash?: string | null;
}

export interface SessionRecord {
  tokenHash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
}

export interface NewSession {
  tokenHash: string;
  userId: string;
  expiresAt: number;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditEntry {
  id: string;
  at: number;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: string | null;
  ip: string | null;
}

export interface NewAuditEntry {
  actorUserId?: string | null;
  actorEmail?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  /** Serialized to a JSON string; no engine-specific JSON operators. */
  details?: unknown;
  ip?: string | null;
}

export interface AuditQuery {
  limit: number;
  offset?: number;
  action?: string;
}

// ---- Phase 1: Assets & Locations -----------------------------------------

export type LocationKind = "site" | "building" | "room";

export interface LocationRecord {
  id: string;
  name: string;
  kind: LocationKind;
  parentId: string | null;
  description: string | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface NewLocation {
  name: string;
  kind?: LocationKind;
  parentId?: string | null;
  description?: string | null;
  isActive?: boolean;
}

export interface LocationPatch {
  name?: string;
  kind?: LocationKind;
  parentId?: string | null;
  description?: string | null;
  isActive?: boolean;
}

export interface LocationQuery {
  limit: number;
  offset?: number;
  /** undefined = any parent; null = root locations only. */
  parentId?: string | null;
  kind?: LocationKind;
  /** Case-insensitive (ASCII) substring match on name. */
  q?: string;
  includeInactive?: boolean;
}

export type AssetType = "device" | "peripheral" | "license";
export type AssetStatus = "in_stock" | "deployed" | "in_repair" | "retired";

export interface AssetRecord {
  id: string;
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
  createdAt: number;
  updatedAt: number;
}

/**
 * Normalized shadow keys (`*Norm`) are computed by the caller via
 * src/modules/assets/identity.ts — the store persists them verbatim and
 * the database enforces their uniqueness (NULLs are distinct on both
 * engines, so absent keys never collide).
 */
export interface NewAsset {
  name: string;
  assetType?: AssetType;
  status?: AssetStatus;
  locationId?: string | null;
  model?: string | null;
  manufacturer?: string | null;
  notes?: string | null;
  assetTag?: string | null;
  assetTagNorm?: string | null;
  serialNumber?: string | null;
  serialNumberNorm?: string | null;
  systemUuid?: string | null;
  systemUuidNorm?: string | null;
}

export interface AssetPatch {
  name?: string;
  assetType?: AssetType;
  status?: AssetStatus;
  locationId?: string | null;
  model?: string | null;
  manufacturer?: string | null;
  notes?: string | null;
  assetTag?: string | null;
  assetTagNorm?: string | null;
  serialNumber?: string | null;
  serialNumberNorm?: string | null;
  systemUuid?: string | null;
  systemUuidNorm?: string | null;
}

export interface AssetQuery {
  limit: number;
  offset?: number;
  status?: AssetStatus;
  locationId?: string;
  assetType?: AssetType;
  /**
   * Substring match over name, model, manufacturer, assetTag, and
   * serialNumber via lower() LIKE — ASCII-case-insensitive on both
   * engines (SQLite lower() is ASCII-only; PG is locale-aware for
   * non-ASCII, an accepted and documented divergence).
   */
  q?: string;
}

export type AssetIdentityKey =
  | "assetTagNorm"
  | "serialNumberNorm"
  | "systemUuidNorm";

export interface AssetInterfaceRecord {
  id: string;
  assetId: string;
  mac: string;
  label: string | null;
  createdAt: number;
}

export interface NewAssetInterface {
  /** Canonical lower-case colon form from parseMac(). */
  mac: string;
  label?: string | null;
}

export type CustodyType = "check_out" | "check_in";

export interface CustodyEventRecord {
  id: string;
  assetId: string;
  at: number;
  type: CustodyType;
  holderUserId: string | null;
  holderName: string | null;
  locationId: string | null;
  locationName: string | null;
  note: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
}

export interface NewCustodyEvent {
  assetId: string;
  type: CustodyType;
  holderUserId?: string | null;
  holderName?: string | null;
  locationId?: string | null;
  locationName?: string | null;
  note?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
}

export type CustodyConflict = "already_checked_out" | "not_checked_out";

export type CustodyAppendResult =
  | { ok: true; event: CustodyEventRecord }
  | { ok: false; conflict: CustodyConflict };

export type ImportMode = "dry_run" | "commit";
export type ImportStatus = "running" | "completed" | "failed";
export type ImportRowOutcome =
  | "created"
  | "skipped_duplicate"
  | "collision"
  | "error";

export interface ImportJobRecord {
  id: string;
  at: number;
  actorUserId: string | null;
  actorEmail: string | null;
  filename: string | null;
  fileHash: string;
  mode: ImportMode;
  status: ImportStatus;
  totalRows: number;
  createdCount: number;
  skippedCount: number;
  collisionCount: number;
  errorCount: number;
}

export interface NewImportJob {
  actorUserId?: string | null;
  actorEmail?: string | null;
  filename?: string | null;
  fileHash: string;
  mode: ImportMode;
}

export interface ImportJobCompletion {
  status: "completed" | "failed";
  totalRows: number;
  createdCount: number;
  skippedCount: number;
  collisionCount: number;
  errorCount: number;
}

export interface ImportRowRecord {
  id: string;
  jobId: string;
  rowNumber: number;
  outcome: ImportRowOutcome;
  message: string | null;
  assetId: string | null;
  raw: string | null;
}

export interface NewImportRow {
  jobId: string;
  rowNumber: number;
  outcome: ImportRowOutcome;
  message?: string | null;
  assetId?: string | null;
  /** Serialized to a JSON string by the store. */
  raw?: unknown;
}

export type ExceptionKind = "import_identity_collision";
export type ExceptionStatus = "open" | "resolved" | "dismissed";

export interface ExceptionRecord {
  id: string;
  at: number;
  kind: ExceptionKind;
  status: ExceptionStatus;
  assetId: string | null;
  importRowId: string | null;
  details: string | null;
  resolvedByUserId: string | null;
  resolvedAt: number | null;
  resolutionNote: string | null;
}

export interface NewException {
  kind: ExceptionKind;
  assetId?: string | null;
  importRowId?: string | null;
  /** Serialized to a JSON string by the store. */
  details?: unknown;
}

export interface ExceptionResolution {
  status: "resolved" | "dismissed";
  resolvedByUserId?: string | null;
  resolutionNote?: string | null;
}

export interface Store {
  readonly kind: DbKind;
  /** Apply pending migrations for this engine. */
  migrate(): Promise<void>;
  close(): Promise<void>;

  // users
  createUser(user: NewUser): Promise<UserRecord>;
  getUserById(id: string): Promise<UserRecord | null>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  getUserByOidcSubject(subject: string): Promise<UserRecord | null>;
  listUsers(): Promise<UserRecord[]>;
  updateUser(id: string, patch: UserPatch): Promise<UserRecord | null>;
  countUsers(): Promise<number>;

  // sessions
  createSession(session: NewSession): Promise<void>;
  getSessionUser(
    tokenHash: string,
    now: number,
  ): Promise<{ session: SessionRecord; user: UserRecord } | null>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteSessionsForUser(userId: string): Promise<void>;
  deleteExpiredSessions(now: number): Promise<void>;

  // audit — append-only by design: no update or delete methods exist.
  appendAudit(entry: NewAuditEntry): Promise<AuditEntry>;
  listAudit(query: AuditQuery): Promise<AuditEntry[]>;
  countAudit(): Promise<number>;

  // settings
  getSetting(key: string): Promise<unknown>;
  setSetting(key: string, value: unknown): Promise<void>;

  // ---- Phase 1: Assets & Locations ---------------------------------------

  // locations
  createLocation(location: NewLocation): Promise<LocationRecord>;
  getLocationById(id: string): Promise<LocationRecord | null>;
  listLocations(query: LocationQuery): Promise<LocationRecord[]>;
  countLocations(query: Omit<LocationQuery, "limit" | "offset">): Promise<number>;
  countLocationChildren(parentId: string): Promise<number>;
  updateLocation(id: string, patch: LocationPatch): Promise<LocationRecord | null>;
  /**
   * Hard delete; throws the driver's FK violation when children or assets
   * still reference it (callers pre-check to return a clean 409).
   */
  deleteLocation(id: string): Promise<boolean>;

  // assets
  /** Atomic: asset row plus its interfaces in one transaction. */
  createAssetWithInterfaces(
    asset: NewAsset,
    interfaces: NewAssetInterface[],
  ): Promise<AssetRecord>;
  getAssetById(id: string): Promise<AssetRecord | null>;
  getAssetByIdentityKey(
    key: AssetIdentityKey,
    value: string,
  ): Promise<AssetRecord | null>;
  listAssets(query: AssetQuery): Promise<AssetRecord[]>;
  countAssets(query: Omit<AssetQuery, "limit" | "offset">): Promise<number>;
  updateAsset(id: string, patch: AssetPatch): Promise<AssetRecord | null>;
  /** Hard delete; interfaces and custody events cascade. */
  deleteAsset(id: string): Promise<boolean>;

  // asset interfaces
  addAssetInterface(
    assetId: string,
    iface: NewAssetInterface,
  ): Promise<AssetInterfaceRecord | null>;
  listAssetInterfaces(assetId: string): Promise<AssetInterfaceRecord[]>;
  deleteAssetInterface(id: string): Promise<boolean>;

  // custody — append-only by design: no update or delete methods exist.
  /**
   * Atomically appends a custody event and optionally updates the asset's
   * status in the same transaction. Enforces alternation inside that
   * transaction (a check_out on a held asset or a check_in on an idle one
   * returns a conflict instead of writing), so concurrent double
   * check-outs cannot race. Returns null when the asset does not exist.
   */
  appendCustodyEvent(
    event: NewCustodyEvent,
    newAssetStatus?: AssetStatus,
  ): Promise<CustodyAppendResult | null>;
  listCustodyEvents(
    assetId: string,
    opts: { limit: number; offset?: number },
  ): Promise<CustodyEventRecord[]>;
  countCustodyEvents(assetId: string): Promise<number>;
  /** Latest check_out with no later check_in, else null. Derived, never stored. */
  getCurrentCustody(assetId: string): Promise<CustodyEventRecord | null>;
  /** Batch form for list views: one event per currently-held asset. */
  getCurrentCustodyForAssets(assetIds: string[]): Promise<CustodyEventRecord[]>;

  // imports
  createImportJob(job: NewImportJob): Promise<ImportJobRecord>;
  completeImportJob(
    id: string,
    result: ImportJobCompletion,
  ): Promise<ImportJobRecord | null>;
  getImportJobById(id: string): Promise<ImportJobRecord | null>;
  listImportJobs(opts: { limit: number; offset?: number }): Promise<ImportJobRecord[]>;
  countImportJobs(): Promise<number>;
  /** Most recent completed commit-mode job with this file hash, if any. */
  findCompletedImportByHash(fileHash: string): Promise<ImportJobRecord | null>;
  appendImportRow(row: NewImportRow): Promise<ImportRowRecord>;
  listImportRows(
    jobId: string,
    opts: { limit: number; offset?: number },
  ): Promise<ImportRowRecord[]>;
  countImportRows(jobId: string): Promise<number>;

  // exceptions
  createException(exception: NewException): Promise<ExceptionRecord>;
  getExceptionById(id: string): Promise<ExceptionRecord | null>;
  listExceptions(opts: {
    limit: number;
    offset?: number;
    status?: ExceptionStatus;
  }): Promise<ExceptionRecord[]>;
  countExceptions(status?: ExceptionStatus): Promise<number>;
  resolveException(
    id: string,
    resolution: ExceptionResolution,
  ): Promise<ExceptionRecord | null>;
}

export function buildAuditRow(entry: NewAuditEntry): AuditEntry {
  return {
    id: crypto.randomUUID(),
    at: Date.now(),
    actorUserId: entry.actorUserId ?? null,
    actorEmail: entry.actorEmail ?? null,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    details:
      entry.details === undefined ? null : JSON.stringify(entry.details),
    ip: entry.ip ?? null,
  };
}

export function buildUserRow(user: NewUser): UserRecord {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    email: user.email.toLowerCase(),
    displayName: user.displayName,
    role: user.role,
    authSource: user.authSource,
    passwordHash: user.passwordHash ?? null,
    oidcSubject: user.oidcSubject ?? null,
    isActive: user.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  };
}
