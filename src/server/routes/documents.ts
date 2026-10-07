import { createRoute, z } from "@hono/zod-openapi";
import { DOCUMENT_SECTIONS } from "../../db/documents.types";
import { exportDocx, exportHtml, exportMarkdown } from "../../modules/documents/export";
import { createDocument, documentCodeSchema, DocumentError, documentInputSchema, isStale, readDocument, reviseDocument, transitionDocument } from "../../modules/documents/service";
import { clientIp, createRouter, errorBody } from "../context";
import { requireAuth, requireRole } from "../middleware/auth";
import { cookieSecurity, ErrorSchema, jsonContent } from "../openapi";

const writer = requireRole("technician", "admin");
const admin = requireRole("admin");
const idParams = z.object({ id: z.string().uuid() });
const revisionQuery = z.object({ revision: z.coerce.number().int().min(1).optional() });
const revisionSchema = z.object({ documentId: z.string(), revision: z.number(), title: z.string(), reviewDate: z.string(), sections: z.object(Object.fromEntries(DOCUMENT_SECTIONS.map((key) => [key, z.string()])) as Record<typeof DOCUMENT_SECTIONS[number], z.ZodString>), changeSummary: z.string(), actorUserId: z.string(), actorEmail: z.string(), createdAt: z.number() }).openapi("DocumentRevision");
const documentSchema = z.object({ id: z.string(), code: z.string(), status: z.enum(["draft", "published", "archived"]), latestRevision: z.number(), publishedRevision: z.number().nullable(), createdAt: z.number(), updatedAt: z.number() }).openapi("Document");
const detailSchema = z.object({ document: documentSchema, revision: revisionSchema, stale: z.boolean() });
const errors = { 400: jsonContent(ErrorSchema, "Invalid request"), 401: jsonContent(ErrorSchema, "Not authenticated"), 403: jsonContent(ErrorSchema, "Role not permitted"), 404: jsonContent(ErrorSchema, "Document or revision unavailable"), 409: jsonContent(ErrorSchema, "Document changed, code exists, or document archived") };
const common = { tags: ["documents"], security: cookieSecurity };
const pagination = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).default(0) });
const listQuery = pagination.extend({ q: z.string().trim().max(200).optional(), status: z.enum(["draft", "published", "archived"]).optional(), stale: z.enum(["true", "false"]).optional(), published: z.enum(["true", "false"]).optional().describe("Search approved snapshots, including when the caller can author drafts") });
const listItemSchema = documentSchema.extend({ title: z.string(), reviewDate: z.string(), visibleRevision: z.number(), stale: z.boolean() });

export function documentRoutes() {
  const router = createRouter();
  router.onError((error, c) => {
    if (error instanceof DocumentError) return c.json(errorBody(error.code, error.message), error.status);
    // Database uniqueness is the backstop for simultaneous SOP code creation.
    const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE") return c.json(errorBody("code_conflict", "Document code already exists"), 409);
    throw error;
  });

  router.openapi(createRoute({ ...common, method: "get", path: "/api/v1/documents", summary: "Search a server-paginated KB; readonly sees published content only", middleware: [requireAuth], request: { query: listQuery }, responses: { 200: jsonContent(z.object({ items: z.array(listItemSchema), total: z.number(), limit: z.number(), offset: z.number() }), "Documents"), ...errors } }), async (c) => {
    const { limit, offset, q, status, stale, published } = c.req.valid("query");
    const query = { limit, offset, q, status, publishedOnly: c.get("user").role === "readonly" || published === "true", staleBefore: stale === "true" ? new Date().toISOString().slice(0, 10) : undefined };
    const store = c.get("store");
    const [items, total] = await Promise.all([store.listDocuments(query), store.countDocuments(query)]);
    return c.json({ items: items.map((item) => ({ ...item, stale: isStale(item.reviewDate) })), total, limit, offset }, 200);
  });

  router.openapi(createRoute({ ...common, method: "post", path: "/api/v1/documents", summary: "Create a structured draft SOP and immutable revision 1", middleware: [requireAuth, writer], request: { body: { content: { "application/json": { schema: documentInputSchema.extend({ code: documentCodeSchema }) } }, required: true } }, responses: { 201: jsonContent(detailSchema, "Created draft"), ...errors } }), async (c) => {
    const { code, ...input } = c.req.valid("json");
    const result = await createDocument(c.get("store"), code, input, c.get("user"), clientIp(c));
    return c.json(result, 201);
  });

  router.openapi(createRoute({ ...common, method: "get", path: "/api/v1/documents/{id}", summary: "Read latest draft or an authorized selected immutable revision", middleware: [requireAuth], request: { params: idParams, query: revisionQuery }, responses: { 200: jsonContent(detailSchema, "Document revision"), ...errors } }), async (c) => {
    return c.json(await readDocument(c.get("store"), c.req.valid("param").id, c.get("user"), c.req.valid("query").revision), 200);
  });

  router.openapi(createRoute({ ...common, method: "post", path: "/api/v1/documents/{id}/revisions", summary: "Append an immutable revision; expectedRevision prevents lost updates", middleware: [requireAuth, writer], request: { params: idParams, body: { content: { "application/json": { schema: documentInputSchema.extend({ expectedRevision: z.number().int().min(1) }) } }, required: true } }, responses: { 201: jsonContent(detailSchema, "New revision"), ...errors } }), async (c) => {
    const { expectedRevision, ...input } = c.req.valid("json");
    return c.json(await reviseDocument(c.get("store"), c.req.valid("param").id, expectedRevision, input, c.get("user"), clientIp(c)), 201);
  });

  router.openapi(createRoute({ ...common, method: "get", path: "/api/v1/documents/{id}/revisions", summary: "Paged immutable author-stamped history; readonly gets the published snapshot only", middleware: [requireAuth], request: { params: idParams, query: pagination }, responses: { 200: jsonContent(z.object({ items: z.array(revisionSchema), total: z.number(), limit: z.number(), offset: z.number() }), "Revision history"), ...errors } }), async (c) => {
    const { id } = c.req.valid("param");
    const { limit, offset } = c.req.valid("query");
    const result = await readDocument(c.get("store"), id, c.get("user"));
    const readonly = c.get("user").role === "readonly";
    const items = readonly ? (offset === 0 ? [result.revision] : []) : await c.get("store").listDocumentRevisions(id, { limit, offset });
    return c.json({ items, total: readonly ? 1 : result.document.latestRevision, limit, offset }, 200);
  });

  for (const action of ["publish", "archive"] as const) {
    router.openapi(createRoute({ ...common, method: "post", path: `/api/v1/documents/{id}/${action}`, summary: action === "publish" ? "Admin approves the latest revision for KB readers" : "Admin archives a document while preserving every revision", middleware: [requireAuth, admin], request: { params: idParams, body: { content: { "application/json": { schema: z.object({ expectedRevision: z.number().int().min(1) }).strict() } }, required: true } }, responses: { 200: jsonContent(z.object({ document: documentSchema }), "Document transition"), ...errors } }), async (c) => {
      return c.json(await transitionDocument(c.get("store"), c.req.valid("param").id, c.req.valid("json").expectedRevision, action === "publish" ? "published" : "archived", c.get("user"), clientIp(c)), 200);
    });
  }

  router.openapi(createRoute({ ...common, method: "get", path: "/api/v1/documents/{id}/export", summary: "Export an authorized selected immutable revision as Markdown, safe HTML, or docx", middleware: [requireAuth], request: { params: idParams, query: z.object({ revision: z.coerce.number().int().min(1), format: z.enum(["md", "html", "docx"]) }) }, responses: { 200: { description: "Exported document", content: { "text/markdown": { schema: z.string() }, "text/html": { schema: z.string() }, "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { schema: z.string().openapi({ format: "binary" }) } } }, ...errors } }), async (c) => {
    const { revision: selectedRevision, format } = c.req.valid("query");
    const { document, revision } = await readDocument(c.get("store"), c.req.valid("param").id, c.get("user"), selectedRevision);
    c.header("Content-Disposition", `attachment; filename="${document.code}-r${revision.revision}.${format}"`);
    c.header("X-Content-Type-Options", "nosniff");
    if (format === "html") {
      c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      c.header("Content-Type", "text/html; charset=utf-8");
      return c.body(exportHtml(document, revision), 200);
    }
    if (format === "md") {
      c.header("Content-Type", "text/markdown; charset=utf-8");
      return c.body(exportMarkdown(document, revision), 200);
    }
    c.header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    return c.body(new Uint8Array(await exportDocx(document, revision)), 200);
  });
  return router;
}
