// CSV import API: thin OpenAPI route definitions and handlers. All import
// rules (header mapping, per-row validation, exception-first identity
// matching, idempotency) live in src/modules/imports/service.ts; RBAC is
// enforced here at the API layer. Audit: the service writes one entry per
// created asset and exception AS each mutation lands (so an aborted run
// leaves nothing unaudited); this route adds the one run-summary entry.
import { createRoute, z } from "@hono/zod-openapi";
import { runAssetImport } from "../../modules/imports/service";
import { clientIp, createRouter, errorBody } from "../context";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  cookieSecurity,
  ErrorSchema,
  ImportIdParamsSchema,
  ImportJobResponseSchema,
  ImportListQuerySchema,
  ImportListResponseSchema,
  ImportRowListQuerySchema,
  ImportRowListResponseSchema,
  ImportRunResponseSchema,
  jsonContent,
  RunImportQuerySchema,
} from "../openapi";

const writeRoles = requireRole("technician", "admin");

const runImportRoute = createRoute({
  method: "post",
  path: "/api/v1/imports/assets",
  tags: ["imports"],
  summary: "Import assets from CSV (technician or admin)",
  description:
    "Body is raw CSV with a header row. Columns: name (required), " +
    "asset_type, status, location or location_id, model, manufacturer, " +
    "notes, asset_tag, serial_number, system_uuid, mac_addresses " +
    "(separated by spaces or semicolons). Every row needs at least one " +
    "identity field so re-imports stay idempotent. mode=dry_run previews " +
    "with the identical per-row report but creates no assets or " +
    "exceptions; identity collisions with existing assets become open " +
    "exception records (commit mode) and are never force-merged. Failed " +
    "rows are reported per row and do not abort the run.",
  security: cookieSecurity,
  middleware: [requireAuth, writeRoles],
  request: {
    query: RunImportQuerySchema,
    body: {
      // Documented for the spec; text bodies are read directly by the
      // handler (zod-openapi only auto-validates JSON and form bodies).
      content: { "text/csv": { schema: z.string() } },
      required: true,
      description: "CSV file content",
    },
  },
  responses: {
    200: jsonContent(
      ImportRunResponseSchema,
      "Import processed; full per-row result report",
    ),
    400: jsonContent(
      ErrorSchema,
      "Malformed CSV, unknown or missing columns, or too many rows",
    ),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Technician or admin role required"),
    413: jsonContent(ErrorSchema, "CSV body too large"),
  },
});

const listImportsRoute = createRoute({
  method: "get",
  path: "/api/v1/imports",
  tags: ["imports"],
  summary: "List import jobs, newest first (technician or admin)",
  security: cookieSecurity,
  middleware: [requireAuth, writeRoles],
  request: { query: ImportListQuerySchema },
  responses: {
    200: jsonContent(ImportListResponseSchema, "Page of import jobs"),
    400: jsonContent(ErrorSchema, "Validation error"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Technician or admin role required"),
  },
});

const getImportRoute = createRoute({
  method: "get",
  path: "/api/v1/imports/{id}",
  tags: ["imports"],
  summary: "Get an import job (technician or admin)",
  security: cookieSecurity,
  middleware: [requireAuth, writeRoles],
  request: { params: ImportIdParamsSchema },
  responses: {
    200: jsonContent(ImportJobResponseSchema, "The import job"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Technician or admin role required"),
    404: jsonContent(ErrorSchema, "Import job not found"),
  },
});

const listImportRowsRoute = createRoute({
  method: "get",
  path: "/api/v1/imports/{id}/rows",
  tags: ["imports"],
  summary: "List an import job's per-row results (technician or admin)",
  security: cookieSecurity,
  middleware: [requireAuth, writeRoles],
  request: { params: ImportIdParamsSchema, query: ImportRowListQuerySchema },
  responses: {
    200: jsonContent(
      ImportRowListResponseSchema,
      "Page of rows in file order",
    ),
    400: jsonContent(ErrorSchema, "Validation error"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Technician or admin role required"),
    404: jsonContent(ErrorSchema, "Import job not found"),
  },
});

export function importRoutes() {
  const router = createRouter();

  router.openapi(runImportRoute, async (c) => {
    const { mode, filename } = c.req.valid("query");
    const store = c.get("store");
    const actor = c.get("user");
    const csvText = await c.req.text();

    const result = await runAssetImport(store, {
      csvText,
      mode,
      filename: filename ?? null,
      actor: { actorUserId: actor.id, actorEmail: actor.email },
      ip: clientIp(c),
    });
    if (!result.ok) {
      return c.json(errorBody(result.code, result.message), result.status);
    }

    await store.appendAudit({
      action: mode === "commit" ? "import.commit" : "import.dry_run",
      actorUserId: actor.id,
      actorEmail: actor.email,
      entityType: "import",
      entityId: result.job.id,
      details: {
        filename: result.job.filename,
        fileHash: result.job.fileHash,
        totalRows: result.job.totalRows,
        createdCount: result.job.createdCount,
        skippedCount: result.job.skippedCount,
        collisionCount: result.job.collisionCount,
        errorCount: result.job.errorCount,
        priorImportJobId: result.priorImport?.id ?? null,
      },
      ip: clientIp(c),
    });

    return c.json(
      { job: result.job, rows: result.rows, priorImport: result.priorImport },
      200,
    );
  });

  router.openapi(listImportsRoute, async (c) => {
    const { limit, offset } = c.req.valid("query");
    const store = c.get("store");
    const items = await store.listImportJobs({ limit, offset });
    const total = await store.countImportJobs();
    return c.json({ items, total, limit, offset }, 200);
  });

  router.openapi(getImportRoute, async (c) => {
    const { id } = c.req.valid("param");
    const job = await c.get("store").getImportJobById(id);
    if (job === null) {
      return c.json(errorBody("not_found", "Import job not found"), 404);
    }
    return c.json({ job }, 200);
  });

  router.openapi(listImportRowsRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { limit, offset } = c.req.valid("query");
    const store = c.get("store");
    const job = await store.getImportJobById(id);
    if (job === null) {
      return c.json(errorBody("not_found", "Import job not found"), 404);
    }
    const items = await store.listImportRows(id, { limit, offset });
    const total = await store.countImportRows(id);
    return c.json({ items, total, limit, offset }, 200);
  });

  return router;
}
