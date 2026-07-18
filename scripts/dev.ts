// Dev runner: starts the API server (bun --watch) and the Vite dev server
// in one terminal, prefixes each output line with [api] / [web], and exits
// non-zero if either child dies. Uses only node:child_process so it runs
// under both Bun and Node (CLAUDE.md: no Bun-only APIs).
//
// shell: true is required so the npm-style launcher shims (bun.cmd /
// bunx.cmd) resolve on Windows; on POSIX it just runs through /bin/sh.
import { spawn, type ChildProcess } from "node:child_process";

interface ProcSpec {
  name: string;
  command: string;
}

const specs: ProcSpec[] = [
  { name: "api", command: "bun --watch src/server/index.ts" },
  { name: "web", command: "bunx vite src/web" },
];

const children: ChildProcess[] = [];
let shuttingDown = false;

function prefixLines(
  name: string,
  stream: NodeJS.ReadableStream | null,
  out: NodeJS.WriteStream,
): void {
  if (stream === null) return;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) out.write(`[${name}] ${line}\n`);
  });
  stream.on("end", () => {
    if (buffer.length > 0) out.write(`[${name}] ${buffer}\n`);
  });
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    // child.kill() would only hit the cmd.exe wrapper; taskkill /T takes the
    // whole tree (bun/vite grandchildren) down with it.
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } else {
    child.kill("SIGTERM");
  }
}

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killTree(child);
  // Give the kills a moment to land before exiting ourselves.
  setTimeout(() => process.exit(code), 300);
}

for (const spec of specs) {
  const child = spawn(spec.command, {
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  children.push(child);
  prefixLines(spec.name, child.stdout, process.stdout);
  prefixLines(spec.name, child.stderr, process.stderr);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    process.stderr.write(
      `[dev] ${spec.name} exited (code=${String(code)} signal=${String(signal)}); shutting down\n`,
    );
    shutdown(code === null || code === 0 ? 1 : code);
  });
  child.on("error", (err) => {
    if (shuttingDown) return;
    process.stderr.write(`[dev] failed to start ${spec.name}: ${err.message}\n`);
    shutdown(1);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
