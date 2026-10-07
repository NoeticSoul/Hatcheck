// Standalone compile target (maintainer decision: pulled forward from
// Phase 3 as a TEST build; the public release pipeline with SHA256SUMS
// publishing, attestations, and code signing remains Phase 3).
//
// What it does:
//   1. builds the web bundle (vite),
//   2. copies source into an isolated directory and generates embedded-file
//      imports there, so development and parallel builds retain the stub,
//   3. compiles the isolated entrypoint into a single-file executable per
//      requested target, printing a SHA-256 for each,
//   4. removes temporary build inputs, leaving repository source untouched.
//
// Usage: bun run compile [--target linux-x64|windows-x64|darwin-arm64|
//        darwin-x64|all]  (default: linux-x64 and windows-x64)
// A single target can use --compile-executable-path PATH with a verified
// matching-version Bun runtime when the automatic download is unavailable.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT_DIR = join(ROOT, "dist/bin");

const TARGETS: Record<string, { bun: string; suffix: string }> = {
  "linux-x64": { bun: "bun-linux-x64", suffix: "" },
  "windows-x64": { bun: "bun-windows-x64", suffix: ".exe" },
  "darwin-arm64": { bun: "bun-darwin-arm64", suffix: "" },
  "darwin-x64": { bun: "bun-darwin-x64", suffix: "" },
};

function run(command: string, args: string[], cwd = ROOT): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

/** Generated module: embedded-file imports plus the manifest object. */
function generateManifest(webDist: string, migrationsRoot: string): string {
  const imports: string[] = [];
  const webEntries: string[] = [];
  const migrationEntries: string[] = [];
  let n = 0;

  for (const file of walk(webDist).sort()) {
    const urlPath = "/" + toPosix(relative(webDist, file));
    const importPath = "../../dist/web/" + toPosix(relative(webDist, file));
    const ident = `web${n++}`;
    imports.push(
      `import ${ident} from ${JSON.stringify(importPath)} with { type: "file" };`,
    );
    webEntries.push(`  ${JSON.stringify(urlPath)}: ${ident},`);
  }

  for (const engine of ["sqlite", "pg"]) {
    const dir = join(migrationsRoot, engine);
    for (const file of walk(dir).sort()) {
      const rel = toPosix(relative(migrationsRoot, file));
      // The migrator needs the .sql files and the journal; snapshots are
      // drizzle-kit development artifacts.
      if (!rel.endsWith(".sql") && !rel.endsWith("_journal.json")) continue;
      const importPath = "../db/migrations/" + rel;
      const ident = `mig${n++}`;
      imports.push(
        `import ${ident} from ${JSON.stringify(importPath)} with { type: "file" };`,
      );
      migrationEntries.push(`  ${JSON.stringify(rel)}: ${ident},`);
    }
  }

  return [
    "// GENERATED only in an isolated scripts/compile.ts build directory.",
    ...imports,
    "",
    "export interface StandaloneManifest {",
    "  webAssets: Record<string, string>;",
    "  migrationFiles: Record<string, string>;",
    "}",
    "",
    "export const manifest: StandaloneManifest = {",
    "  webAssets: {",
    ...webEntries,
    "  },",
    "  migrationFiles: {",
    ...migrationEntries,
    "  },",
    "};",
    "",
  ].join("\n");
}

function parseTargets(): string[] {
  const flag = process.argv.indexOf("--target");
  const value = flag === -1 ? undefined : process.argv[flag + 1];
  if (flag !== -1 && value === undefined) throw new Error("--target requires a target name");
  if (value === undefined) return ["linux-x64", "windows-x64"];
  if (value === "all") return Object.keys(TARGETS);
  if (!(value in TARGETS)) {
    throw new Error(
      `unknown target ${value}; expected ${Object.keys(TARGETS).join(", ")} or all`,
    );
  }
  return [value];
}

const targets = parseTargets();
const executableFlag = process.argv.indexOf("--compile-executable-path");
const executable = executableFlag === -1 ? undefined : process.argv[executableFlag + 1];
if (executableFlag !== -1 && (!executable || targets.length !== 1)) {
  throw new Error("--compile-executable-path requires a path and a single --target");
}
if (executable !== undefined && !statSync(executable).isFile()) throw new Error("Bun executable path must be a file");
const buildRoot = mkdtempSync(join(tmpdir(), "hatcheck-compile-"));
mkdirSync(OUT_DIR, { recursive: true });
try {
  cpSync(join(ROOT, "src"), join(buildRoot, "src"), { recursive: true });
  for (const file of ["package.json", "tsconfig.json"]) {
    cpSync(join(ROOT, file), join(buildRoot, file));
  }
  // A directory junction also works on Windows without requiring symlink
  // privileges. Dependencies remain the frozen installed packages.
  symlinkSync(join(ROOT, "node_modules"), join(buildRoot, "node_modules"), "junction");
  console.log(`[compile] building isolated web bundle...`);
  run("bun", ["run", "build"], buildRoot);
  writeFileSync(join(buildRoot, "src/server/standalone-manifest.ts"), generateManifest(join(buildRoot, "dist/web"), join(buildRoot, "src/db/migrations")));
  for (const target of targets) {
    const spec = TARGETS[target];
    if (spec === undefined) continue;
    const outfile = join(OUT_DIR, `hatcheck-${target}${spec.suffix}`);
    console.log(`[compile] ${target} -> ${relative(ROOT, outfile)}`);
    run("bun", [
      "build",
      "--compile",
      `--target=${spec.bun}`,
      ...(executable === undefined ? [] : [`--compile-executable-path=${resolve(executable)}`]),
      // Node-only fallbacks; never loaded under the Bun runtime, so the
      // native addons stay out of the binary (see password.ts and
      // store.sqlite.ts).
      "--external",
      "@node-rs/argon2",
      "--external",
      "better-sqlite3",
      "src/server/index.ts",
      "--outfile",
      outfile,
    ], buildRoot);
    const digest = createHash("sha256")
      .update(readFileSync(outfile))
      .digest("hex");
    console.log(`[compile] sha256(${relative(ROOT, outfile)}) = ${digest}`);
  }
} finally {
  rmSync(buildRoot, { recursive: true, force: true });
}
console.log("[compile] done; isolated build inputs removed");
