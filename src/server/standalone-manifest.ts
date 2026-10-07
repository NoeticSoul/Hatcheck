// Standalone-build manifest. scripts/compile.ts generates embedded-file
// imports in an isolated source copy; this module stays empty in the checkout.
// The generated imports are embedded by bun build --compile. Empty
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
