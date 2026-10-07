import { z } from "zod";
import { isProxyAddress } from "./network/proxy-address";

// All runtime configuration comes from environment variables (see
// SECURITY.md). Nothing in this module reads files or hardcodes secrets.

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_URL: z.string().url().optional(),

  HATCHECK_DB: z.enum(["sqlite", "postgres"]).default("sqlite"),
  DATABASE_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional()),
  PGHOST: z.string().min(1).optional(),
  PGPORT: z.coerce.number().int().min(1).max(65535).default(5432),
  PGUSER: z.string().min(1).optional(),
  PGPASSWORD: z.string().min(1).optional(),
  PGDATABASE: z.string().min(1).optional(),
  HATCHECK_PG_SSL_MODE: z.enum(["inherit", "verify-full"]).default("inherit"),
  HATCHECK_PG_SSL_ROOT_CERT: z.string().min(1).optional(),
  HATCHECK_SQLITE_PATH: z.string().min(1).default("./data/hatcheck.db"),
  HATCHECK_SKIP_MIGRATIONS: z.enum(["true", "false"]).default("false"),
  HATCHECK_SKIP_BOOTSTRAP: z.enum(["true", "false"]).default("false"),

  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),

  // Off by default: X-Forwarded-For is client-controlled unless a trusted
  // reverse proxy in front of Hatcheck sets it. Only enable behind one.
  HATCHECK_TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  HATCHECK_TRUSTED_PROXIES: z.string().optional(),

  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  OIDC_AUTO_PROVISION: z.enum(["true", "false"]).default("false"),
  OIDC_ALLOWED_EMAIL_DOMAINS: z.string().optional(),

  // AI is optional and off by default (charter principle 4). The adapter
  // stays a stub in Phase 0; only the provider name is recognized here.
  HATCHECK_AI_PROVIDER: z.enum(["anthropic", "openai", "ollama"]).optional(),
});

export type DbKind = "sqlite" | "postgres";

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  isProduction: boolean;
  port: number;
  appUrl: string;
  db: {
    kind: DbKind;
    databaseUrl: string | null;
    sqlitePath: string;
    sslMode: "inherit" | "verify-full";
    sslRootCert: string | null;
  };
  runtime: { migrate: boolean; bootstrap: boolean };
  sessionTtlMs: number;
  trustProxy: boolean;
  trustedProxies: string[];
  oidc: {
    enabled: boolean;
    issuer: string | null;
    clientId: string | null;
    clientSecret: string | null;
    redirectUri: string | null;
    autoProvision: boolean;
    allowedEmailDomains: string[];
  };
  ai: { enabled: boolean; provider: "anthropic" | "openai" | "ollama" | null };
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`Invalid environment configuration: ${issues}`);
  }
  const e = parsed.data;

  let databaseUrl = e.DATABASE_URL ?? null;
  if (databaseUrl === null && e.PGHOST && e.PGUSER && e.PGPASSWORD && e.PGDATABASE) {
    const connection = new URL("postgres://localhost");
    connection.hostname = e.PGHOST;
    connection.port = String(e.PGPORT);
    connection.username = encodeURIComponent(e.PGUSER);
    connection.password = encodeURIComponent(e.PGPASSWORD);
    connection.pathname = `/${encodeURIComponent(e.PGDATABASE)}`;
    databaseUrl = connection.toString();
  }
  if (e.HATCHECK_DB === "postgres" && databaseUrl === null) {
    throw new ConfigError(
      "HATCHECK_DB=postgres requires DATABASE_URL or PGHOST, PGUSER, PGPASSWORD, and PGDATABASE",
    );
  }

  if (e.HATCHECK_PG_SSL_ROOT_CERT !== undefined && e.HATCHECK_PG_SSL_MODE !== "verify-full") {
    throw new ConfigError("HATCHECK_PG_SSL_ROOT_CERT requires HATCHECK_PG_SSL_MODE=verify-full");
  }

  const appUrl = e.APP_URL ?? `http://localhost:${e.PORT}`;
  const trustedProxies = (e.HATCHECK_TRUSTED_PROXIES ?? "")
    .split(",").map((ip) => ip.trim()).filter(Boolean);
  if (trustedProxies.some((entry) => !isProxyAddress(entry))) {
    throw new ConfigError("HATCHECK_TRUSTED_PROXIES must contain literal IP addresses or CIDR ranges");
  }
  if (e.HATCHECK_TRUST_PROXY === "true" && trustedProxies.length === 0) {
    throw new ConfigError("HATCHECK_TRUST_PROXY=true requires HATCHECK_TRUSTED_PROXIES");
  }
  const allowedEmailDomains = (e.OIDC_ALLOWED_EMAIL_DOMAINS ?? "")
    .split(",").map((domain) => domain.trim().toLowerCase()).filter(Boolean);
  if (allowedEmailDomains.some((domain) => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain))) {
    throw new ConfigError("OIDC_ALLOWED_EMAIL_DOMAINS must contain exact email domains");
  }
  if (e.OIDC_AUTO_PROVISION === "true" && allowedEmailDomains.length === 0) {
    throw new ConfigError("OIDC_AUTO_PROVISION=true requires OIDC_ALLOWED_EMAIL_DOMAINS");
  }

  const oidcVars = [e.OIDC_ISSUER, e.OIDC_CLIENT_ID, e.OIDC_CLIENT_SECRET];
  const oidcConfigured = oidcVars.every((v) => v !== undefined);
  if (!oidcConfigured && oidcVars.some((v) => v !== undefined)) {
    throw new ConfigError(
      "Partial OIDC configuration: OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET must all be set together",
    );
  }

  return {
    nodeEnv: e.NODE_ENV,
    isProduction: e.NODE_ENV === "production",
    port: e.PORT,
    appUrl,
    db: {
      kind: e.HATCHECK_DB,
      databaseUrl,
      sqlitePath: e.HATCHECK_SQLITE_PATH,
      sslMode: e.HATCHECK_PG_SSL_MODE,
      sslRootCert: e.HATCHECK_PG_SSL_ROOT_CERT ?? null,
    },
    runtime: {
      migrate: e.HATCHECK_SKIP_MIGRATIONS !== "true",
      bootstrap: e.HATCHECK_SKIP_BOOTSTRAP !== "true",
    },
    sessionTtlMs: e.SESSION_TTL_HOURS * 60 * 60 * 1000,
    trustProxy: e.HATCHECK_TRUST_PROXY === "true",
    trustedProxies,
    oidc: {
      enabled: oidcConfigured,
      issuer: e.OIDC_ISSUER ?? null,
      clientId: e.OIDC_CLIENT_ID ?? null,
      clientSecret: e.OIDC_CLIENT_SECRET ?? null,
      redirectUri: oidcConfigured
        ? (e.OIDC_REDIRECT_URI ?? `${appUrl}/api/v1/auth/oidc/callback`)
        : null,
      autoProvision: e.OIDC_AUTO_PROVISION === "true",
      allowedEmailDomains,
    },
    ai: {
      enabled: e.HATCHECK_AI_PROVIDER !== undefined,
      provider: e.HATCHECK_AI_PROVIDER ?? null,
    },
  };
}
