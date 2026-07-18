// OIDC login via openid-client v6 (functional API). Users are matched by
// the token's `sub` claim; unknown subjects are auto-provisioned with the
// least-privileged role. An email collision with an existing account is
// treated as a failure, never an automatic merge (exception-first
// correlation is a charter invariant for identities in general).
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as oidc from "openid-client";
import type { AppConfig } from "../config";
import { clientIp, errorBody, type AppEnv } from "./context";
import { issueSession } from "./session";

const STATE_COOKIE = "hatcheck_oidc_state";
const VERIFIER_COOKIE = "hatcheck_oidc_verifier";
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
  }

  async function fail(c: Context<AppEnv>, reason: string): Promise<Response> {
    clearFlowCookies(c);
    try {
      await c.get("store").appendAudit({
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
        const verifier = oidc.randomPKCECodeVerifier();
        const challenge = await oidc.calculatePKCECodeChallenge(verifier);
        setCookie(c, STATE_COOKIE, state, shortLivedCookieOptions());
        setCookie(c, VERIFIER_COOKIE, verifier, shortLivedCookieOptions());
        const url = oidc.buildAuthorizationUrl(oidcConfig, {
          redirect_uri: config.oidc.redirectUri ?? "",
          scope: "openid email profile",
          state,
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
      if (state === undefined || verifier === undefined) {
        return fail(c, "missing_flow_cookies");
      }
      try {
        const oidcConfig = await getOidcConfig();
        const tokens = await oidc.authorizationCodeGrant(
          oidcConfig,
          new URL(c.req.url),
          {
            expectedState: state,
            pkceCodeVerifier: verifier,
            idTokenExpected: true,
          },
        );
        const claims = tokens.claims();
        if (claims === undefined) {
          return fail(c, "missing_id_token");
        }
        const subject = claims.sub;
        const email = typeof claims["email"] === "string" ? claims["email"] : null;
        const name = typeof claims["name"] === "string" ? claims["name"] : null;

        let user = await store.getUserByOidcSubject(subject);
        if (user === null) {
          if (email === null) {
            return fail(c, "missing_email_claim");
          }
          const existing = await store.getUserByEmail(email);
          if (existing !== null) {
            // Same email, different identity source: never auto-merge.
            return fail(c, "email_conflict");
          }
          user = await store.createUser({
            email,
            displayName: name ?? email,
            role: "readonly",
            authSource: "oidc",
            oidcSubject: subject,
          });
          await store.appendAudit({
            action: "user.create",
            actorUserId: null,
            actorEmail: null,
            entityType: "user",
            entityId: user.id,
            details: { source: "oidc_auto_provision" },
            ip: clientIp(c),
          });
        }

        clearFlowCookies(c);

        if (!user.isActive) {
          await store.appendAudit({
            action: "auth.oidc_login_failed",
            actorUserId: user.id,
            actorEmail: user.email,
            details: { reason: "inactive_user" },
            ip: clientIp(c),
          });
          return c.json(errorBody("account_inactive", "Account is inactive"), 403);
        }

        await store.appendAudit({
          action: "auth.oidc_login",
          actorUserId: user.id,
          actorEmail: user.email,
          ip: clientIp(c),
        });
        await issueSession(store, config, c, user);
        return c.redirect("/", 302);
      } catch {
        return fail(c, "code_exchange_failed");
      }
    },
  };
}
