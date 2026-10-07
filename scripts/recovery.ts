import { spawn } from "node:child_process";
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { backupSqlite, publishSnapshot, restoreSqlite } from "../src/server/recovery";
import { loadConfig } from "../src/config";

function dockerProcess(args: string[]) {
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "inherit"] });
  const complete = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Database utility exited with status ${String(code)}`)));
  });
  // pipeline can reject first; attach a handler immediately to avoid an
  // unhandled rejection while its finally block cleans up the process.
  void complete.catch(() => undefined);
  return { child, complete };
}

async function postgresBackup(destination: string) {
  if (existsSync(destination)) throw new Error("Backup destination already exists");
  mkdirSync(dirname(destination), { recursive: true });
  const directory = mkdtempSync(join(dirname(destination), ".hatcheck-pg-backup-"));
  chmodSync(directory, 0o700);
  const snapshot = join(directory, "snapshot.dump");
  const { child, complete } = dockerProcess([
    "compose", "exec", "-T", "db", "pg_dump", "-U", "postgres", "-d", process.env.HATCHECK_PG_DATABASE ?? "hatcheck", "--format=custom", "--no-owner", "--no-acl",
  ]);
  child.stdin.end();
  try {
    await pipeline(child.stdout, createWriteStream(snapshot, { flags: "wx", mode: 0o600 }));
    await complete;
    publishSnapshot(snapshot, destination);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    rmSync(directory, { recursive: true, force: true });
  }
}

async function postgresRestore(backup: string, database: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(database) || ["postgres", "template0", "template1", "hatcheck", process.env.HATCHECK_PG_DATABASE].includes(database)) {
    throw new Error("Restore requires a new database name (lowercase letters, digits, underscores); the live database is refused");
  }
  if (!existsSync(backup)) throw new Error("Backup file does not exist");
  // createdb refuses an existing name. Never use --clean or drop a database.
  const create = dockerProcess(["compose", "exec", "-T", "db", "createdb", "-U", "postgres", "--owner=hatcheck_owner", database]);
  create.child.stdin.end();
  create.child.stdout.resume();
  await create.complete;
  const restore = dockerProcess([
    "compose", "exec", "-T", "db", "pg_restore", "-U", "postgres", "--role=hatcheck_owner", "--dbname", database,
    "--no-owner", "--no-acl", "--exit-on-error", "--single-transaction",
  ]);
  restore.child.stdout.resume();
  try {
    await pipeline(createReadStream(backup), restore.child.stdin);
    await restore.complete;
  } finally {
    if (restore.child.exitCode === null) restore.child.kill("SIGTERM");
  }
  const migrate = dockerProcess([
    "compose", "run", "--rm", "--no-deps", "-e", `PGDATABASE=${database}`, "-e", "HATCHECK_SKIP_BOOTSTRAP=true", "migrate",
  ]);
  migrate.child.stdin.end();
  migrate.child.stdout.resume();
  await migrate.complete;
}

try {
  const [engine, operation, path, target] = process.argv.slice(2);
  if ((engine !== "sqlite" && engine !== "postgres") || (operation !== "backup" && operation !== "restore") || path === undefined) {
    throw new Error("Usage: bun scripts/recovery.ts sqlite backup|restore FILE [DATABASE_PATH] | postgres backup FILE | postgres restore FILE NEW_DATABASE");
  }
  if (engine === "sqlite") {
    const database = target ?? loadConfig().db.sqlitePath;
    if (operation === "backup") await backupSqlite(database, path);
    else await restoreSqlite(path, database);
  } else if (operation === "backup") {
    await postgresBackup(resolve(path));
  } else {
    if (target === undefined) throw new Error("PostgreSQL restore requires a new database name");
    await postgresRestore(resolve(path), target);
  }
  console.log(`${engine} ${operation} complete.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Recovery failed");
  process.exitCode = 1;
}
