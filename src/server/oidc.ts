// OIDC identities are scoped to their issuer and subject. New accounts
// require explicit domain admission and a verified email; email collisions
// never merge identities. Database failures propagate for atomic rollback.
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as oidc from "openid-client";
import type { AppConfig } from "../config";
import type { Store } from "../db/store";
import { z } from "zod";
import { clientIp, errorBody, sanitizeUser, type AppEnv } from "./context";
import { issueSession } from "./session";

const STATE_COOKIE = "hatcheck_oidc_state";
const VERIFIER_COOKIE = "hatcheck_oidc_verifier";
const NONCE_COOKIE = "hatcheck_oidc_nonce";
// Both the /login and /callback routes live under this path.
const COOKIE_PATH = "/api/v1/auth/oidc";
const COOKIE_TTL_SECONDS = 600;
const LOGIN_ERROR_REDIRECT = "/login?error=oidc";

export interface OidcHandlers {
  login: (c: Context<AppEnv>) => Promise<Response>;
  callback: (c: Context<AppEnv>) => Promise<Response>;
}

export function createOidcHandlers(config: AppConfig): OidcHandlers {
  // Discovery result is cached for the process lifetime.
  let discovered: Promise<oidc.Configuration> | null = null;

  function getOidcConfig(): Promise<oidc.Configuration> {
    if (discovered === null) {
      discovered = oidc.discovery(
        new URL(config.oidc.issuer ?? ""),
        config.oidc.clientId ?? "",
        undefined,
        oidc.ClientSecretPost(config.oidc.clientSecret ?? undefined),
        // Allow http issuers outside production (local dev IdP containers).
        config.isProduction
          ? undefined
          : { execute: [oidc.allowInsecureRequests] },
      );
      // Do not cache a failed discovery.
      discovered.catch(() => {
        discovered = null;
      });
    }
    return discovered;
  }

  function shortLivedCookieOptions() {
    return {
      path: COOKIE_PATH,
      httpOnly: true,
      sameSite: "Lax" as const,
      secure: config.isProduction,
      maxAge: COOKIE_TTL_SECONDS,
    };
  }

  function clearFlowCookies(c: Context<AppEnv>): void {
    deleteCookie(c, STATE_COOKIE, { path: COOKIE_PATH });
    deleteCookie(c, VERIFIER_COOKIE, { path: COOKIE_PATH });
    deleteCookie(c, NONCE_COOKIE, { path: COOKIE_PATH });
  }

  async function fail(c: Context<AppEnv>, reason: string, auditStore = c.get("store")): Promise<Response> {
    clearFlowCookies(c);
    try {
      await auditStore.appendAudit({
        action: "auth.oidc_login_failed",
        details: { reason },
        ip: clientIp(c),
      });
    } catch {
      // Best effort: the request is already failing; still redirect.
    }
    return c.redirect(LOGIN_ERROR_REDIRECT, 302);
  }

  return {
    async login(c) {
      if (!config.oidc.enabled) {
        return c.json(errorBody("oidc_not_configured", "OIDC is not configured"), 501);
      }
      try {
        const oidcConfig = await getOidcConfig();
        const state = oidc.randomState();
        const nonce = oidc.randomNonce();
        const verifier = oidc.randomPKCECodeVerifier();
        const challenge = await oidc.calculatePKCECodeChallenge(verifier);
        setCookie(c, STATE_COOKIE, state, shortLivedCookieOptions());
        setCookie(c, VERIFIER_COOKIE, verifier, shortLivedCookieOptions());
        setCookie(c, NONCE_COOKIE, nonce, shortLivedCookieOptions());
        const url = oidc.buildAuthorizationUrl(oidcConfig, {
          redirect_uri: config.oidc.redirectUri ?? "",
          scope: "openid email profile",
          state,
          nonce,
          code_challenge: challenge,
          code_challenge_method: "S256",
        });
        return c.redirect(url.toString(), 302);
      } catch {
        return fail(c, "discovery_failed");
      }
    },

    async callback(c) {
      if (!config.oidc.enabled) {
        return c.json(errorBody("oidc_not_configured", "OIDC is not configured"), 501);
      }
      const store = c.get("store");
      const state = getCookie(c, STATE_COOKIE);
      const verifier = getCookie(c, VERIFIER_COOKIE);
      const nonce = getCookie(c, NONCE_COOKIE);
      if (state === undefined || verifier === undefined || nonce === undefined) {
        return fail(c, "missing_flow_cookies");
      }
      let claims: ReturnType<oidc.TokenEndpointResponseHelpers["claims"]>;
      try {
        const oidcConfig = await getOidcConfig();
        const callbackUrl = new URL(config.oidc.redirectUri ?? "");
        callbackUrl.search = new URL(c.req.url).search;
        const tokens = await oidc.authorizationCodeGrant(
          oidcConfig,
          callbackUrl,
          {
            expectedState: state,
            expectedNonce: nonce,
            pkceCodeVerifier: verifier,
            idTokenExpected: true,
          },
        );
        claims = tokens.claims();
      } catch {
        return fail(c, "code_exchange_failed");
      }
      if (claims === undefined) return fail(c, "missing_id_token");
      const subject = claims.sub;
      const issuer = claims.iss;
      const emailClaim = z.email().safeParse(claims["email"]);
      if (!emailClaim.success || claims["email_verified"] !== true) {
        return fail(c, "verified_email_required");
      }
      const email = emailClaim.data.toLowerCase();
      const name = typeof claims["name"] === "string" ? claims["name"] : null;
      if (issuer !== config.oidc.issuer || !subject) {
        return fail(c, "invalid_identity");
      }
      // No database lock is held while discovering the issuer or exchanging
      // the authorization code. Once validated, provisioning/audit/session
      // writes commit together and failures propagate for rollback.
      try {
        return await store.transaction(async (tx: Store) => {
          let user = await tx.getUserByOidcSubject(subject, issuer);
          if (user === null) {
            if (!config.oidc.autoProvision ||
                !config.oidc.allowedEmailDomains.includes(email.slice(email.lastIndexOf("@") + 1))) {
              return fail(c, "admission_denied", tx);
            }
            const existing = await tx.getUserByEmail(email);
            if (existing !== null) {
              // Includes legacy issuer-less OIDC accounts: never silently bind them.
              return fail(c, "email_conflict", tx);
            }
            user = await tx.createUser({
              email,
              displayName: name ?? email,
              role: "readonly",
              authSource: "oidc",
              oidcSubject: subject,
              oidcIssuer: issuer,
            });
            await tx.appendAudit({
              action: "user.create",
              actorUserId: null,
              actorEmail: null,
              entityType: "user",
              entityId: user.id,
              details: { source: "oidc_admitted", issuer, before: null, after: sanitizeUser(user) },
              ip: clientIp(c),
            });
          }
          clearFlowCookies(c);
          if (!user.isActive) return fail(c, "inactive_user", tx);
          await tx.appendAudit({
            action: "auth.oidc_login",
            actorUserId: user.id,
            actorEmail: user.email,
            ip: clientIp(c),
          });
          await issueSession(tx, config, c, user);
          return c.redirect("/", 302);
        });
      } catch (error) {
        // Header effects follow the same outcome as persistence, including
        // failures after the callback completes but before COMMIT succeeds.
        c.header("Set-Cookie", undefined);
        throw error;
      }
    },
  };
}
