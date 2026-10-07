import { existsSync } from "node:fs";
import { loadConfig } from "../src/config";
import { createStore } from "../src/db/client";
import { AdminRecoveryError, adminRecoveryFromEnvironment, recoverLocalAdmin } from "../src/server/admin-recovery";

try {
  // Validate the explicit handoff before opening the configured database.
  const input = adminRecoveryFromEnvironment();
  const config = loadConfig();
  if (config.db.kind === "sqlite" && !existsSync(config.db.sqlitePath)) {
    throw new AdminRecoveryError("missing_database", "The configured SQLite database must already exist; offline recovery never initializes one.");
  }
  const store = await createStore(config);
  try {
    // Deliberately no migrate(), bootstrap, seed, or schema initialization.
    await recoverLocalAdmin(store, input);
  } finally {
    await store.close();
  }
  console.log("Local administrator recovered; every session for that account was revoked.");
} catch (error) {
  // Driver errors can contain parameters or connection details. Only our
  // deliberately value-free validation messages are safe operator output.
  console.error(error instanceof AdminRecoveryError ? error.message : "Administrator recovery failed. Check database access and use the application revision matching its schema.");
  process.exitCode = 1;
}
