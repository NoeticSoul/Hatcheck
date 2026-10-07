// createApp assembles the API. Runtime-neutral: no Bun-specific imports
// here (they are confined to index.ts).
import { swaggerUI } from "@hono/swagger-ui";
import { bodyLimit } from "hono/body-limit";
import pkg from "../../package.json";
import type { AppConfig } from "../config";
import type { Store } from "../db/store";
import { createRouter, errorBody } from "./context";
import { csvMediaType, protectBrowserWrites, securityHeaders } from "./middleware/browser-security";
import { atomicMutation } from "./middleware/atomic";
import { aiRoutes } from "./routes/ai";
import { assetRoutes } from "./routes/assets";
import { auditRoutes } from "./routes/audit";
import { authRoutes } from "./routes/auth";
import { custodyRoutes } from "./routes/custody";
import { dashboardRoutes } from "./routes/dashboard";
import { documentRoutes } from "./routes/documents";
import { exceptionRoutes } from "./routes/exceptions";
import { healthRoutes } from "./routes/health";
import { importRoutes } from "./routes/imports";
import { locationRoutes } from "./routes/locations";
import { userRoutes } from "./routes/users";

export function createApp(store: Store, config: AppConfig) {
  const app = createRouter();

  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("config", config);
    await next();
  });

  app.use("*", securityHeaders);
  app.use("/api/*", protectBrowserWrites);
  app.use("/api/v1/imports/assets", csvMediaType);

  // The API is JSON-only — nothing legitimate approaches this size —
  // except CSV import uploads, which get their own larger cap (a 5000-row
  // file with every column filled stays well under 2 MiB).
  const jsonLimit = bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) =>
      c.json(errorBody("payload_too_large", "Request body too large"), 413),
  });
  const csvLimit = bodyLimit({
    maxSize: 2 * 1024 * 1024,
    onError: (c) =>
      c.json(errorBody("payload_too_large", "CSV body too large"), 413),
  });
  app.use("/api/*", (c, next) =>
    c.req.path.startsWith("/api/v1/imports/")
      ? csvLimit(c, next)
      : jsonLimit(c, next),
  );
  app.use("/api/*", atomicMutation);

  app.onError((err, c) => {
    // Database/provider errors may embed connection strings or token payloads.
    console.error("Unhandled request error:", err instanceof Error ? err.name : "unknown");
    return c.json(errorBody("internal_error", "Internal server error"), 500);
  });

  app.notFound((c) => c.json(errorBody("not_found", "Not found"), 404));

  app.route("/", healthRoutes());
  app.route("/", authRoutes(config));
  app.route("/", userRoutes());
  app.route("/", locationRoutes());
  app.route("/", assetRoutes());
  app.route("/", custodyRoutes());
  app.route("/", dashboardRoutes());
  app.route("/", documentRoutes());
  app.route("/", importRoutes());
  app.route("/", exceptionRoutes());
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
      description: "Self-hosted inventory, custody, administration, and structured knowledge-base API.",
    },
  });

  app.get("/api/v1/docs", swaggerUI({ url: "/api/v1/openapi.json" }));

  return app;
}
