import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import type { Context } from "hono";
import pkg from "../../../package.json";
import { createRouter, errorBody, type AppEnv } from "../context";
import { ErrorSchema, HealthResponseSchema, jsonContent } from "../openapi";

const healthRoute = createRoute({
  method: "get",
  path: "/api/v1/health",
  tags: ["system"],
  summary: "Database-backed readiness and mode",
  responses: {
    200: jsonContent(HealthResponseSchema, "Service is up"),
    503: jsonContent(ErrorSchema, "Database is unavailable"),
  },
});

export function healthRoutes() {
  const router = createRouter();

  const readiness = async (c: Context<AppEnv>) => {
    try {
      await c.get("store").readiness();
    } catch {
      return c.json(errorBody("not_ready", "Database is unavailable"), 503);
    }
    const config = c.get("config");
    return c.json(
      {
        status: "ok" as const,
        version: pkg.version,
        db: c.get("store").kind,
        oidcEnabled: config.oidc.enabled,
        aiEnabled: config.ai.enabled,
      },
      200,
    );
  };
  router.openapi(healthRoute, readiness);
  router.openapi(createRoute({ ...healthRoute, path: "/api/v1/ready" }), readiness);
  router.openapi(createRoute({
    method: "get",
    path: "/api/v1/live",
    tags: ["system"],
    summary: "Process liveness (does not query the database)",
    responses: { 200: jsonContent(z.object({ status: z.literal("ok") }), "Process is serving requests") },
  }), (c) => c.json({ status: "ok" as const }, 200));

  return router;
}
