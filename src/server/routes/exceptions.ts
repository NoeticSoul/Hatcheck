// Exceptions API: the human-review half of the exception-first invariant.
// Review rules live in src/modules/exceptions/service.ts; RBAC is enforced
// here at the API layer and the resolve mutation writes an audit record
// with before/after state (CLAUDE.md hard rule 5).
import { createRoute } from "@hono/zod-openapi";
import {
  listExceptions,
  resolveException,
} from "../../modules/exceptions/service";
import { clientIp, createRouter, errorBody } from "../context";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  cookieSecurity,
  ErrorSchema,
  ExceptionIdParamsSchema,
  ExceptionListQuerySchema,
  ExceptionListResponseSchema,
  ExceptionResponseSchema,
  jsonContent,
  ResolveExceptionBodySchema,
} from "../openapi";

const writeRoles = requireRole("technician", "admin");

const listExceptionsRoute = createRoute({
  method: "get",
  path: "/api/v1/exceptions",
  tags: ["exceptions"],
  summary: "List exception records, newest first (technician or admin)",
  security: cookieSecurity,
  middleware: [requireAuth, writeRoles],
  request: { query: ExceptionListQuerySchema },
  responses: {
    200: jsonContent(ExceptionListResponseSchema, "Page of exceptions"),
    400: jsonContent(ErrorSchema, "Validation error"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Technician or admin role required"),
  },
});

const getExceptionRoute = createRoute({
  method: "get",
  path: "/api/v1/exceptions/{id}",
  tags: ["exceptions"],
  summary: "Get an exception record (technician or admin)",
  security: cookieSecurity,
  middleware: [requireAuth, writeRoles],
  request: { params: ExceptionIdParamsSchema },
  responses: {
    200: jsonContent(ExceptionResponseSchema, "The exception"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Technician or admin role required"),
    404: jsonContent(ErrorSchema, "Exception not found"),
  },
});

const resolveExceptionRoute = createRoute({
  method: "post",
  path: "/api/v1/exceptions/{id}/resolve",
  tags: ["exceptions"],
  summary: "Resolve or dismiss an open exception (technician or admin)",
  description:
    "Records the human decision on a conflict. Decisions are final: only " +
    "open exceptions can be resolved or dismissed. Resolving changes " +
    "nothing else — any asset edits the reviewer decides on are separate, " +
    "audited mutations through the assets API.",
  security: cookieSecurity,
  middleware: [requireAuth, writeRoles],
  request: {
    params: ExceptionIdParamsSchema,
    body: {
      content: {
        "application/json": { schema: ResolveExceptionBodySchema },
      },
      required: true,
    },
  },
  responses: {
    200: jsonContent(ExceptionResponseSchema, "Exception updated"),
    400: jsonContent(ErrorSchema, "Validation error"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Technician or admin role required"),
    404: jsonContent(ErrorSchema, "Exception not found"),
    409: jsonContent(ErrorSchema, "Exception is not open"),
  },
});

export function exceptionRoutes() {
  const router = createRouter();

  router.openapi(listExceptionsRoute, async (c) => {
    const { limit, offset, status } = c.req.valid("query");
    const result = await listExceptions(c.get("store"), {
      limit,
      offset,
      status,
    });
    return c.json(
      { items: result.items, total: result.total, limit, offset },
      200,
    );
  });

  router.openapi(getExceptionRoute, async (c) => {
    const { id } = c.req.valid("param");
    const exception = await c.get("store").getExceptionById(id);
    if (exception === null) {
      return c.json(errorBody("not_found", "Exception not found"), 404);
    }
    return c.json({ exception }, 200);
  });

  router.openapi(resolveExceptionRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const store = c.get("store");
    const actor = c.get("user");

    const result = await resolveException(store, id, {
      status: body.status,
      note: body.note,
      resolvedByUserId: actor.id,
    });
    if (!result.ok) {
      return c.json(errorBody(result.code, result.message), result.status);
    }
    await store.appendAudit({
      action: "exception.resolve",
      actorUserId: actor.id,
      actorEmail: actor.email,
      entityType: "exception",
      entityId: id,
      details: {
        before: { status: result.before.status },
        after: {
          status: result.exception.status,
          resolutionNote: result.exception.resolutionNote,
        },
      },
      ip: clientIp(c),
    });
    return c.json({ exception: result.exception }, 200);
  });

  return router;
}
