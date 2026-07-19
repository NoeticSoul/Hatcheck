// Assets API: thin OpenAPI route definitions and handlers. Domain rules
// (identity-key uniqueness, MAC validation, strict status/custody
// coupling) live in src/modules/assets/service.ts; RBAC is enforced here
// at the API layer and every mutation writes an audit record (CLAUDE.md
// hard rule 5).
import { createRoute } from "@hono/zod-openapi";
import {
  addInterface,
  assetSnapshot,
  createAsset,
  deleteAsset,
  getAssetDetail,
  listAssets,
  removeInterface,
  updateAsset,
} from "../../modules/assets/service";
import { clientIp, createRouter, errorBody } from "../context";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  AddAssetInterfaceBodySchema,
  AssetCreateResponseSchema,
  AssetDetailResponseSchema,
  AssetIdParamsSchema,
  AssetInterfaceParamsSchema,
  AssetInterfaceResponseSchema,
  AssetListResponseSchema,
  AssetResponseSchema,
  cookieSecurity,
  CreateAssetBodySchema,
  ErrorSchema,
  jsonContent,
  ListAssetsQuerySchema,
  PatchAssetBodySchema,
} from "../openapi";

const writeRoles = requireRole("technician", "admin");
const adminOnly = requireRole("admin");

const listAssetsRoute = createRoute({
  method: "get",
  path: "/api/v1/assets",
  tags: ["assets"],
  summary: "List assets with current custody",
  security: cookieSecurity,
  middleware: [requireAuth],
  request: { query: ListAssetsQuerySchema },
  responses: {
    200: jsonContent(AssetListResponseSchema, "Filtered page of assets"),
    400: jsonContent(ErrorSchema, "Validation error"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
  },
});

const getAssetRoute = createRoute({
  method: "get",
  path: "/api/v1/assets/{id}",
  tags: ["assets"],
  summary: "Get an asset with interfaces, custody, and location",
  security: cookieSecurity,
  middleware: [requireAuth],
  request: { params: AssetIdParamsSchema },
  responses: {
    200: jsonContent(AssetDetailResponseSchema, "The asset"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    404: jsonContent(ErrorSchema, "Asset not found"),
  },
});

const createAssetRoute = createRoute({
  method: "post",
  path: "/api/v1/assets",
  tags: ["assets"],
  summary: "Create an asset (technician or admin)",
  security: cookieSecurity,
  middleware: [requireAuth, writeRoles],
  request: {
    body: {
      content: { "application/json": { schema: CreateAssetBodySchema } },
      required: true,
    },
  },
  responses: {
    201: jsonContent(AssetCreateResponseSchema, "Asset created"),
    400: jsonContent(
      ErrorSchema,
      "Validation error, invalid status, invalid location, or invalid MAC",
    ),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Technician or admin role required"),
    409: jsonContent(ErrorSchema, "Identity key already in use"),
  },
});

const patchAssetRoute = createRoute({
  method: "patch",
  path: "/api/v1/assets/{id}",
  tags: ["assets"],
  summary: "Update an asset (technician or admin)",
  security: cookieSecurity,
  middleware: [requireAuth, writeRoles],
  request: {
    params: AssetIdParamsSchema,
    body: {
      content: { "application/json": { schema: PatchAssetBodySchema } },
      required: true,
    },
  },
  responses: {
    200: jsonContent(AssetResponseSchema, "Asset updated"),
    400: jsonContent(
      ErrorSchema,
      "Validation error, invalid status, or invalid location",
    ),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Technician or admin role required"),
    404: jsonContent(ErrorSchema, "Asset not found"),
    409: jsonContent(
      ErrorSchema,
      "Identity key already in use, or asset is checked out",
    ),
  },
});

const deleteAssetRoute = createRoute({
  method: "delete",
  path: "/api/v1/assets/{id}",
  tags: ["assets"],
  summary: "Delete an asset (admin)",
  security: cookieSecurity,
  middleware: [requireAuth, adminOnly],
  request: { params: AssetIdParamsSchema },
  responses: {
    204: { description: "Asset deleted (interfaces and custody cascade)" },
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Admin role required"),
    404: jsonContent(ErrorSchema, "Asset not found"),
  },
});

const addInterfaceRoute = createRoute({
  method: "post",
  path: "/api/v1/assets/{id}/interfaces",
  tags: ["assets"],
  summary: "Add a network interface to an asset (technician or admin)",
  security: cookieSecurity,
  middleware: [requireAuth, writeRoles],
  request: {
    params: AssetIdParamsSchema,
    body: {
      content: { "application/json": { schema: AddAssetInterfaceBodySchema } },
      required: true,
    },
  },
  responses: {
    201: jsonContent(AssetInterfaceResponseSchema, "Interface added"),
    400: jsonContent(ErrorSchema, "Validation error or invalid MAC"),
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Technician or admin role required"),
    404: jsonContent(ErrorSchema, "Asset not found"),
  },
});

const deleteInterfaceRoute = createRoute({
  method: "delete",
  path: "/api/v1/assets/{id}/interfaces/{interfaceId}",
  tags: ["assets"],
  summary: "Remove a network interface from an asset (technician or admin)",
  security: cookieSecurity,
  middleware: [requireAuth, writeRoles],
  request: { params: AssetInterfaceParamsSchema },
  responses: {
    204: { description: "Interface removed" },
    401: jsonContent(ErrorSchema, "Not authenticated"),
    403: jsonContent(ErrorSchema, "Technician or admin role required"),
    404: jsonContent(ErrorSchema, "Asset or interface not found"),
  },
});

export function assetRoutes() {
  const router = createRouter();

  router.openapi(listAssetsRoute, async (c) => {
    const query = c.req.valid("query");
    const result = await listAssets(c.get("store"), query);
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

  router.openapi(getAssetRoute, async (c) => {
    const { id } = c.req.valid("param");
    const result = await getAssetDetail(c.get("store"), id);
    if (!result.ok) {
      return c.json(errorBody(result.code, result.message), result.status);
    }
    return c.json(
      {
        asset: result.asset,
        interfaces: result.interfaces,
        currentCustody: result.currentCustody,
        location: result.location,
      },
      200,
    );
  });

  router.openapi(createAssetRoute, async (c) => {
    const body = c.req.valid("json");
    const store = c.get("store");
    const actor = c.get("user");

    const result = await createAsset(store, body);
    if (!result.ok) {
      return c.json(errorBody(result.code, result.message), result.status);
    }
    await store.appendAudit({
      action: "asset.create",
      actorUserId: actor.id,
      actorEmail: actor.email,
      entityType: "asset",
      entityId: result.asset.id,
      details: { before: null, after: assetSnapshot(result.asset) },
      ip: clientIp(c),
    });
    return c.json({ asset: result.asset, interfaces: result.interfaces }, 201);
  });

  router.openapi(patchAssetRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const store = c.get("store");
    const actor = c.get("user");

    const result = await updateAsset(store, id, body);
    if (!result.ok) {
      return c.json(errorBody(result.code, result.message), result.status);
    }
    await store.appendAudit({
      action: "asset.update",
      actorUserId: actor.id,
      actorEmail: actor.email,
      entityType: "asset",
      entityId: result.asset.id,
      details: {
        fields: Object.keys(body),
        before: assetSnapshot(result.before),
        after: assetSnapshot(result.asset),
      },
      ip: clientIp(c),
    });
    return c.json({ asset: result.asset }, 200);
  });

  router.openapi(deleteAssetRoute, async (c) => {
    const { id } = c.req.valid("param");
    const store = c.get("store");
    const actor = c.get("user");

    const result = await deleteAsset(store, id);
    if (!result.ok) {
      return c.json(errorBody(result.code, result.message), result.status);
    }
    // Interfaces and custody events cascade away with the asset, so this
    // final snapshot IS the record of what was destroyed.
    await store.appendAudit({
      action: "asset.delete",
      actorUserId: actor.id,
      actorEmail: actor.email,
      entityType: "asset",
      entityId: id,
      details: {
        before: {
          ...assetSnapshot(result.before),
          interfaces: result.interfaces.map((iface) => ({
            mac: iface.mac,
            label: iface.label,
          })),
          custodyEventCount: result.custodyEventCount,
        },
        after: null,
      },
      ip: clientIp(c),
    });
    return c.body(null, 204);
  });

  router.openapi(addInterfaceRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const store = c.get("store");
    const actor = c.get("user");

    const result = await addInterface(store, id, body);
    if (!result.ok) {
      return c.json(errorBody(result.code, result.message), result.status);
    }
    await store.appendAudit({
      action: "asset.update",
      actorUserId: actor.id,
      actorEmail: actor.email,
      entityType: "asset",
      entityId: id,
      details: {
        fields: ["interfaces"],
        added: { mac: result.iface.mac, label: result.iface.label },
      },
      ip: clientIp(c),
    });
    return c.json({ interface: result.iface }, 201);
  });

  router.openapi(deleteInterfaceRoute, async (c) => {
    const { id, interfaceId } = c.req.valid("param");
    const store = c.get("store");
    const actor = c.get("user");

    const result = await removeInterface(store, id, interfaceId);
    if (!result.ok) {
      return c.json(errorBody(result.code, result.message), result.status);
    }
    await store.appendAudit({
      action: "asset.update",
      actorUserId: actor.id,
      actorEmail: actor.email,
      entityType: "asset",
      entityId: id,
      details: {
        fields: ["interfaces"],
        removed: { mac: result.removed.mac, label: result.removed.label },
      },
      ip: clientIp(c),
    });
    return c.body(null, 204);
  });

  return router;
}
