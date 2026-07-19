// Custody API: check-out, check-in, and per-asset history. Domain rules
// (holder resolution, the strict status/custody coupling, location
// snapshots) live in src/modules/custody/service.ts; RBAC is enforced here
// at the API layer and every mutation writes an audit record (CLAUDE.md
// hard rule 5). Failed operations write nothing.
import { createRoute } from "@hono/zod-openapi";
import {
  checkInAsset,
  checkOutAsset,
  getCustodyHistory,
} from "../../modules/custody/service";
import { clientIp, createRouter, errorBody } from "../context";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  AssetIdParamsSchema,
  CheckInBodySchema,
  CheckOutBodySchema,
  cookieSecurity,
  CustodyActionResponseSchema,
  CustodyListQuerySchema,
  CustodyListResponseSchema,
  ErrorSchema,
  jsonContent,
} from "../openapi";

const writeRoles = requireRole("technician", "admin");

const checkOutRoute = createRoute({
  method: "post",
  path: "/api/v1/assets/{id}/checkout",
  tags: ["custody"],
  summary: "Check an asset out to a holder (technician or admin)",
  description:
    "Appends a check_out custody event and sets the asset status to " +
    "deployed atomically. Exactly one of holderUserId or holderLabel is " +
    "required. Check-out is only possible from in_stock.",
  security: cookieSecurity,
  middleware: [requireAuth, writeRoles],
  request: {
    params: AssetIdParamsSchema,
    body: {
      content: { "application/json": { schema: CheckOutBodySchema } },
      required: true,
    },
  },
  responses: {
    201: jsonContent(CustodyActionResponseSchema, "Asset checked out"),
    400: jsonContent(
      ErrorSchema,
      "Validation error, invalid holder, or invalid location",
    ),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Technician or admin role required"),
    404: jsonContent(ErrorSchema, "Asset not found"),
    409: jsonContent(
      ErrorSchema,
      "Already checked out, retired, or unavailable (in repair)",
    ),
  },
});

const checkInRoute = createRoute({
  method: "post",
  path: "/api/v1/assets/{id}/checkin",
  tags: ["custody"],
  summary: "Check an asset back in (technician or admin)",
  description:
    "Appends a check_in custody event and returns the asset status to " +
    "in_stock atomically. An optional locationId moves the asset.",
  security: cookieSecurity,
  middleware: [requireAuth, writeRoles],
  request: {
    params: AssetIdParamsSchema,
    body: {
      content: { "application/json": { schema: CheckInBodySchema } },
      required: true,
    },
  },
  responses: {
    201: jsonContent(CustodyActionResponseSchema, "Asset checked in"),
    400: jsonContent(ErrorSchema, "Validation error or invalid location"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Technician or admin role required"),
    404: jsonContent(ErrorSchema, "Asset not found"),
    409: jsonContent(ErrorSchema, "Asset is not checked out"),
  },
});

const custodyHistoryRoute = createRoute({
  method: "get",
  path: "/api/v1/assets/{id}/custody",
  tags: ["custody"],
  summary: "Custody history for an asset, newest first",
  security: cookieSecurity,
  middleware: [requireAuth],
  request: { params: AssetIdParamsSchema, query: CustodyListQuerySchema },
  responses: {
    200: jsonContent(CustodyListResponseSchema, "Custody events, newest first"),
    400: jsonContent(ErrorSchema, "Validation error"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    404: jsonContent(ErrorSchema, "Asset not found"),
  },
});

export function custodyRoutes() {
  const router = createRouter();

  router.openapi(checkOutRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const store = c.get("store");
    const actor = c.get("user");

    const result = await checkOutAsset(store, id, body, {
      actorUserId: actor.id,
      actorEmail: actor.email,
    });
    if (!result.ok) {
      return c.json(errorBody(result.code, result.message), result.status);
    }
    await store.appendAudit({
      action: "custody.check_out",
      actorUserId: actor.id,
      actorEmail: actor.email,
      entityType: "asset",
      entityId: id,
      details: {
        eventId: result.event.id,
        holder: {
          userId: result.event.holderUserId,
          name: result.event.holderName,
        },
        note: result.event.note,
        before: result.before,
        after: result.after,
      },
      ip: clientIp(c),
    });
    return c.json({ event: result.event, asset: result.asset }, 201);
  });

  router.openapi(checkInRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const store = c.get("store");
    const actor = c.get("user");

    const result = await checkInAsset(store, id, body, {
      actorUserId: actor.id,
      actorEmail: actor.email,
    });
    if (!result.ok) {
      return c.json(errorBody(result.code, result.message), result.status);
    }
    await store.appendAudit({
      action: "custody.check_in",
      actorUserId: actor.id,
      actorEmail: actor.email,
      entityType: "asset",
      entityId: id,
      details: {
        eventId: result.event.id,
        note: result.event.note,
        before: result.before,
        after: result.after,
      },
      ip: clientIp(c),
    });
    return c.json({ event: result.event, asset: result.asset }, 201);
  });

  router.openapi(custodyHistoryRoute, async (c) => {
    const { id } = c.req.valid("param");
    const query = c.req.valid("query");
    const result = await getCustodyHistory(c.get("store"), id, query);
    if (!result.ok) {
      return c.json(errorBody(result.code, result.message), result.status);
    }
    return c.json(
      {
        items: result.items,
        total: result.total,
        limit: query.limit,
        offset: query.offset,
      },
      200,
    );
  });

  return router;
}
