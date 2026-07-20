// SQLite store on better-sqlite3 — the driver used when running under
// Node (vitest workers, plain Node servers). Do not import this module
// under Bun; go through createSqliteStore in store.sqlite.ts.
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.sqlite";
import type { Store } from "./store";
import { buildSqliteStore, sqliteMigrationsFolder } from "./store.sqlite.core";

export function createNodeSqliteStore(sqlitePath: string): Store {
  const sqlite = new Database(sqlitePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });

  return buildSqliteStore(db, {
    migrate: () => migrate(db, { migrationsFolder: sqliteMigrationsFolder() }),
    close: () => sqlite.close(),
  });
}
