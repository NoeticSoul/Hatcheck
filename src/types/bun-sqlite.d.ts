// Minimal ambient types for bun:sqlite, covering only the surface Hatcheck
// uses. bun-types is intentionally not installed (it would layer a second
// global environment over @types/node for the whole repo); this keeps the
// Bun-only driver typecheckable under the plain Node type set.
declare module "bun:sqlite" {
  export class Database {
    constructor(
      filename?: string,
      options?: { create?: boolean; readonly?: boolean; readwrite?: boolean },
    );
    run(sql: string, ...params: unknown[]): unknown;
    close(throwOnError?: boolean): void;
  }
}
