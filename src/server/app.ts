// createApp assembles the API. Runtime-neutral: no Bun-specific imports
// here (they are confined to index.ts).
import { swaggerUI } from "@hono/swagger-ui";
import { bodyLimit } from "hono/body-limit";
import pkg from "../../package.json";
import type { AppConfig } from "../config";
import type { Store } from "../db/store";
import { createRouter, errorBody } from "./context";
import { aiRoutes } from "./routes/ai";
import { auditRoutes } from "./routes/audit";
import { authRoutes } from "./routes/auth";
import { healthRoutes } from "./routes/health";
import { userRoutes } from "./routes/users";

export function createApp(store: Store, config: AppConfig) {
  const app = createRouter();

  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("config", config);
    await next();
  });

  // The API is JSON-only; nothing legitimate approaches this size.
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (c) =>
        c.json(errorBody("payload_too_large", "Request body too large"), 413),
    }),
  );

  app.onError((err, c) => {
    console.error("Unhandled error:", err);
    return c.json(errorBody("internal_error", "Internal server error"), 500);
  });

  app.notFound((c) => c.json(errorBody("not_found", "Not found"), 404));

  app.route("/", healthRoutes());
  app.route("/", authRoutes(config));
  app.route("/", userRoutes());
  app.route("/", auditRoutes());
  app.route("/", aiRoutes());

  app.openAPIRegistry.registerComponent("securitySchemes", "cookieAuth", {
    type: "apiKey",
    in: "cookie",
    name: "hatcheck_session",
  });

  app.doc31("/api/v1/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Hatcheck API",
      version: pkg.version,
      description: "Self-hosted IT management platform API (Phase 0).",
    },
  });

  app.get("/api/v1/docs", swaggerUI({ url: "/api/v1/openapi.json" }));

  return app;
}
