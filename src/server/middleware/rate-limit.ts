// Fixed-window in-memory rate limiter. Per-instance by design for Phase 0:
// Hatcheck runs as a single process (standalone or one server container),
// so no shared/distributed counter store is needed yet. Revisit if the
// deployment model ever grows multiple API replicas.
import type { MiddlewareHandler } from "hono";
import { clientIp, errorBody, type AppEnv } from "../context";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  maxEntries?: number;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const windows = new Map<string, WindowEntry>();
  const maxEntries = options.maxEntries ?? 10_000;
  let nextPruneAt = 0;

  return async (c, next) => {
    const key = clientIp(c);
    const now = Date.now();

    // Full maps must not turn every rejected request into a linear scan.
    if (windows.size >= maxEntries && now >= nextPruneAt) {
      for (const [k, v] of windows) {
        if (now >= v.resetAt) windows.delete(k);
      }
      nextPruneAt = now + Math.min(options.windowMs, 1_000);
    }

    const entry = windows.get(key);
    if (entry === undefined || now >= entry.resetAt) {
      if (entry === undefined && windows.size >= maxEntries) {
        c.header("Retry-After", String(Math.ceil(options.windowMs / 1000)));
        return c.json(errorBody("rate_limited", "Too many requests"), 429);
      }
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
