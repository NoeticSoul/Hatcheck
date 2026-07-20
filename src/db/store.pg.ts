import { fileURLToPath } from "node:url";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
  type Column,
  type SQL,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { timeOrderedId } from "./id";
import * as schema from "./schema.pg";
import {
  buildAuditRow,
  buildUserRow,
  type AssetIdentityKey,
  type AssetInterfaceRecord,
  type AssetPatch,
  type AssetQuery,
  type AssetRecord,
  type AssetStatus,
  type AuditEntry,
  type AuditQuery,
  type CustodyAppendResult,
  type CustodyEventRecord,
  type ExceptionRecord,
  type ExceptionResolution,
  type ExceptionStatus,
  type ImportJobCompletion,
  type ImportJobRecord,
  type ImportRowRecord,
  type LocationPatch,
  type LocationQuery,
  type LocationRecord,
  type NewAsset,
  type NewAssetInterface,
  type NewAuditEntry,
  type NewCustodyEvent,
  type NewException,
  type NewImportJob,
  type NewImportRow,
  type NewLocation,
  type NewSession,
  type NewUser,
  type SessionRecord,
  type Store,
  type UserPatch,
  type UserRecord,
} from "./store";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("./migrations/pg", import.meta.url),
);

// ---- Phase 1 helpers ------------------------------------------------------
// The row builders are pure and engine-agnostic; they are duplicated in
// store.sqlite.core.ts because that module is SQLite-specific. Keep the
// copies identical so both engines produce byte-for-byte equal records.

/**
 * Portable ASCII-case-insensitive substring match: lower(column) LIKE
 * with the caller text backslash-escaped so % _ \ are literal. Never
 * ILIKE (PG-only) and never COLLATE (engine-specific).
 */
function ciContains(column: Column, text: string): SQL {
  // The pattern must be lowercased in JS to match lower(column): SQLite's
  // LIKE is already ASCII-case-insensitive and would mask a mixed-case
  // pattern, but PostgreSQL's LIKE is case-sensitive (caught by the PG
  // contract leg). Keep both engines on identical lowercase-vs-lowercase.
  const pattern =
    "%" + text.toLowerCase().replace(/[\\%_]/g, (ch) => "\\" + ch) + "%";
  return sql`lower(${column}) like ${pattern} escape '\\'`;
}

function byName<T extends { name: string; id: string }>(
  a: T,
  b: T,
): number {
  // Normalize in JS: SQLite orders by bytes, PostgreSQL by locale
  // collation; both stores re-sort so the engines agree exactly. The id
  // tie-breaker makes the order total, so equal names cannot reshuffle
  // between paginated queries.
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function buildLocationRow(location: NewLocation): LocationRecord {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: location.name,
    kind: location.kind ?? "room",
    parentId: location.parentId ?? null,
    description: location.description ?? null,
    isActive: location.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  };
}

function buildAssetRow(asset: NewAsset): AssetRecord {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: asset.name,
    assetType: asset.assetType ?? "device",
    status: asset.status ?? "in_stock",
    locationId: asset.locationId ?? null,
    model: asset.model ?? null,
    manufacturer: asset.manufacturer ?? null,
    notes: asset.notes ?? null,
    assetTag: asset.assetTag ?? null,
    assetTagNorm: asset.assetTagNorm ?? null,
    serialNumber: asset.serialNumber ?? null,
    serialNumberNorm: asset.serialNumberNorm ?? null,
    systemUuid: asset.systemUuid ?? null,
    systemUuidNorm: asset.systemUuidNorm ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

function buildInterfaceRow(
  assetId: string,
  iface: NewAssetInterface,
): AssetInterfaceRecord {
  return {
    id: crypto.randomUUID(),
    assetId,
    mac: iface.mac,
    label: iface.label ?? null,
    createdAt: Date.now(),
  };
}

function buildCustodyRow(event: NewCustodyEvent): CustodyEventRecord {
  return {
    id: timeOrderedId(),
    assetId: event.assetId,
    at: Date.now(),
    type: event.type,
    holderUserId: event.holderUserId ?? null,
    holderName: event.holderName ?? null,
    locationId: event.locationId ?? null,
    locationName: event.locationName ?? null,
    note: event.note ?? null,
    actorUserId: event.actorUserId ?? null,
    actorEmail: event.actorEmail ?? null,
  };
}

function buildImportJobRow(job: NewImportJob): ImportJobRecord {
  return {
    // Time-ordered so (at desc, id desc) is a total newest-first order
    // even for same-millisecond jobs.
    id: timeOrderedId(),
    at: Date.now(),
    actorUserId: job.actorUserId ?? null,
    actorEmail: job.actorEmail ?? null,
    filename: job.filename ?? null,
    fileHash: job.fileHash,
    mode: job.mode,
    status: "running",
    totalRows: 0,
    createdCount: 0,
    skippedCount: 0,
    collisionCount: 0,
    errorCount: 0,
  };
}

function buildImportRowRow(row: NewImportRow): ImportRowRecord {
  return {
    id: timeOrderedId(),
    jobId: row.jobId,
    rowNumber: row.rowNumber,
    outcome: row.outcome,
    message: row.message ?? null,
    assetId: row.assetId ?? null,
    raw: row.raw === undefined ? null : JSON.stringify(row.raw),
  };
}

function buildExceptionRow(exception: NewException): ExceptionRecord {
  return {
    // Time-ordered for the same reason as import jobs.
    id: timeOrderedId(),
    at: Date.now(),
    kind: exception.kind,
    status: "open",
    assetId: exception.assetId ?? null,
    importRowId: exception.importRowId ?? null,
    details:
      exception.details === undefined
        ? null
        : JSON.stringify(exception.details),
    resolvedByUserId: null,
    resolvedAt: null,
    resolutionNote: null,
  };
}

function locationConditions(
  query: Omit<LocationQuery, "limit" | "offset">,
): SQL | undefined {
  const conditions: SQL[] = [];
  if (query.parentId !== undefined) {
    conditions.push(
      query.parentId === null
        ? isNull(schema.locations.parentId)
        : eq(schema.locations.parentId, query.parentId),
    );
  }
  if (query.kind !== undefined) {
    conditions.push(eq(schema.locations.kind, query.kind));
  }
  if (query.q !== undefined && query.q !== "") {
    conditions.push(ciContains(schema.locations.name, query.q));
  }
  if (!query.includeInactive) {
    conditions.push(eq(schema.locations.isActive, true));
  }
  return conditions.length === 0 ? undefined : and(...conditions);
}

function assetConditions(
  query: Omit<AssetQuery, "limit" | "offset">,
): SQL | undefined {
  const conditions: SQL[] = [];
  if (query.status !== undefined) {
    conditions.push(eq(schema.assets.status, query.status));
  }
  if (query.locationId !== undefined) {
    conditions.push(eq(schema.assets.locationId, query.locationId));
  }
  if (query.assetType !== undefined) {
    conditions.push(eq(schema.assets.assetType, query.assetType));
  }
  if (query.q !== undefined && query.q !== "") {
    const match = or(
      ciContains(schema.assets.name, query.q),
      ciContains(schema.assets.model, query.q),
      ciContains(schema.assets.manufacturer, query.q),
      ciContains(schema.assets.assetTag, query.q),
      ciContains(schema.assets.serialNumber, query.q),
    );
    if (match !== undefined) {
      conditions.push(match);
    }
  }
  if (query.heldByUserId !== undefined) {
    conditions.push(currentlyHeldBy(query.heldByUserId));
  }
  return conditions.length === 0 ? undefined : and(...conditions);
}

/**
 * Correlated subquery selecting only each asset's latest custody event by
 * (at desc, id desc): portable across both engines, no window functions.
 */
function isLatestCustodyEvent(): SQL {
  return sql`${schema.custodyEvents.id} = (select ce2.id from custody_events ce2 where ce2.asset_id = ${schema.custodyEvents.assetId} order by ce2.at desc, ce2.id desc limit 1)`;
}

/**
 * Matches assets whose CURRENT custody event — the latest by (at desc,
 * id desc) — is a check_out held by the given user. Same portable
 * correlated-subquery style as isLatestCustodyEvent; past holders and
 * checked-in assets never match.
 */
function currentlyHeldBy(userId: string): SQL {
  return sql`exists (select 1 from custody_events ce where ce.asset_id = ${schema.assets.id} and ce.type = 'check_out' and ce.holder_user_id = ${userId} and ce.id = (select ce2.id from custody_events ce2 where ce2.asset_id = ${schema.assets.id} order by ce2.at desc, ce2.id desc limit 1))`;
}

export function createPgStore(databaseUrl: string): Store {
  const client = postgres(databaseUrl, { max: 10 });
  const db = drizzle(client, { schema });

  return {
    kind: "postgres",

    async migrate() {
      // The migrator needs its own single connection.
      const migrationClient = postgres(databaseUrl, { max: 1 });
      try {
        await migrate(drizzle(migrationClient), {
          // Env override read at migrate() time; see sqliteMigrationsFolder.
          migrationsFolder:
            process.env.HATCHECK_PG_MIGRATIONS_DIR ?? MIGRATIONS_DIR,
        });
      } finally {
        await migrationClient.end();
      }
    },

    async close() {
      await client.end();
    },

    async createUser(user: NewUser): Promise<UserRecord> {
      const row = buildUserRow(user);
      await db.insert(schema.users).values(row);
      return row;
    },

    async getUserById(id: string): Promise<UserRecord | null> {
      const rows = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async getUserByEmail(email: string): Promise<UserRecord | null> {
      const rows = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email.toLowerCase()))
        .limit(1);
      return rows[0] ?? null;
    },

    async getUserByOidcSubject(subject: string): Promise<UserRecord | null> {
      const rows = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.oidcSubject, subject))
        .limit(1);
      return rows[0] ?? null;
    },

    async listUsers(): Promise<UserRecord[]> {
      const rows = await db
        .select()
        .from(schema.users)
        .orderBy(asc(schema.users.email));
      // Normalize in JS: SQLite orders by bytes, PostgreSQL by locale
      // collation; both stores re-sort so the engines agree exactly.
      return rows.sort((a, b) =>
        a.email < b.email ? -1 : a.email > b.email ? 1 : 0,
      );
    },

    async updateUser(id: string, patch: UserPatch): Promise<UserRecord | null> {
      const rows = await db
        .update(schema.users)
        .set({ ...patch, updatedAt: Date.now() })
        .where(eq(schema.users.id, id))
        .returning();
      return rows[0] ?? null;
    },

    async countUsers(): Promise<number> {
      const rows = await db.select({ n: count() }).from(schema.users);
      return rows[0]?.n ?? 0;
    },

    async createSession(session: NewSession): Promise<void> {
      await db.insert(schema.sessions).values({
        tokenHash: session.tokenHash,
        userId: session.userId,
        createdAt: Date.now(),
        expiresAt: session.expiresAt,
        ip: session.ip ?? null,
        userAgent: session.userAgent ?? null,
      });
    },

    async getSessionUser(
      tokenHash: string,
      now: number,
    ): Promise<{ session: SessionRecord; user: UserRecord } | null> {
      const rows = await db
        .select({ session: schema.sessions, user: schema.users })
        .from(schema.sessions)
        .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
        .where(
          and(
            eq(schema.sessions.tokenHash, tokenHash),
            gt(schema.sessions.expiresAt, now),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async deleteSession(tokenHash: string): Promise<void> {
      await db
        .delete(schema.sessions)
        .where(eq(schema.sessions.tokenHash, tokenHash));
    },

    async deleteSessionsForUser(userId: string): Promise<void> {
      await db
        .delete(schema.sessions)
        .where(eq(schema.sessions.userId, userId));
    },

    async deleteExpiredSessions(now: number): Promise<void> {
      await db
        .delete(schema.sessions)
        .where(lt(schema.sessions.expiresAt, now));
    },

    async appendAudit(entry: NewAuditEntry): Promise<AuditEntry> {
      const row = buildAuditRow(entry);
      await db.insert(schema.auditLog).values(row);
      return row;
    },

    async listAudit(query: AuditQuery): Promise<AuditEntry[]> {
      const conditions = query.action
        ? eq(schema.auditLog.action, query.action)
        : undefined;
      return db
        .select()
        .from(schema.auditLog)
        .where(conditions)
        .orderBy(desc(schema.auditLog.at), desc(schema.auditLog.id))
        .limit(query.limit)
        .offset(query.offset ?? 0);
    },

    async countAudit(query?: { action?: string }): Promise<number> {
      const conditions = query?.action
        ? eq(schema.auditLog.action, query.action)
        : undefined;
      const rows = await db
        .select({ n: count() })
        .from(schema.auditLog)
        .where(conditions);
      return rows[0]?.n ?? 0;
    },

    async getSetting(key: string): Promise<unknown> {
      const rows = await db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.key, key))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : JSON.parse(row.value);
    },

    async setSetting(key: string, value: unknown): Promise<void> {
      const now = Date.now();
      const serialized = JSON.stringify(value);
      await db
        .insert(schema.settings)
        .values({ key, value: serialized, updatedAt: now })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: serialized, updatedAt: now },
        });
    },

    // ---- Phase 1: locations ------------------------------------------------

    async createLocation(location: NewLocation): Promise<LocationRecord> {
      const row = buildLocationRow(location);
      await db.insert(schema.locations).values(row);
      return row;
    },

    async getLocationById(id: string): Promise<LocationRecord | null> {
      const rows = await db
        .select()
        .from(schema.locations)
        .where(eq(schema.locations.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async listLocations(query: LocationQuery): Promise<LocationRecord[]> {
      const rows = await db
        .select()
        .from(schema.locations)
        .where(locationConditions(query))
        .orderBy(asc(schema.locations.name), asc(schema.locations.id))
        .limit(query.limit)
        .offset(query.offset ?? 0);
      return rows.sort(byName);
    },

    async countLocations(
      query: Omit<LocationQuery, "limit" | "offset">,
    ): Promise<number> {
      const rows = await db
        .select({ n: count() })
        .from(schema.locations)
        .where(locationConditions(query));
      return rows[0]?.n ?? 0;
    },

    async countLocationChildren(parentId: string): Promise<number> {
      const rows = await db
        .select({ n: count() })
        .from(schema.locations)
        .where(eq(schema.locations.parentId, parentId));
      return rows[0]?.n ?? 0;
    },

    async updateLocation(
      id: string,
      patch: LocationPatch,
    ): Promise<LocationRecord | null> {
      const rows = await db
        .update(schema.locations)
        .set({ ...patch, updatedAt: Date.now() })
        .where(eq(schema.locations.id, id))
        .returning();
      return rows[0] ?? null;
    },

    async deleteLocation(id: string): Promise<boolean> {
      const rows = await db
        .select({ id: schema.locations.id })
        .from(schema.locations)
        .where(eq(schema.locations.id, id))
        .limit(1);
      if (rows.length === 0) {
        return false;
      }
      // Intentionally lets the driver's FK-restrict error propagate when
      // children or assets still reference this location.
      await db.delete(schema.locations).where(eq(schema.locations.id, id));
      return true;
    },

    // ---- Phase 1: assets ---------------------------------------------------

    async createAssetWithInterfaces(
      asset: NewAsset,
      interfaces: NewAssetInterface[],
    ): Promise<AssetRecord> {
      const row = buildAssetRow(asset);
      await db.transaction(async (tx) => {
        await tx.insert(schema.assets).values(row);
        for (const iface of interfaces) {
          await tx
            .insert(schema.assetInterfaces)
            .values(buildInterfaceRow(row.id, iface));
        }
      });
      return row;
    },

    async getAssetById(id: string): Promise<AssetRecord | null> {
      const rows = await db
        .select()
        .from(schema.assets)
        .where(eq(schema.assets.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async getAssetByIdentityKey(
      key: AssetIdentityKey,
      value: string,
    ): Promise<AssetRecord | null> {
      const column =
        key === "assetTagNorm"
          ? schema.assets.assetTagNorm
          : key === "serialNumberNorm"
            ? schema.assets.serialNumberNorm
            : schema.assets.systemUuidNorm;
      const rows = await db
        .select()
        .from(schema.assets)
        .where(eq(column, value))
        .limit(1);
      return rows[0] ?? null;
    },

    async listAssets(query: AssetQuery): Promise<AssetRecord[]> {
      const rows = await db
        .select()
        .from(schema.assets)
        .where(assetConditions(query))
        .orderBy(asc(schema.assets.name), asc(schema.assets.id))
        .limit(query.limit)
        .offset(query.offset ?? 0);
      return rows.sort(byName);
    },

    async countAssets(
      query: Omit<AssetQuery, "limit" | "offset">,
    ): Promise<number> {
      const rows = await db
        .select({ n: count() })
        .from(schema.assets)
        .where(assetConditions(query));
      return rows[0]?.n ?? 0;
    },

    async updateAsset(
      id: string,
      patch: AssetPatch,
      guard?: { statusNot: AssetStatus },
    ): Promise<AssetRecord | null> {
      const rows = await db
        .update(schema.assets)
        .set({ ...patch, updatedAt: Date.now() })
        .where(
          guard === undefined
            ? eq(schema.assets.id, id)
            : and(
                eq(schema.assets.id, id),
                ne(schema.assets.status, guard.statusNot),
              ),
        )
        .returning();
      return rows[0] ?? null;
    },

    async deleteAsset(id: string): Promise<boolean> {
      const rows = await db
        .select({ id: schema.assets.id })
        .from(schema.assets)
        .where(eq(schema.assets.id, id))
        .limit(1);
      if (rows.length === 0) {
        return false;
      }
      await db.delete(schema.assets).where(eq(schema.assets.id, id));
      return true;
    },

    // ---- Phase 1: asset interfaces ----------------------------------------

    async addAssetInterface(
      assetId: string,
      iface: NewAssetInterface,
    ): Promise<AssetInterfaceRecord | null> {
      const assetRows = await db
        .select({ id: schema.assets.id })
        .from(schema.assets)
        .where(eq(schema.assets.id, assetId))
        .limit(1);
      if (assetRows.length === 0) {
        return null;
      }
      const row = buildInterfaceRow(assetId, iface);
      await db.insert(schema.assetInterfaces).values(row);
      return row;
    },

    async listInterfacesForAssets(
      assetIds: string[],
    ): Promise<AssetInterfaceRecord[]> {
      if (assetIds.length === 0) return [];
      return db
        .select()
        .from(schema.assetInterfaces)
        .where(inArray(schema.assetInterfaces.assetId, assetIds))
        .orderBy(
          asc(schema.assetInterfaces.assetId),
          asc(schema.assetInterfaces.createdAt),
          asc(schema.assetInterfaces.id),
        );
    },

    async listAssetInterfaces(
      assetId: string,
    ): Promise<AssetInterfaceRecord[]> {
      return db
        .select()
        .from(schema.assetInterfaces)
        .where(eq(schema.assetInterfaces.assetId, assetId))
        .orderBy(
          asc(schema.assetInterfaces.createdAt),
          asc(schema.assetInterfaces.id),
        );
    },

    async deleteAssetInterface(id: string): Promise<boolean> {
      const rows = await db
        .select({ id: schema.assetInterfaces.id })
        .from(schema.assetInterfaces)
        .where(eq(schema.assetInterfaces.id, id))
        .limit(1);
      if (rows.length === 0) {
        return false;
      }
      await db
        .delete(schema.assetInterfaces)
        .where(eq(schema.assetInterfaces.id, id));
      return true;
    },

    // ---- Phase 1: custody --------------------------------------------------

    async appendCustodyEvent(
      event: NewCustodyEvent,
      newAssetStatus?: AssetStatus,
      newAssetLocationId?: string | null,
      requireStatus?: AssetStatus,
    ): Promise<CustodyAppendResult | null> {
      // The asset row is locked (FOR UPDATE) before the alternation check:
      // at READ COMMITTED two concurrent check-outs would otherwise both
      // read "no open check_out" and both insert. The lock serializes
      // appends per asset, matching SQLite's inherent serialization.
      return db.transaction(
        async (tx): Promise<CustodyAppendResult | null> => {
          const assetRows = await tx
            .select({
              id: schema.assets.id,
              status: schema.assets.status,
              locationId: schema.assets.locationId,
            })
            .from(schema.assets)
            .where(eq(schema.assets.id, event.assetId))
            .limit(1)
            .for("update");
          const asset = assetRows[0];
          if (asset === undefined) {
            return null;
          }
          if (requireStatus !== undefined && asset.status !== requireStatus) {
            return {
              ok: false,
              conflict: "status_conflict",
              actualStatus: asset.status,
            };
          }
          const latestRows = await tx
            .select()
            .from(schema.custodyEvents)
            .where(eq(schema.custodyEvents.assetId, event.assetId))
            .orderBy(
              desc(schema.custodyEvents.at),
              desc(schema.custodyEvents.id),
            )
            .limit(1);
          const latest = latestRows[0];
          if (event.type === "check_out") {
            if (latest !== undefined && latest.type === "check_out") {
              return { ok: false, conflict: "already_checked_out" };
            }
          } else {
            if (latest === undefined || latest.type !== "check_out") {
              return { ok: false, conflict: "not_checked_out" };
            }
          }
          const row = buildCustodyRow(event);
          await tx.insert(schema.custodyEvents).values(row);
          if (
            newAssetStatus !== undefined ||
            newAssetLocationId !== undefined
          ) {
            const patch: AssetPatch = {};
            if (newAssetStatus !== undefined) patch.status = newAssetStatus;
            if (newAssetLocationId !== undefined) {
              patch.locationId = newAssetLocationId;
            }
            await tx
              .update(schema.assets)
              .set({ ...patch, updatedAt: Date.now() })
              .where(eq(schema.assets.id, event.assetId));
          }
          const assetBefore = {
            status: asset.status,
            locationId: asset.locationId,
          };
          return {
            ok: true,
            event: row,
            assetBefore,
            assetAfter: {
              status: newAssetStatus ?? assetBefore.status,
              locationId:
                newAssetLocationId !== undefined
                  ? newAssetLocationId
                  : assetBefore.locationId,
            },
          };
        },
      );
    },

    async listCustodyEvents(
      assetId: string,
      opts: { limit: number; offset?: number },
    ): Promise<CustodyEventRecord[]> {
      return db
        .select()
        .from(schema.custodyEvents)
        .where(eq(schema.custodyEvents.assetId, assetId))
        .orderBy(desc(schema.custodyEvents.at), desc(schema.custodyEvents.id))
        .limit(opts.limit)
        .offset(opts.offset ?? 0);
    },

    async countCustodyEvents(assetId: string): Promise<number> {
      const rows = await db
        .select({ n: count() })
        .from(schema.custodyEvents)
        .where(eq(schema.custodyEvents.assetId, assetId));
      return rows[0]?.n ?? 0;
    },

    async getCurrentCustody(
      assetId: string,
    ): Promise<CustodyEventRecord | null> {
      const rows = await db
        .select()
        .from(schema.custodyEvents)
        .where(eq(schema.custodyEvents.assetId, assetId))
        .orderBy(desc(schema.custodyEvents.at), desc(schema.custodyEvents.id))
        .limit(1);
      const latest = rows[0];
      return latest !== undefined && latest.type === "check_out"
        ? latest
        : null;
    },

    async getCurrentCustodyForAssets(
      assetIds: string[],
    ): Promise<CustodyEventRecord[]> {
      if (assetIds.length === 0) {
        return [];
      }
      return db
        .select()
        .from(schema.custodyEvents)
        .where(
          and(
            inArray(schema.custodyEvents.assetId, assetIds),
            eq(schema.custodyEvents.type, "check_out"),
            isLatestCustodyEvent(),
          ),
        );
    },

    // ---- Phase 1: imports --------------------------------------------------

    async createImportJob(job: NewImportJob): Promise<ImportJobRecord> {
      const row = buildImportJobRow(job);
      await db.insert(schema.importJobs).values(row);
      return row;
    },

    async completeImportJob(
      id: string,
      result: ImportJobCompletion,
    ): Promise<ImportJobRecord | null> {
      const rows = await db
        .update(schema.importJobs)
        .set({
          status: result.status,
          totalRows: result.totalRows,
          createdCount: result.createdCount,
          skippedCount: result.skippedCount,
          collisionCount: result.collisionCount,
          errorCount: result.errorCount,
        })
        .where(eq(schema.importJobs.id, id))
        .returning();
      return rows[0] ?? null;
    },

    async getImportJobById(id: string): Promise<ImportJobRecord | null> {
      const rows = await db
        .select()
        .from(schema.importJobs)
        .where(eq(schema.importJobs.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async listImportJobs(opts: {
      limit: number;
      offset?: number;
    }): Promise<ImportJobRecord[]> {
      return db
        .select()
        .from(schema.importJobs)
        .orderBy(desc(schema.importJobs.at), desc(schema.importJobs.id))
        .limit(opts.limit)
        .offset(opts.offset ?? 0);
    },

    async countImportJobs(): Promise<number> {
      const rows = await db.select({ n: count() }).from(schema.importJobs);
      return rows[0]?.n ?? 0;
    },

    async findCompletedImportByHash(
      fileHash: string,
    ): Promise<ImportJobRecord | null> {
      const rows = await db
        .select()
        .from(schema.importJobs)
        .where(
          and(
            eq(schema.importJobs.fileHash, fileHash),
            eq(schema.importJobs.mode, "commit"),
            eq(schema.importJobs.status, "completed"),
          ),
        )
        .orderBy(desc(schema.importJobs.at), desc(schema.importJobs.id))
        .limit(1);
      return rows[0] ?? null;
    },

    async appendImportRow(row: NewImportRow): Promise<ImportRowRecord> {
      const record = buildImportRowRow(row);
      await db.insert(schema.importRows).values(record);
      return record;
    },

    async listImportRows(
      jobId: string,
      opts: { limit: number; offset?: number },
    ): Promise<ImportRowRecord[]> {
      // Time-ordered ids make id asc the append order.
      return db
        .select()
        .from(schema.importRows)
        .where(eq(schema.importRows.jobId, jobId))
        .orderBy(asc(schema.importRows.id))
        .limit(opts.limit)
        .offset(opts.offset ?? 0);
    },

    async countImportRows(jobId: string): Promise<number> {
      const rows = await db
        .select({ n: count() })
        .from(schema.importRows)
        .where(eq(schema.importRows.jobId, jobId));
      return rows[0]?.n ?? 0;
    },

    // ---- Phase 1: exceptions ----------------------------------------------

    async createException(exception: NewException): Promise<ExceptionRecord> {
      const row = buildExceptionRow(exception);
      await db.insert(schema.exceptionRecords).values(row);
      return row;
    },

    async getExceptionById(id: string): Promise<ExceptionRecord | null> {
      const rows = await db
        .select()
        .from(schema.exceptionRecords)
        .where(eq(schema.exceptionRecords.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async listExceptions(opts: {
      limit: number;
      offset?: number;
      status?: ExceptionStatus;
    }): Promise<ExceptionRecord[]> {
      const conditions =
        opts.status !== undefined
          ? eq(schema.exceptionRecords.status, opts.status)
          : undefined;
      return db
        .select()
        .from(schema.exceptionRecords)
        .where(conditions)
        .orderBy(
          desc(schema.exceptionRecords.at),
          desc(schema.exceptionRecords.id),
        )
        .limit(opts.limit)
        .offset(opts.offset ?? 0);
    },

    async countExceptions(status?: ExceptionStatus): Promise<number> {
      const conditions =
        status !== undefined
          ? eq(schema.exceptionRecords.status, status)
          : undefined;
      const rows = await db
        .select({ n: count() })
        .from(schema.exceptionRecords)
        .where(conditions);
      return rows[0]?.n ?? 0;
    },

    async resolveException(
      id: string,
      resolution: ExceptionResolution,
    ): Promise<ExceptionRecord | null> {
      // The UPDATE itself carries status = 'open', closing the
      // read-then-write window where two concurrent resolves could both
      // pass a caller's pre-check and silently overwrite each other
      // (same pattern as updateAsset's statusNot guard).
      const rows = await db
        .update(schema.exceptionRecords)
        .set({
          status: resolution.status,
          resolvedByUserId: resolution.resolvedByUserId ?? null,
          resolvedAt: Date.now(),
          resolutionNote: resolution.resolutionNote ?? null,
        })
        .where(
          and(
            eq(schema.exceptionRecords.id, id),
            eq(schema.exceptionRecords.status, "open"),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },
  };
}
