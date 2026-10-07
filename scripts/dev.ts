// Dev runner: starts the API server (bun --watch) and the Vite dev server
// in one terminal, prefixes each output line with [api] / [web], and exits
// non-zero if either child dies. Uses only node:child_process so it runs
// under both Bun and Node (CLAUDE.md: no Bun-only APIs).
//
import type { ChildProcess } from "node:child_process";
import { spawnDevProcess, stopDevProcesses, type DevProcessSpec } from "../src/server/dev-process";

const specs: DevProcessSpec[] = [
  { name: "api", command: "bun", args: ["--watch", "src/server/index.ts"] },
  { name: "web", command: "bunx", args: ["vite", "src/web"] },
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

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopDevProcesses(children).then(
    () => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`[dev] cleanup failed: ${String(error)}\n`);
      process.exit(1);
    },
  );
}

for (const spec of specs) {
  const child = spawnDevProcess(spec);
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
