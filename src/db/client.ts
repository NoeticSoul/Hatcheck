import type { AppConfig } from "../config";
import type { Store } from "./store";
import { createPgStore } from "./store.pg";
import { createSqliteStore } from "./store.sqlite";

export function createStore(config: AppConfig): Store {
  if (config.db.kind === "postgres") {
    if (!config.db.databaseUrl) {
      throw new Error("postgres mode requires DATABASE_URL");
    }
    return createPgStore(config.db.databaseUrl);
  }
  return createSqliteStore(config.db.sqlitePath);
}
