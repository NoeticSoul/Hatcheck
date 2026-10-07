import { createRoute, z } from "@hono/zod-openapi";
import { createRouter, errorBody } from "../context";
import { requireAuth } from "../middleware/auth";
import { cookieSecurity, CustodyEventSchema, ErrorSchema, jsonContent } from "../openapi";

const dashboardRoute = createRoute({
  method: "get",
  path: "/api/v1/dashboard",
  tags: ["system"],
  summary: "Inventory totals, open exceptions, and recent custody",
  security: cookieSecurity,
  middleware: [requireAuth],
  responses: {
    200: jsonContent(z.object({
      assets: z.object({
        total: z.number(), in_stock: z.number(), deployed: z.number(),
        in_repair: z.number(), retired: z.number(),
      }),
      openExceptions: z.number(),
      recentCustody: z.array(CustodyEventSchema.extend({ assetName: z.string() })),
      overdueDocuments: z.number(),
    }), "Operational dashboard"),
    401: jsonContent(ErrorSchema, "Authentication required"),
  },
});

export function dashboardRoutes() {
  const router = createRouter();
  router.openapi(dashboardRoute, async (c) => {
    const user = c.get("user");
    if (!user) return c.json(errorBody("unauthorized", "Authentication required"), 401);
    const result = await c.get("store").transaction(async (store) => {
      const [total, in_stock, deployed, in_repair, retired, openExceptions, events, overdueDocuments] =
        await Promise.all([
          store.countAssets({}), store.countAssets({ status: "in_stock" }),
          store.countAssets({ status: "deployed" }), store.countAssets({ status: "in_repair" }),
          store.countAssets({ status: "retired" }), store.countExceptions("open"),
          store.listRecentCustodyEvents(10),
          store.countDocuments({ publishedOnly: true, staleBefore: new Date().toISOString().slice(0, 10) }),
        ]);
      const recentCustody = await Promise.all(events.map(async (event) => ({
        ...event, assetName: (await store.getAssetById(event.assetId))?.name ?? "Archived asset",
      })));
      return { assets: { total, in_stock, deployed, in_repair, retired }, openExceptions, recentCustody, overdueDocuments };
    });
    return c.json(result, 200);
  });
  return router;
}
