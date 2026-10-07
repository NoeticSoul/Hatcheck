import postgres from "postgres";
import type { AppConfig } from "../config";
import type { Store } from "../db/store";
import { ensureInitialAdmin } from "./bootstrap";
import { postgresSslOptions } from "../db/postgres-options";

/** One owner performs migrations and bootstrap; runtime workers skip both. */
export async function initializeStore(config: AppConfig, store: Store): Promise<void> {
  const initialize = async () => {
    if (config.runtime.migrate) await store.migrate();
    if (config.runtime.bootstrap) await ensureInitialAdmin(store);
  };
  if (!config.runtime.migrate && !config.runtime.bootstrap) return;
  if (config.db.kind !== "postgres" || config.db.databaseUrl === null) {
    // SQLite deployments run one writer process. Use the explicit migration
    // command before starting additional workers; see OPERATIONS.md.
    await initialize();
    return;
  }

  const sql = postgres(config.db.databaseUrl, { ...postgresSslOptions(config.db), max: 1, connect_timeout: 10 });
  try {
    const connection = await sql.reserve();
    try {
      // The lock is session-scoped on a reserved connection: migrations use
      // their own connection pool, so a transaction-scoped lock cannot cover
      // the entire initialization sequence.
      await connection`select pg_advisory_lock(753223850)`;
      try {
        await initialize();
        const runtimeRole = process.env.POSTGRES_RUNTIME_ROLE;
        if (config.runtime.migrate && runtimeRole !== undefined) {
          // Publish the complete permission set together, without a window
          // where an existing worker could rewrite an append-only table.
          await connection`begin`;
          try {
            await connection`grant usage on schema public to ${connection(runtimeRole)}`;
            await connection`grant select, insert, update, delete on all tables in schema public to ${connection(runtimeRole)}`;
            await connection`grant usage, select on all sequences in schema public to ${connection(runtimeRole)}`;
            // Application-account compromise must not rewrite history. FK
            // cascades still support audited admin deletion of an asset.
            await connection`revoke update, delete, truncate on public.audit_log, public.custody_events from ${connection(runtimeRole)}`;
            const [revisions] = await connection<{ present: boolean }[]>`select to_regclass('public.document_revisions') is not null as present`;
            if (revisions?.present) {
              await connection`revoke update, delete, truncate on public.document_revisions from ${connection(runtimeRole)}`;
            }
            await connection`commit`;
          } catch (error) {
            await connection`rollback`;
            throw error;
          }
        }
      } finally {
        await connection`select pg_advisory_unlock(753223850)`;
      }
    } finally {
      connection.release();
    }
  } finally {
    await sql.end();
  }
}
