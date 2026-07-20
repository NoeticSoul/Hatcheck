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
  // Computed specifier on purpose: a literal one lets bun build --compile
  // inline this module, which hoists its top-level better-sqlite3 import
  // into the binary's startup path — where it cannot resolve. Node
  // resolves the runtime dynamic import exactly the same either way; the
  // branch is unreachable under Bun.
  const nodeDriver = "./store.sqlite.node";
  const { createNodeSqliteStore } = (await import(nodeDriver)) as {
    createNodeSqliteStore: (path: string) => Store;
  };
  return createNodeSqliteStore(sqlitePath);
}
