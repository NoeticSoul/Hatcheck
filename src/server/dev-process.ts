import { spawn, type ChildProcess } from "node:child_process";

export interface DevProcessSpec {
  name: string;
  command: string;
  args: string[];
}

export function spawnDevProcess(spec: DevProcessSpec): ChildProcess {
  return spawn(spec.command, spec.args, {
    // Windows launcher shims require cmd.exe. POSIX runs argv directly and
    // assigns each server a group containing its watcher grandchildren.
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    killer.on("error", () => undefined);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export async function stopDevProcesses(children: ChildProcess[], graceMs = 5_000): Promise<void> {
  const stopped = children.map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) resolve();
    else child.once("close", () => resolve());
  }));
  for (const child of children) signalGroup(child, "SIGTERM");
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(stopped),
      new Promise<void>((resolve) => { deadline = setTimeout(resolve, graceMs); }),
    ]);
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    // Watcher parents can exit before a descendant that ignores SIGTERM.
    for (const child of children) signalGroup(child, "SIGKILL");
  }
}
