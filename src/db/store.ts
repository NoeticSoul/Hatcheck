// Engine-agnostic data-access contract. Everything above this layer
// (routes, modules, seed) speaks only this interface, which is what keeps
// the dual-DB invariant enforceable: both store.sqlite.ts and store.pg.ts
// must satisfy this exact contract or the build fails.
import type { DbKind } from "../config";

export type Role = "admin" | "technician" | "readonly";
export type AuthSource = "local" | "oidc";

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  authSource: AuthSource;
  passwordHash: string | null;
  oidcSubject: string | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface NewUser {
  email: string;
  displayName: string;
  role: Role;
  authSource: AuthSource;
  passwordHash?: string | null;
  oidcSubject?: string | null;
  isActive?: boolean;
}

export interface UserPatch {
  displayName?: string;
  role?: Role;
  isActive?: boolean;
  passwordHash?: string | null;
}

export interface SessionRecord {
  tokenHash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
}

export interface NewSession {
  tokenHash: string;
  userId: string;
  expiresAt: number;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditEntry {
  id: string;
  at: number;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: string | null;
  ip: string | null;
}

export interface NewAuditEntry {
  actorUserId?: string | null;
  actorEmail?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  /** Serialized to a JSON string; no engine-specific JSON operators. */
  details?: unknown;
  ip?: string | null;
}

export interface AuditQuery {
  limit: number;
  offset?: number;
  action?: string;
}

export interface Store {
  readonly kind: DbKind;
  /** Apply pending migrations for this engine. */
  migrate(): Promise<void>;
  close(): Promise<void>;

  // users
  createUser(user: NewUser): Promise<UserRecord>;
  getUserById(id: string): Promise<UserRecord | null>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  getUserByOidcSubject(subject: string): Promise<UserRecord | null>;
  listUsers(): Promise<UserRecord[]>;
  updateUser(id: string, patch: UserPatch): Promise<UserRecord | null>;
  countUsers(): Promise<number>;

  // sessions
  createSession(session: NewSession): Promise<void>;
  getSessionUser(
    tokenHash: string,
    now: number,
  ): Promise<{ session: SessionRecord; user: UserRecord } | null>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteSessionsForUser(userId: string): Promise<void>;
  deleteExpiredSessions(now: number): Promise<void>;

  // audit — append-only by design: no update or delete methods exist.
  appendAudit(entry: NewAuditEntry): Promise<AuditEntry>;
  listAudit(query: AuditQuery): Promise<AuditEntry[]>;
  countAudit(): Promise<number>;

  // settings
  getSetting(key: string): Promise<unknown>;
  setSetting(key: string, value: unknown): Promise<void>;
}

export function buildAuditRow(entry: NewAuditEntry): AuditEntry {
  return {
    id: crypto.randomUUID(),
    at: Date.now(),
    actorUserId: entry.actorUserId ?? null,
    actorEmail: entry.actorEmail ?? null,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    details:
      entry.details === undefined ? null : JSON.stringify(entry.details),
    ip: entry.ip ?? null,
  };
}

export function buildUserRow(user: NewUser): UserRecord {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    email: user.email.toLowerCase(),
    displayName: user.displayName,
    role: user.role,
    authSource: user.authSource,
    passwordHash: user.passwordHash ?? null,
    oidcSubject: user.oidcSubject ?? null,
    isActive: user.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  };
}
