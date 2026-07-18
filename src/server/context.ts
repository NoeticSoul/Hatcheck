// Shared server context: the Hono environment type, router factory with the
// standard validation error hook, and small helpers used across routes.
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppConfig } from "../config";
import type {
  AuthSource,
  Role,
  SessionRecord,
  Store,
  UserRecord,
} from "../db/store";

export interface AppVariables {
  store: Store;
  config: AppConfig;
  // Set by requireAuth; only read by handlers that run behind it.
  user: UserRecord;
  session: SessionRecord;
}

export type AppEnv = { Variables: AppVariables };

export interface ErrorBody {
  error: { code: string; message: string };
}

export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

/** Sanitized user shape: passwordHash and oidcSubject never leave the API. */
export interface SafeUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  authSource: AuthSource;
  isActive: boolean;
  createdAt: number;
}

export function sanitizeUser(user: UserRecord): SafeUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    authSource: user.authSource,
    isActive: user.isActive,
    createdAt: user.createdAt,
  };
}

/** First x-forwarded-for hop when present, else "local" (direct/test). */
export function clientIp(c: Context<AppEnv>): string {
  const forwarded = c.req.header("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first !== undefined && first !== "" ? first : "local";
}

/** New router with the standard zod validation hook (400, error shape). */
export function createRouter(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const message = result.error.issues
          .map((i) => `${i.path.map(String).join(".")}: ${i.message}`)
          .join("; ");
        return c.json(
          errorBody("validation_error", message || "Invalid request"),
          400,
        );
      }
      return undefined;
    },
  });
}
