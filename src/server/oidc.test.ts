// Local synthetic issuer: no internet, external accounts, or persistent keys.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config";
import type { Store } from "../db/store";
import { createTestStore } from "../test/store";
import { createApp } from "./app";

const CLIENT_ID = "synthetic-client";
const CLIENT_SECRET = "synthetic-client-fixture";
const resources: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(resources.splice(0).map((close) => close()));
});

function inject(store: Store, overrides: (tx: Store) => Partial<Store>): Store {
  return { ...store, ...overrides(store), transaction: (work) => store.transaction((tx) => work(inject(tx, overrides))) };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function mockIssuer(overrides: Record<string, unknown> = {}) {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "synthetic-key", alg: "RS256", use: "sig" };
  let issuer = "";
  let nonce = "";
  let challenge = "";
  let exchanges = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/.well-known/openid-configuration") {
      res.end(JSON.stringify({
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`, response_types_supported: ["code"],
        subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"], code_challenge_methods_supported: ["S256"],
      }));
      return;
    }
    if (req.url === "/jwks") { res.end(JSON.stringify({ keys: [jwk] })); return; }
    if (req.url === "/token" && req.method === "POST") {
      exchanges += 1;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      const verifier = form.get("code_verifier") ?? "";
      if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET ||
          form.get("redirect_uri") !== "http://app.hatcheck.test/api/v1/auth/oidc/callback" ||
          form.get("grant_type") !== "authorization_code" ||
          createHash("sha256").update(verifier).digest("base64url") !== challenge) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: issuer, sub: "synthetic-subject", aud: CLIENT_ID, iat: now, exp: now + 60,
        nonce, email: "reader@hatcheck.test", email_verified: true, name: "Synthetic Reader", ...overrides,
      };
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const unsigned = `${encode({ alg: "RS256", kid: jwk.kid })}.${encode(claims)}`;
      const signature = sign("RSA-SHA256", Buffer.from(unsigned), keys.privateKey).toString("base64url");
      res.end(JSON.stringify({ access_token: "synthetic-token", token_type: "Bearer", expires_in: 60, id_token: `${unsigned}.${signature}` }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing mock issuer port");
  issuer = `http://127.0.0.1:${address.port}`;
  resources.push(() => closeServer(server));
  return {
    issuer,
    get exchanges() { return exchanges; },
    authorization(url: URL) {
      nonce = url.searchParams.get("nonce") ?? "";
      challenge = url.searchParams.get("code_challenge") ?? "";
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(nonce).not.toBe("");
      expect(challenge).not.toBe("");
    },
  };
}

async function fixture(overrides: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {},
  decorate: (store: Store) => Store = (store) => store) {
  const idp = await mockIssuer(overrides);
  const store = await createTestStore();
  resources.push(() => store.close());
  await store.migrate();
  const config = loadConfig({
    NODE_ENV: "test", APP_URL: "http://app.hatcheck.test", OIDC_ISSUER: idp.issuer,
    OIDC_CLIENT_ID: CLIENT_ID, OIDC_CLIENT_SECRET: CLIENT_SECRET, ...env,
  });
  const app = createApp(decorate(store), config);
  async function begin() {
    const response = await app.request("/api/v1/auth/oidc/login");
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    idp.authorization(location);
    const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(";", 1)[0]).join("; ");
    expect(cookies).toContain("hatcheck_oidc_nonce=");
    return { cookies, state: location.searchParams.get("state") ?? "" };
  }
  async function callback(flow: Awaited<ReturnType<typeof begin>>, state = flow.state, cookies = flow.cookies) {
    return app.request(`/api/v1/auth/oidc/callback?code=synthetic-code&state=${encodeURIComponent(state)}`, {
      headers: { cookie: cookies },
    });
  }
  return { app, store, idp, begin, callback };
}

const provision = { OIDC_AUTO_PROVISION: "true", OIDC_ALLOWED_EMAIL_DOMAINS: "hatcheck.test" };

async function failureReason(store: Store) {
  const records = await store.listAudit({ action: "auth.oidc_login_failed", limit: 20 });
  return records[0]?.details ? JSON.parse(records[0].details).reason : null;
}

describe("configured OIDC protocol and admission", () => {
  it("uses nonce/state/PKCE and provisions an audited readonly issuer-bound account", async () => {
    const { app, store, idp, begin, callback } = await fixture({}, provision);
    const flow = await begin();
    const response = await callback(flow);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(idp.exchanges).toBe(1);
    const cookie = response.headers.getSetCookie().find((item) => item.startsWith("hatcheck_session="))?.split(";", 1)[0] ?? "";
    const me = await app.request("/api/v1/auth/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    expect((await me.json()).user.role).toBe("readonly");
    const user = await store.getUserByOidcSubject("synthetic-subject", idp.issuer);
    expect(user?.oidcIssuer).toBe(idp.issuer);
    const created = await store.listAudit({ action: "user.create", limit: 10 });
    const details = JSON.parse(created[0]?.details ?? "{}");
    expect(details.before).toBeNull();
    expect(details.after.id).toBe(user?.id);
    expect(details.after).not.toHaveProperty("passwordHash");
    expect(details.after).not.toHaveProperty("oidcSubject");
  });

  it.each([
    [{}, {}, "admission_denied"],
    [{ email_verified: false }, provision, "verified_email_required"],
    [{ email_verified: "true" }, provision, "verified_email_required"],
    [{ email: "reader@other.test" }, provision, "admission_denied"],
    [{ email: "reader@child.hatcheck.test" }, provision, "admission_denied"],
    [{ email: "invalid" }, provision, "verified_email_required"],
  ])("fails closed for unenrolled/unverified identities %j", async (claims, env, reason) => {
    const { store, begin, callback } = await fixture(claims, env);
    const response = await callback(await begin());
    expect(response.headers.get("location")).toBe("/login?error=oidc");
    expect(response.headers.get("set-cookie") ?? "").not.toContain("hatcheck_session=");
    expect(await store.countUsers()).toBe(0);
    expect(await failureReason(store)).toBe(reason);
  });

  it("allows existing admitted identities with provisioning disabled", async () => {
    const { store, idp, begin, callback } = await fixture();
    await store.createUser({ email: "reader@hatcheck.test", displayName: "Synthetic Reader", role: "technician",
      authSource: "oidc", oidcIssuer: idp.issuer, oidcSubject: "synthetic-subject" });
    const response = await callback(await begin());
    expect(response.headers.get("location")).toBe("/");
    expect(await store.countUsers()).toBe(1);
  });

  it("does not reuse a same-subject administrator from a different issuer", async () => {
    const { store, idp, begin, callback } = await fixture({}, provision);
    await store.createUser({ email: "old.admin@hatcheck.test", displayName: "Synthetic Legacy Admin", role: "admin",
      authSource: "oidc", oidcIssuer: "https://old-issuer.hatcheck.test", oidcSubject: "synthetic-subject" });
    expect((await callback(await begin())).headers.get("location")).toBe("/");
    expect((await store.getUserByOidcSubject("synthetic-subject", idp.issuer))?.role).toBe("readonly");
    expect(await store.countUsers()).toBe(2);
  });

  it.each([null, "https://old-issuer.hatcheck.test"])("never merges an email collision or implicitly binds issuer %s", async (issuer) => {
    const { store, begin, callback } = await fixture({}, provision);
    await store.createUser({ email: "reader@hatcheck.test", displayName: "Synthetic Existing User", role: "admin",
      authSource: "oidc", oidcIssuer: issuer, oidcSubject: "synthetic-subject" });
    const response = await callback(await begin());
    expect(response.headers.get("location")).toBe("/login?error=oidc");
    expect(await failureReason(store)).toBe("email_conflict");
    expect(await store.countUsers()).toBe(1);
  });

  it("rejects a mismatched state before code exchange", async () => {
    const { idp, store, begin, callback } = await fixture({}, provision);
    const response = await callback(await begin(), "tampered-state");
    expect(response.headers.get("location")).toBe("/login?error=oidc");
    expect(idp.exchanges).toBe(0);
    expect(await store.countUsers()).toBe(0);
  });

  it.each([{ nonce: "tampered-nonce" }, { iss: "https://other-issuer.hatcheck.test" }, { aud: "wrong-client" }])(
    "rejects invalid signed-token binding %j", async (claims) => {
      const { store, begin, callback } = await fixture(claims, provision);
      const response = await callback(await begin());
      expect(response.headers.get("location")).toBe("/login?error=oidc");
      expect(await store.countUsers()).toBe(0);
    },
  );

  it("requires the verifier cookie and denies a tampered PKCE verifier", async () => {
    const { store, begin, callback } = await fixture({}, provision);
    const flow = await begin();
    expect((await callback(flow, flow.state, flow.cookies.replace(/hatcheck_oidc_verifier=[^;]+/, ""))).headers.get("location"))
      .toBe("/login?error=oidc");
    expect((await callback(flow, flow.state, flow.cookies.replace(/hatcheck_oidc_verifier=[^;]+/, "hatcheck_oidc_verifier=tampered"))).headers.get("location"))
      .toBe("/login?error=oidc");
    expect(await store.countUsers()).toBe(0);
  });

  it("throttles OIDC callbacks and bounds failed-login audit amplification", async () => {
    const { app, store } = await fixture();
    for (let index = 0; index < 20; index++) {
      expect((await app.request("/api/v1/auth/oidc/callback")).status).toBe(302);
    }
    expect((await app.request("/api/v1/auth/oidc/callback")).status).toBe(429);
    expect(await store.listAudit({ action: "auth.oidc_login_failed", limit: 100 })).toHaveLength(20);
  });

  it.each(["user.create", "auth.oidc_login", "session"])("rolls back provisioning if %s persistence fails", async (failure) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { store, begin, callback } = await fixture({}, provision, (store) => inject(store, (tx) => ({
      appendAudit(entry) {
        if (entry.action === failure) throw new Error("Synthetic audit failure");
        return tx.appendAudit(entry);
      },
      createSession(entry) {
        if (failure === "session") throw new Error("Synthetic session failure");
        return tx.createSession(entry);
      },
    })));
    const response = await callback(await begin());
    expect(response.status).toBe(500);
    expect(response.headers.get("set-cookie") ?? "").not.toContain("hatcheck_session=");
    expect(await store.countUsers()).toBe(0);
    expect(await store.listAudit({ action: "user.create", limit: 10 })).toHaveLength(0);
    expect(await store.listAudit({ action: "auth.oidc_login", limit: 10 })).toHaveLength(0);
  });

  it("discards issued and cleared flow cookies if transaction finalization fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let issuedTokenHash = "";
    const { store, begin, callback } = await fixture({}, provision, (store) => ({
      ...store,
      transaction: (work) => store.transaction(async (tx) => {
        await work({ ...tx, createSession(entry) {
          issuedTokenHash = entry.tokenHash;
          return tx.createSession(entry);
        } });
        throw new Error("Synthetic transaction finalization failure");
      }),
    }));
    const response = await callback(await begin());
    expect(response.status).toBe(500);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(issuedTokenHash).not.toBe("");
    expect(await store.getSessionUser(issuedTokenHash, Date.now())).toBeNull();
    expect(await store.countUsers()).toBe(0);
    expect(await store.listAudit({ action: "auth.oidc_login", limit: 10 })).toHaveLength(0);
  });
});
