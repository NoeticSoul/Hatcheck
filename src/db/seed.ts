// Synthetic seed data only (CLAUDE.md hard rule 6): invented names and
// *.test reserved-TLD emails. Runnable directly (bun src/db/seed.ts) and
// importable. Idempotent: existing users are left untouched.
//
// Generated passwords are printed to stdout exactly once as the handoff
// mechanism; only argon2 hashes are stored.
import { randomInt } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "@node-rs/argon2";
import { loadConfig } from "../config";
import { createStore } from "./client";
import type { Role, Store } from "./store";

interface SeedUser {
  email: string;
  displayName: string;
  role: Role;
}

const SEED_USERS: SeedUser[] = [
  { email: "admin@hatcheck.test", displayName: "Instance Admin", role: "admin" },
  {
    email: "taylor.tech@hatcheck.test",
    displayName: "Taylor Technician",
    role: "technician",
  },
  {
    email: "rowan.report@hatcheck.test",
    displayName: "Rowan Reporter",
    role: "readonly",
  },
];

// No look-alike characters (0/O, 1/l/I) so printed passwords retype cleanly.
const PASSWORD_CHARSET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

export function generatePassword(length = 20): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += PASSWORD_CHARSET[randomInt(PASSWORD_CHARSET.length)];
  }
  return out;
}

export interface SeedOptions {
  adminPassword?: string;
  log?: (line: string) => void;
}

export async function seed(store: Store, opts: SeedOptions = {}): Promise<void> {
  const log = opts.log ?? ((line: string) => console.log(line));

  await store.migrate();

  const createdEmails: string[] = [];
  for (const u of SEED_USERS) {
    const existing = await store.getUserByEmail(u.email);
    if (existing !== null) {
      log(`seed: ${u.email} already exists, skipping`);
      continue;
    }
    const password =
      u.role === "admin"
        ? (opts.adminPassword ??
          process.env.HATCHECK_SEED_ADMIN_PASSWORD ??
          generatePassword())
        : generatePassword();
    await store.createUser({
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      authSource: "local",
      passwordHash: await hash(password),
    });
    createdEmails.push(u.email);
    // The one and only place the plaintext exists: operator handoff.
    log(`seed: created ${u.email} (${u.role}) password: ${password}`);
  }

  await store.setSetting("instance", { name: "Hatcheck (dev)" });

  await store.appendAudit({
    action: "seed.run",
    entityType: "seed",
    details: { created: createdEmails },
  });

  log(
    `seed: done (${createdEmails.length} user(s) created, ` +
      `${SEED_USERS.length - createdEmails.length} already present)`,
  );
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  // Case-insensitive compare: Windows paths differ in casing between
  // argv[1] and import.meta.url on some runtimes.
  return (
    resolve(entry).toLowerCase() ===
    fileURLToPath(import.meta.url).toLowerCase()
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = await createStore(config);
  try {
    await seed(store);
  } finally {
    await store.close();
  }
}

if (isMainModule()) {
  main().catch((err) => {
    console.error("seed failed:", err);
    process.exitCode = 1;
  });
}
