// AI status only. The AI adapter itself is a Phase 3+ concern; this
// endpoint exists so the UI can degrade cleanly when no provider is
// configured (CLAUDE.md hard rule 7).
import { createRoute } from "@hono/zod-openapi";
import { createRouter } from "../context";
import { requireAuth } from "../middleware/auth";
import {
  AiStatusResponseSchema,
  cookieSecurity,
  ErrorSchema,
  jsonContent,
} from "../openapi";

const aiStatusRoute = createRoute({
  method: "get",
  path: "/api/v1/ai/status",
  tags: ["ai"],
  summary: "AI provider status",
  security: cookieSecurity,
  middleware: [requireAuth],
  responses: {
    200: jsonContent(AiStatusResponseSchema, "AI availability"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
  },
});

export function aiRoutes() {
  const router = createRouter();

  router.openapi(aiStatusRoute, (c) => {
    const config = c.get("config");
    return c.json(
      { enabled: config.ai.enabled, provider: config.ai.provider },
      200,
    );
  });

  return router;
}
