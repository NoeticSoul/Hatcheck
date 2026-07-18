// SQLite store on bun:sqlite — the driver used when running under Bun.
// bun:sqlite is the one sanctioned Bun-only API in a core path (CLAUDE.md
// stack rule requires a documented reason): better-sqlite3's native addon
// does not load under Bun on Windows (Bun issue #4290), and the Phase 3
// single-file `bun build --compile` distribution requires bun:sqlite
// regardless. Node runs take store.sqlite.node.ts instead; the dispatch
// lives in store.sqlite.ts.
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema.sqlite";
import type { Store } from "./store";
import { buildSqliteStore, SQLITE_MIGRATIONS_DIR } from "./store.sqlite.core";

export function createBunSqliteStore(sqlitePath: string): Store {
  const sqlite = new Database(sqlitePath, { create: true, readwrite: true });
  sqlite.run("PRAGMA journal_mode = WAL;");
  sqlite.run("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema });

  return buildSqliteStore(db, {
    migrate: () => migrate(db, { migrationsFolder: SQLITE_MIGRATIONS_DIR }),
    close: () => sqlite.close(),
  });
}
