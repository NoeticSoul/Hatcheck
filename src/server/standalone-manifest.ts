// Standalone-build manifest. scripts/compile.ts temporarily OVERWRITES
// this module with generated `with { type: "file" }` imports (which
// bun build --compile embeds into the binary) and restores this stub
// afterwards — the committed file is always this empty version. Empty
// maps mean "not a standalone build": index.ts then serves dist/web from
// disk and reads migrations from the source tree as usual.

export interface StandaloneManifest {
  /** URL path (e.g. "/index.html") -> embedded path for Bun.file(). */
  webAssets: Record<string, string>;
  /** Migration path relative to src/db/migrations (e.g.
   *  "sqlite/0000_init.sql") -> embedded path for Bun.file(). */
  migrationFiles: Record<string, string>;
}

export const manifest: StandaloneManifest = {
  webAssets: {},
  migrationFiles: {},
};
