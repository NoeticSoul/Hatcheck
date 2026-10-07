import { createServer } from "node:net";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { spawnDevProcess, stopDevProcesses } from "./dev-process";

async function canBind(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

describe.runIf(process.platform !== "win32")("POSIX dev process cleanup", () => {
  it("terminates a watcher and the server it spawned", async () => {
    const worker = `
      const { spawn } = require('node:child_process');
      const source = "require('node:net').createServer().listen(0, '127.0.0.1', function () { console.log(this.address().port); });";
      const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.pipe(process.stdout);
      setInterval(() => {}, 1000);
    `;
    const child = spawnDevProcess({ name: "test-watcher", command: process.execPath, args: ["-e", worker] });
    try {
      const [data] = await once(child.stdout!, "data");
      const port = Number(String(data).trim());
      expect(await canBind(port)).toBe(false);
      await stopDevProcesses([child]);
      expect(await canBind(port)).toBe(true);
    } finally { await stopDevProcesses([child]); }
  });
});
