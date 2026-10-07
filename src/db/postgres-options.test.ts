import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PeerCertificate } from "node:tls";
import { describe, expect, it } from "vitest";
import { postgresSslOptions } from "./postgres-options";

describe("PostgreSQL transport configuration", () => {
  const databaseUrl = "postgres://db.hatcheck.test/hatcheck";
  it("retains existing URI behavior unless verified transport is selected", () => {
    expect(postgresSslOptions({ databaseUrl, sslMode: "inherit", sslRootCert: null })).toEqual({});
    expect(postgresSslOptions({ databaseUrl, sslMode: "verify-full", sslRootCert: null }))
      .toEqual({ ssl: { rejectUnauthorized: true, checkServerIdentity: expect.any(Function) } });
  });

  it("loads the explicit CA without suppressing certificate or hostname verification", () => {
    const directory = mkdtempSync(join(tmpdir(), "hatcheck-ca-test-"));
    try {
      const path = join(directory, "ca.pem");
      const syntheticCa = "synthetic CA fixture; no private key\n";
      writeFileSync(path, syntheticCa);
      expect(postgresSslOptions({ databaseUrl, sslMode: "verify-full", sslRootCert: path }))
        .toEqual({ ssl: { rejectUnauthorized: true, ca: syntheticCa, checkServerIdentity: expect.any(Function) } });
      expect(() => postgresSslOptions({ databaseUrl, sslMode: "verify-full", sslRootCert: join(directory, "missing.pem") }))
        .toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("binds certificate identity to the configured endpoint rather than a driver fallback", () => {
    const certificate = { subjectaltname: "DNS:db.hatcheck.test, IP Address:192.0.2.1" } as PeerCertificate;
    const verify = (url: string) => postgresSslOptions({ databaseUrl: url, sslMode: "verify-full", sslRootCert: null })
      .ssl!.checkServerIdentity!("localhost", certificate);
    expect(verify(databaseUrl)).toBeUndefined();
    expect(verify("postgres://192.0.2.1/hatcheck")).toBeUndefined();
    expect(verify("postgres://localhost/hatcheck")).toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    expect(verify("postgres://127.0.0.1/hatcheck")).toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    expect(verify("postgres://[::1]/hatcheck")).toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });

  it("reports invalid endpoints without disclosing connection credentials", () => {
    const malformed = "postgres://user:synthetic-secret@[invalid/hatcheck";
    expect(() => postgresSslOptions({ databaseUrl: malformed, sslMode: "verify-full", sslRootCert: null }))
      .toThrow("PostgreSQL URL with a single endpoint");
    try { postgresSslOptions({ databaseUrl: malformed, sslMode: "verify-full", sslRootCert: null }); }
    catch (error) { expect(String(error)).not.toContain("synthetic-secret"); }
  });
});
