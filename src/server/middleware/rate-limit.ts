// Fixed-window in-memory rate limiter. Per-instance by design for Phase 0:
// Hatcheck runs as a single process (standalone or one server container),
// so no shared/distributed counter store is needed yet. Revisit if the
// deployment model ever grows multiple API replicas.
import type { MiddlewareHandler } from "hono";
import { clientIp, errorBody, type AppEnv } from "../context";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

const PRUNE_THRESHOLD = 10_000;

export function rateLimit(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const windows = new Map<string, WindowEntry>();

  return async (c, next) => {
    const key = clientIp(c);
    const now = Date.now();

    if (windows.size > PRUNE_THRESHOLD) {
      for (const [k, v] of windows) {
        if (now >= v.resetAt) windows.delete(k);
      }
    }

    const entry = windows.get(key);
    if (entry === undefined || now >= entry.resetAt) {
      windows.set(key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count > options.max) {
      c.header("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return c.json(errorBody("rate_limited", "Too many requests"), 429);
    }
    return next();
  };
}
