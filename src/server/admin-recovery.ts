// Explicit offline recovery for an existing local administrator. This module
// never initializes a database, creates an account, or changes account roles.
import { z } from "zod";
import type { Store, UserRecord } from "../db/store";
import { hashPassword } from "./password";

export interface AdminRecoveryInput {
  email: string;
  password: string;
}

export class AdminRecoveryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AdminRecoveryError";
  }
}

function validate(input: AdminRecoveryInput): AdminRecoveryInput {
  const email = z.email().safeParse(input.email.trim().toLowerCase());
  if (!email.success) {
    throw new AdminRecoveryError("invalid_email", "HATCHECK_RECOVERY_EMAIL must identify an existing local administrator.");
  }
  if (input.password.length < 12 || input.password.length > 1024) {
    throw new AdminRecoveryError("invalid_password", "HATCHECK_RECOVERY_PASSWORD must contain 12 to 1024 characters.");
  }
  return { email: email.data, password: input.password };
}

/** Read names explicitly; never dump environment values or include them in errors. */
export function adminRecoveryFromEnvironment(env: NodeJS.ProcessEnv = process.env): AdminRecoveryInput {
  const email = env.HATCHECK_RECOVERY_EMAIL;
  const password = env.HATCHECK_RECOVERY_PASSWORD;
  if (!email || !password) {
    throw new AdminRecoveryError("missing_environment", "Set HATCHECK_RECOVERY_EMAIL and HATCHECK_RECOVERY_PASSWORD securely before running offline recovery.");
  }
  return validate({ email, password });
}

function auditSnapshot(user: UserRecord) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    authSource: user.authSource,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/** Invoke against an existing database with the application revision matching its schema. */
export async function recoverLocalAdmin(store: Store, input: AdminRecoveryInput): Promise<{ userId: string }> {
  const { email, password } = validate(input);
  return store.transaction(async (tx) => {
    const before = await tx.getUserByEmail(email);
    if (before === null) {
      throw new AdminRecoveryError("not_found", "No existing account matches the recovery email.");
    }
    if (before.authSource !== "local" || before.role !== "admin") {
      throw new AdminRecoveryError("ineligible_account", "Offline recovery requires an existing local administrator account.");
    }
    const after = await tx.updateUser(before.id, {
      passwordHash: await hashPassword(password),
      isActive: true,
    });
    if (after === null) throw new AdminRecoveryError("not_found", "The recovery account no longer exists.");
    await tx.deleteSessionsForUser(before.id);
    await tx.appendAudit({
      action: "user.offline_recovery",
      actorEmail: "system:offline-recovery",
      entityType: "user",
      entityId: before.id,
      details: {
        fields: ["password", "isActive"],
        before: auditSnapshot(before),
        after: auditSnapshot(after),
        sessionsRevoked: true,
      },
    });
    return { userId: before.id };
  });
}
