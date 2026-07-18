// Session helpers. The raw token is random and only ever lives in the
// cookie; the database stores its sha256 hex hash, so a DB leak does not
// leak usable session tokens.
import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { AppConfig } from "../config";
import type { Store, UserRecord } from "../db/store";
import { clientIp, type AppEnv } from "./context";

export const SESSION_COOKIE = "hatcheck_session";

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashSessionToken(token) };
}

export async function issueSession(
  store: Store,
  config: AppConfig,
  c: Context<AppEnv>,
  user: UserRecord,
): Promise<void> {
  const { token, tokenHash } = createSessionToken();
  await store.createSession({
    tokenHash,
    userId: user.id,
    expiresAt: Date.now() + config.sessionTtlMs,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
  });
  setCookie(c, SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: config.isProduction,
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  });
}

export async function clearSession(
  store: Store,
  c: Context<AppEnv>,
  tokenHash: string | null,
): Promise<void> {
  if (tokenHash !== null) {
    await store.deleteSession(tokenHash);
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
