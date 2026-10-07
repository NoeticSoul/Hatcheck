import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createSqliteStore } from "../db/store.sqlite";

interface SnapshotDatabase {
  prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): unknown };
  close(): void;
}

async function openSnapshot(path: string): Promise<SnapshotDatabase> {
  if (process.versions.bun !== undefined) {
    // Same runtime driver choice as the Store. Bun supports prepare/get/run;
    // its ambient declaration intentionally only covers the normal Store.
    const { Database } = await import("bun:sqlite");
    return new Database(path, { readonly: true }) as unknown as SnapshotDatabase;
  }
  const driver = "better-sqlite3";
  const { default: Database } = await import(driver) as {
    default: new (path: string, options: { readonly: true; fileMustExist: true }) => SnapshotDatabase;
  };
  return new Database(path, { readonly: true, fileMustExist: true });
}

async function checkSnapshot(path: string): Promise<void> {
  const db = await openSnapshot(path);
  try {
    const result = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
    if (result.integrity_check !== "ok") throw new Error("SQLite backup integrity check failed");
    const schema = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
    if (schema === undefined || schema === null) throw new Error("Backup is not a Hatcheck database");
  } finally {
    db.close();
  }
}

/** Publish completely written files without replacing an existing destination. */
export function publishSnapshot(tempPath: string, destination: string): void {
  chmodSync(tempPath, 0o600);
  const descriptor = openSync(tempPath, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  linkSync(tempPath, destination);
}

export async function backupSqlite(sourcePath: string, destinationPath: string): Promise<void> {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  if (!existsSync(source)) throw new Error("Source database does not exist");
  if (source === destination || existsSync(destination)) throw new Error("Backup destination already exists");
  mkdirSync(dirname(destination), { recursive: true });
  const temporaryDirectory = mkdtempSync(join(dirname(destination), ".hatcheck-backup-"));
  chmodSync(temporaryDirectory, 0o700);
  const snapshot = join(temporaryDirectory, "snapshot.db");
  try {
    const db = await openSnapshot(source);
    try {
      // VACUUM INTO reads a consistent SQLite snapshot including committed
      // WAL pages. Copying just the live .db file would lose those changes.
      db.prepare("VACUUM INTO ?").run(snapshot);
    } finally {
      db.close();
    }
    await checkSnapshot(snapshot);
    publishSnapshot(snapshot, destination);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function restoreSqlite(backupPath: string, destinationPath: string): Promise<void> {
  const backup = resolve(backupPath);
  const destination = resolve(destinationPath);
  if ([destination, `${destination}-wal`, `${destination}-shm`, `${destination}-journal`].some(existsSync)) {
    throw new Error("Restore destination or its SQLite sidecar files already exist");
  }
  await checkSnapshot(backup);
  mkdirSync(dirname(destination), { recursive: true });
  const temporaryDirectory = mkdtempSync(join(dirname(destination), ".hatcheck-restore-"));
  chmodSync(temporaryDirectory, 0o700);
  const snapshot = join(temporaryDirectory, "snapshot.db");
  try {
    copyFileSync(backup, snapshot);
    const store = await createSqliteStore(snapshot);
    try {
      // A backup from an older supported release is upgraded before it is
      // published. A failed migration never leaves a half-restored target.
      await store.migrate();
    } finally {
      await store.close();
    }
    await checkSnapshot(snapshot);
    publishSnapshot(snapshot, destination);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
