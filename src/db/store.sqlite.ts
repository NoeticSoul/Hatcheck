// Runtime dispatch for the SQLite store. Bun cannot load better-sqlite3's
// native addon on Windows, and the Phase 3 compiled binary needs bun:sqlite
// anyway, so: Bun runs use bun:sqlite, Node runs (vitest, plain Node) use
// better-sqlite3. Both produce the same Store over the same schema and
// migrations; the imports are dynamic so neither runtime ever loads the
// other's driver.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Store } from "./store";

export async function createSqliteStore(sqlitePath: string): Promise<Store> {
  if (sqlitePath !== ":memory:") {
    mkdirSync(dirname(resolve(sqlitePath)), { recursive: true });
  }
  if (process.versions.bun !== undefined) {
    const { createBunSqliteStore } = await import("./store.sqlite.bun");
    return createBunSqliteStore(sqlitePath);
  }
  const { createNodeSqliteStore } = await import("./store.sqlite.node");
  return createNodeSqliteStore(sqlitePath);
}
