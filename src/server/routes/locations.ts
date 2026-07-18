// Locations API: thin OpenAPI route definitions and handlers. Domain rules
// (rank hierarchy, sibling-name uniqueness, delete pre-checks) live in
// src/modules/locations/service.ts; RBAC is enforced here at the API layer
// and every mutation writes an audit record (CLAUDE.md hard rule 5).
import { createRoute } from "@hono/zod-openapi";
import {
  createLocation,
  deleteLocation,
  listLocations,
  locationSnapshot,
  updateLocation,
} from "../../modules/locations/service";
import { clientIp, createRouter, errorBody } from "../context";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  cookieSecurity,
  CreateLocationBodySchema,
  ErrorSchema,
  jsonContent,
  ListLocationsQuerySchema,
  LocationIdParamsSchema,
  LocationListResponseSchema,
  LocationResponseSchema,
  PatchLocationBodySchema,
} from "../openapi";

const writeRoles = requireRole("technician", "admin");
const adminOnly = requireRole("admin");

const listLocationsRoute = createRoute({
  method: "get",
  path: "/api/v1/locations",
  tags: ["locations"],
  summary: "List locations",
  security: cookieSecurity,
  middleware: [requireAuth],
  request: { query: ListLocationsQuerySchema },
  responses: {
    200: jsonContent(LocationListResponseSchema, "Filtered page of locations"),
    400: jsonContent(ErrorSchema, "Validation error"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
  },
});

const getLocationRoute = createRoute({
  method: "get",
  path: "/api/v1/locations/{id}",
  tags: ["locations"],
  summary: "Get a location",
  security: cookieSecurity,
  middleware: [requireAuth],
  request: { params: LocationIdParamsSchema },
  responses: {
    200: jsonContent(LocationResponseSchema, "The location"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    404: jsonContent(ErrorSchema, "Location not found"),
  },
});

const createLocationRoute = createRoute({
  method: "post",
  path: "/api/v1/locations",
  tags: ["locations"],
  summary: "Create a location (technician or admin)",
  security: cookieSecurity,
  middleware: [requireAuth, writeRoles],
  request: {
    body: {
      content: { "application/json": { schema: CreateLocationBodySchema } },
      required: true,
    },
  },
  responses: {
    201: jsonContent(LocationResponseSchema, "Location created"),
    400: jsonContent(ErrorSchema, "Validation error or invalid parent"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Technician or admin role required"),
    409: jsonContent(ErrorSchema, "Sibling name already in use"),
  },
});

const patchLocationRoute = createRoute({
  method: "patch",
  path: "/api/v1/locations/{id}",
  tags: ["locations"],
  summary: "Update a location (technician or admin)",
  security: cookieSecurity,
  middleware: [requireAuth, writeRoles],
  request: {
    params: LocationIdParamsSchema,
    body: {
      content: { "application/json": { schema: PatchLocationBodySchema } },
      required: true,
    },
  },
  responses: {
    200: jsonContent(LocationResponseSchema, "Location updated"),
    400: jsonContent(ErrorSchema, "Validation error or invalid parent"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Technician or admin role required"),
    404: jsonContent(ErrorSchema, "Location not found"),
    409: jsonContent(
      ErrorSchema,
      "Sibling name in use, or kind conflicts with children",
    ),
  },
});

const deleteLocationRoute = createRoute({
  method: "delete",
  path: "/api/v1/locations/{id}",
  tags: ["locations"],
  summary: "Delete a location (admin)",
  security: cookieSecurity,
  middleware: [requireAuth, adminOnly],
  request: { params: LocationIdParamsSchema },
  responses: {
    204: { description: "Location deleted" },
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Admin role required"),
    404: jsonContent(ErrorSchema, "Location not found"),
    409: jsonContent(
      ErrorSchema,
      "Location still referenced by children or assets",
    ),
  },
});

export function locationRoutes() {
  const router = createRouter();

  router.openapi(listLocationsRoute, async (c) => {
    const query = c.req.valid("query");
    const result = await listLocations(c.get("store"), query);
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

  router.openapi(getLocationRoute, async (c) => {
    const { id } = c.req.valid("param");
    const location = await c.get("store").getLocationById(id);
    if (location === null) {
      return c.json(errorBody("not_found", "Location not found"), 404);
    }
    return c.json({ location }, 200);
  });

  router.openapi(createLocationRoute, async (c) => {
    const body = c.req.valid("json");
    const store = c.get("store");
    const actor = c.get("user");

    const result = await createLocation(store, body);
    if (!result.ok) {
      return c.json(errorBody(result.code, result.message), result.status);
    }
    await store.appendAudit({
      action: "location.create",
      actorUserId: actor.id,
      actorEmail: actor.email,
      entityType: "location",
      entityId: result.location.id,
      details: { before: null, after: locationSnapshot(result.location) },
      ip: clientIp(c),
    });
    return c.json({ location: result.location }, 201);
  });

  router.openapi(patchLocationRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const store = c.get("store");
    const actor = c.get("user");

    const result = await updateLocation(store, id, body);
    if (!result.ok) {
      return c.json(errorBody(result.code, result.message), result.status);
    }
    await store.appendAudit({
      action: "location.update",
      actorUserId: actor.id,
      actorEmail: actor.email,
      entityType: "location",
      entityId: result.location.id,
      details: {
        fields: Object.keys(body),
        before: locationSnapshot(result.before),
        after: locationSnapshot(result.location),
      },
      ip: clientIp(c),
    });
    return c.json({ location: result.location }, 200);
  });

  router.openapi(deleteLocationRoute, async (c) => {
    const { id } = c.req.valid("param");
    const store = c.get("store");
    const actor = c.get("user");

    const result = await deleteLocation(store, id);
    if (!result.ok) {
      return c.json(errorBody(result.code, result.message), result.status);
    }
    await store.appendAudit({
      action: "location.delete",
      actorUserId: actor.id,
      actorEmail: actor.email,
      entityType: "location",
      entityId: id,
      details: { before: locationSnapshot(result.before), after: null },
      ip: clientIp(c),
    });
    return c.body(null, 204);
  });

  return router;
}
