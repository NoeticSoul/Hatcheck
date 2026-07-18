// Server entrypoint. Bun is the canonical runtime for Hatcheck (CLAUDE.md
// stack), so Bun-specific APIs (Bun.serve, hono/bun serveStatic) are
// allowed here and ONLY here; createApp itself stays runtime-neutral.
import { serveStatic } from "hono/bun";
import { loadConfig } from "../config";
import { createStore } from "../db/client";
import { createApp } from "./app";

// bun-types is not installed (tsconfig types: node), so declare the minimal
// Bun surface this file uses.
interface BunServer {
  requestIP(request: Request): { address: string } | null;
}

declare const Bun: {
  serve(options: {
    port: number;
    fetch: (
      request: Request,
      server: BunServer,
    ) => Response | Promise<Response>;
  }): { port: number };
};

const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

const config = loadConfig();
const store = await createStore(config);
await store.migrate();

const app = createApp(store, config);

if (config.isProduction) {
  // Serve the built SPA. Static files first, then an index.html fallback
  // for client-side routes; /api/* never falls through to the SPA.
  app.use("*", serveStatic({ root: "./dist/web" }));
  const indexFallback = serveStatic({ path: "./dist/web/index.html" });
  app.get("*", (c, next) => {
    if (c.req.path.startsWith("/api/")) return next();
    return indexFallback(c, next);
  });
}

setInterval(() => {
  store.deleteExpiredSessions(Date.now()).catch((err: unknown) => {
    console.error("Expired-session sweep failed:", err);
  });
}, SESSION_SWEEP_INTERVAL_MS);

Bun.serve({
  port: config.port,
  // The socket address rides in on the Hono env so clientIp() has a value
  // the client cannot forge (X-Forwarded-For is only trusted behind a
  // proxy; see clientIp in context.ts).
  fetch: (request, server) =>
    app.fetch(request, { remoteAddr: server.requestIP(request)?.address }),
});

console.log(
  `Hatcheck API (${config.db.kind}) listening on http://localhost:${config.port}`,
);
