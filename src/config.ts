import { z } from "zod";

// All runtime configuration comes from environment variables (see
// SECURITY.md). Nothing in this module reads files or hardcodes secrets.

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_URL: z.string().url().optional(),

  HATCHECK_DB: z.enum(["sqlite", "postgres"]).default("sqlite"),
  DATABASE_URL: z.string().min(1).optional(),
  HATCHECK_SQLITE_PATH: z.string().min(1).default("./data/hatcheck.db"),

  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),

  // Off by default: X-Forwarded-For is client-controlled unless a trusted
  // reverse proxy in front of Hatcheck sets it. Only enable behind one.
  HATCHECK_TRUST_PROXY: z.enum(["true", "false"]).default("false"),

  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),

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
  db: { kind: DbKind; databaseUrl: string | null; sqlitePath: string };
  sessionTtlMs: number;
  trustProxy: boolean;
  oidc: {
    enabled: boolean;
    issuer: string | null;
    clientId: string | null;
    clientSecret: string | null;
    redirectUri: string | null;
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

  if (e.HATCHECK_DB === "postgres" && !e.DATABASE_URL) {
    throw new ConfigError(
      "HATCHECK_DB=postgres requires DATABASE_URL to be set",
    );
  }

  const appUrl = e.APP_URL ?? `http://localhost:${e.PORT}`;

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
      databaseUrl: e.DATABASE_URL ?? null,
      sqlitePath: e.HATCHECK_SQLITE_PATH,
    },
    sessionTtlMs: e.SESSION_TTL_HOURS * 60 * 60 * 1000,
    trustProxy: e.HATCHECK_TRUST_PROXY === "true",
    oidc: {
      enabled: oidcConfigured,
      issuer: e.OIDC_ISSUER ?? null,
      clientId: e.OIDC_CLIENT_ID ?? null,
      clientSecret: e.OIDC_CLIENT_SECRET ?? null,
      redirectUri: oidcConfigured
        ? (e.OIDC_REDIRECT_URI ?? `${appUrl}/api/v1/auth/oidc/callback`)
        : null,
    },
    ai: {
      enabled: e.HATCHECK_AI_PROVIDER !== undefined,
      provider: e.HATCHECK_AI_PROVIDER ?? null,
    },
  };
}
