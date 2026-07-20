// First-run bootstrap: an empty database gets one admin account so the
// instance is usable at all — essential for the standalone binary, where
// there is no separate seed step. Idempotent: any existing user disables
// it forever. The generated password is printed exactly once (operator
// handoff); only the argon2 hash is stored.
import { randomInt } from "node:crypto";
import type { Store } from "../db/store";
import { hashPassword } from "./password";

// No look-alike characters (0/O, 1/l/I) so printed passwords retype
// cleanly.
const PASSWORD_CHARSET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

export function generatePassword(length = 20): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += PASSWORD_CHARSET[randomInt(PASSWORD_CHARSET.length)];
  }
  return out;
}

export interface BootstrapOptions {
  adminEmail?: string;
  adminPassword?: string;
  log?: (line: string) => void;
}

export interface BootstrapResult {
  created: boolean;
  email?: string;
}

export async function ensureInitialAdmin(
  store: Store,
  opts: BootstrapOptions = {},
): Promise<BootstrapResult> {
  if ((await store.countUsers()) > 0) {
    return { created: false };
  }
  const log = opts.log ?? ((line: string) => console.log(line));
  const email = (
    opts.adminEmail ??
    process.env.HATCHECK_INIT_ADMIN_EMAIL ??
    "admin@hatcheck.test"
  ).toLowerCase();
  const password =
    opts.adminPassword ??
    process.env.HATCHECK_SEED_ADMIN_PASSWORD ??
    generatePassword();

  const user = await store.createUser({
    email,
    displayName: "Instance Admin",
    role: "admin",
    authSource: "local",
    passwordHash: await hashPassword(password),
  });
  await store.appendAudit({
    action: "user.create",
    actorEmail: "system:bootstrap",
    entityType: "user",
    entityId: user.id,
    details: {
      before: null,
      after: { email: user.email, displayName: user.displayName, role: user.role },
      bootstrap: true,
    },
  });
  // The one and only place the plaintext exists: operator handoff.
  log(`bootstrap: created initial admin ${email} password: ${password}`);
  log("bootstrap: change this password after first login.");
  return { created: true, email };
}
