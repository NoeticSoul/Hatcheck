import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("deployment configuration boundaries", () => {
  it("encodes discrete PostgreSQL credentials without changing the password", () => {
    const password = "synthetic#?/@@%: password";
    const config = loadConfig({
      HATCHECK_DB: "postgres", DATABASE_URL: "", PGHOST: "localhost",
      PGPORT: "6543", PGUSER: "synthetic-user", PGPASSWORD: password,
      PGDATABASE: "synthetic-db",
    });
    const url = new URL(config.db.databaseUrl ?? "");
    expect(decodeURIComponent(url.password)).toBe(password);
    expect(url.hostname).toBe("localhost");
    expect(url.port).toBe("6543");
    expect(url.pathname).toBe("/synthetic-db");
  });

  it("requires explicit connecting proxy addresses and validates CIDRs", () => {
    expect(() => loadConfig({ HATCHECK_TRUST_PROXY: "true" })).toThrow("HATCHECK_TRUSTED_PROXIES");
    expect(() => loadConfig({ HATCHECK_TRUSTED_PROXIES: "*" })).toThrow("literal IP");
    expect(loadConfig({ HATCHECK_TRUST_PROXY: "true", HATCHECK_TRUSTED_PROXIES: "127.0.0.1,::1" }).trustedProxies)
      .toEqual(["127.0.0.1", "::1"]);
    expect(loadConfig({ HATCHECK_TRUST_PROXY: "true", HATCHECK_TRUSTED_PROXIES: "10.42.1.0/24,10.42.2.0/24" }).trustedProxies)
      .toEqual(["10.42.1.0/24", "10.42.2.0/24"]);
    expect(() => loadConfig({ HATCHECK_TRUSTED_PROXIES: "10.42.1.0/33" })).toThrow("CIDR");
  });

  it("requires verified TLS when a PostgreSQL root certificate is configured", () => {
    expect(loadConfig({}).db.sslMode).toBe("inherit");
    expect(() => loadConfig({ HATCHECK_PG_SSL_ROOT_CERT: "/synthetic/root.pem" })).toThrow("verify-full");
    expect(() => loadConfig({ HATCHECK_PG_SSL_MODE: "require" })).toThrow("HATCHECK_PG_SSL_MODE");
    expect(loadConfig({ HATCHECK_PG_SSL_MODE: "verify-full", HATCHECK_PG_SSL_ROOT_CERT: "/synthetic/root.pem" }).db)
      .toMatchObject({ sslMode: "verify-full", sslRootCert: "/synthetic/root.pem" });
  });

  it("requires explicit domain admission for optional OIDC provisioning", () => {
    expect(loadConfig({}).oidc.autoProvision).toBe(false);
    expect(() => loadConfig({ OIDC_AUTO_PROVISION: "true" })).toThrow("OIDC_ALLOWED_EMAIL_DOMAINS");
    expect(() => loadConfig({ OIDC_ALLOWED_EMAIL_DOMAINS: "*.hatcheck.test" })).toThrow("exact email domains");
  });
});
