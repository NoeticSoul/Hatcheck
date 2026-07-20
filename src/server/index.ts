// Server entrypoint. Bun is the canonical runtime for Hatcheck (CLAUDE.md
// stack), so Bun-specific APIs (Bun.serve, hono/bun serveStatic) are
// allowed here and ONLY here; createApp itself stays runtime-neutral.
//
// This same entry is also the standalone compiled binary: when
// scripts/compile.ts has populated standalone-manifest.ts, the web
// bundle is served from files embedded in the binary and the migrations
// are extracted beside the runtime before the store boots. With the
// committed empty manifest, behavior is unchanged.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serveStatic } from "hono/bun";
import { loadConfig } from "../config";
import { createStore } from "../db/client";
import { createApp } from "./app";
import { ensureInitialAdmin } from "./bootstrap";
import { manifest } from "./standalone-manifest";

// bun-types is not installed (tsconfig types: node), so declare the minimal
// Bun surface this file uses.
interface BunServer {
  requestIP(request: Request): { address: string } | null;
}

interface BunFileLike extends Blob {
  readonly type: string;
}

declare const Bun: {
  serve(options: {
    port: number;
    fetch: (
      request: Request,
      server: BunServer,
    ) => Response | Promise<Response>;
  }): { port: number };
  file(path: string): BunFileLike;
};

const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

const isStandalone = Object.keys(manifest.webAssets).length > 0;
if (isStandalone) {
  // The standalone binary is an operator-facing build; production is the
  // only sensible default, but an explicit env still wins.
  process.env["NODE_ENV"] ??= "production";
}

// Embedded migrations must be on disk before the store migrates: the
// drizzle migrator reads a folder, and source-tree paths do not exist
// inside a compiled binary. A fresh temp dir per boot keeps the data
// directory clean and makes stale-migration mixups impossible.
if (Object.keys(manifest.migrationFiles).length > 0) {
  const extractRoot = join(
    tmpdir(),
    `hatcheck-migrations-${process.pid.toString(36)}-${Date.now().toString(36)}`,
  );
  for (const [rel, embeddedPath] of Object.entries(manifest.migrationFiles)) {
    const target = join(extractRoot, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      new Uint8Array(await Bun.file(embeddedPath).arrayBuffer()),
    );
  }
  process.env["HATCHECK_SQLITE_MIGRATIONS_DIR"] = join(extractRoot, "sqlite");
  process.env["HATCHECK_PG_MIGRATIONS_DIR"] = join(extractRoot, "pg");
}

const config = loadConfig();
const store = await createStore(config);
await store.migrate();
// First run on an empty database: create the initial admin and print its
// password once. No-op the moment any user exists (seeded or otherwise).
await ensureInitialAdmin(store);

const app = createApp(store, config);

if (isStandalone) {
  // Serve the SPA from the files embedded in the binary. Hashed asset
  // names are immutable; index.html must always revalidate so a swapped
  // binary is picked up.
  app.get("*", (c, next) => {
    const path = c.req.path;
    if (path.startsWith("/api/")) return next();
    const key = path === "/" ? "/index.html" : path;
    const embedded = manifest.webAssets[key] ?? manifest.webAssets["/index.html"];
    if (embedded === undefined) return next();
    const file = Bun.file(embedded);
    return new Response(file, {
      headers: {
        "Content-Type": file.type,
        "Cache-Control":
          key.startsWith("/assets/") && manifest.webAssets[key] !== undefined
            ? "public, max-age=31536000, immutable"
            : "no-cache",
      },
    });
  });
} else if (config.isProduction) {
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
