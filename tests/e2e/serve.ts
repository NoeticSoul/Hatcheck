// E2E launcher, run by playwright.config.ts as the webServer command.
// Seeds a scratch SQLite database, then runs the real production server as
// a child process with the same environment. Server logic is not duplicated
// here: the seed script and src/server/index.ts are executed as-is.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = process.env["PORT"] ?? "3100";
const dataDir = mkdtempSync(join(tmpdir(), "hatcheck-e2e-"));

const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "production",
  PORT: port,
  APP_URL: `http://localhost:${port}`,
  HATCHECK_DB: "sqlite",
  HATCHECK_SQLITE_PATH: join(dataDir, "e2e.db"),
  // Synthetic e2e-only credential, mirrored in login.spec.ts. Not a secret.
  HATCHECK_SEED_ADMIN_PASSWORD: "e2e-admin-password-0k",
};

// shell: true so the bun launcher shim (bun.cmd) resolves on Windows.
function run(command: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, { shell: true, stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolvePromise(code ?? (signal === null ? 0 : 1));
    });
  });
}

async function main(): Promise<void> {
  // Always test the current frontend: dist/web is gitignored and may be
  // missing (fresh clone) or stale (edited src/web) without this build.
  const buildCode = await run("bun run build");
  if (buildCode !== 0) {
    process.stderr.write(`[e2e] build failed with exit code ${buildCode}\n`);
    process.exit(buildCode);
  }
  const seedCode = await run("bun src/db/seed.ts");
  if (seedCode !== 0) {
    process.stderr.write(`[e2e] seed failed with exit code ${seedCode}\n`);
    process.exit(seedCode);
  }
  process.exit(await run("bun src/server/index.ts"));
}

main().catch((err: unknown) => {
  process.stderr.write(`[e2e] launcher error: ${String(err)}\n`);
  process.exit(1);
});
