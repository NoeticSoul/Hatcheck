import { createRoute } from "@hono/zod-openapi";
import { createRouter } from "../context";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  AuditListResponseSchema,
  AuditQuerySchema,
  cookieSecurity,
  ErrorSchema,
  jsonContent,
} from "../openapi";

const listAuditRoute = createRoute({
  method: "get",
  path: "/api/v1/audit",
  tags: ["audit"],
  summary: "List audit log entries (admin)",
  security: cookieSecurity,
  middleware: [requireAuth, requireRole("admin")],
  request: { query: AuditQuerySchema },
  responses: {
    200: jsonContent(AuditListResponseSchema, "Audit entries, newest first"),
    400: jsonContent(ErrorSchema, "Validation error"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Admin role required"),
  },
});

export function auditRoutes() {
  const router = createRouter();

  router.openapi(listAuditRoute, async (c) => {
    const { limit, offset, action } = c.req.valid("query");
    const store = c.get("store");
    const entries = await store.listAudit({ limit, offset, action });
    // Note: total is the unfiltered count (Store.countAudit takes no query).
    const total = await store.countAudit();
    return c.json({ entries, total }, 200);
  });

  return router;
}
