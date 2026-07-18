import { createRoute } from "@hono/zod-openapi";
import pkg from "../../../package.json";
import { createRouter } from "../context";
import { HealthResponseSchema, jsonContent } from "../openapi";

const healthRoute = createRoute({
  method: "get",
  path: "/api/v1/health",
  tags: ["system"],
  summary: "Service health and mode",
  responses: {
    200: jsonContent(HealthResponseSchema, "Service is up"),
  },
});

export function healthRoutes() {
  const router = createRouter();

  router.openapi(healthRoute, (c) => {
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
  });

  return router;
}
