import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";
import { checkServerIdentity } from "node:tls";
import type { AppConfig } from "../config";

/** Use the same verified transport for data, migrations and startup locks. */
export function postgresSslOptions(db: Pick<AppConfig["db"], "databaseUrl" | "sslMode" | "sslRootCert">): { ssl?: ConnectionOptions } {
  if (db.sslMode === "inherit") return {};
  if (db.databaseUrl === null) throw new Error("Verified PostgreSQL TLS requires a database URL");
  let hostname: string;
  try {
    const endpoint = new URL(db.databaseUrl);
    if (!["postgres:", "postgresql:"].includes(endpoint.protocol) || !endpoint.hostname) throw new Error();
    hostname = endpoint.hostname.replace(/^\[|\]$/g, "");
  } catch {
    // URL parser errors can expose their original input, including passwords.
    throw new Error("Verified PostgreSQL TLS requires a PostgreSQL URL with a single endpoint");
  }
  return {
    ssl: {
      rejectUnauthorized: true,
      // Postgres.js supplies a socket without a host to tls.connect. For IP
      // endpoints Node/Bun may otherwise verify 'localhost'; always bind the
      // certificate identity to the configured database endpoint instead.
      checkServerIdentity: (_fallbackHost, certificate) => checkServerIdentity(hostname, certificate),
      ...(db.sslRootCert === null ? {} : { ca: readFileSync(db.sslRootCert, "utf8") }),
    },
  };
}
