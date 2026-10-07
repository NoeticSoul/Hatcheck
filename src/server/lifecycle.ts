import type { Store } from "../db/store";

export interface RuntimeServer {
  stop(closeActiveConnections?: boolean): Promise<void>;
}

/** Stop accepting work, finish active requests and sweeps, then close the DB. */
export function createLifecycle(
  store: Store,
  server: RuntimeServer,
  options: {
    sweepIntervalMs?: number;
    drainTimeoutMs?: number;
    cleanup?: () => void | Promise<void>;
    report?: (error: unknown) => void;
  } = {},
) {
  let sweep: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;
  const report = options.report ?? ((error) => console.error("Runtime cleanup failed:", error));
  const timer = setInterval(() => {
    if (sweep !== undefined) return;
    sweep = store.deleteExpiredSessions(Date.now()).catch(report).finally(() => {
      sweep = undefined;
    });
  }, options.sweepIntervalMs ?? 60 * 60 * 1000);
  timer.unref();

  return {
    stop(): Promise<void> {
      shutdown ??= (async () => {
        clearInterval(timer);
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            (async () => { await server.stop(false); await sweep; })(),
            new Promise<void>((resolve, reject) => {
              deadline = setTimeout(() => {
                server.stop(true).then(resolve, reject);
              }, options.drainTimeoutMs ?? 15_000);
            }),
          ]);
        } finally {
          if (deadline !== undefined) clearTimeout(deadline);
          try {
            await store.close();
          } finally {
            await options.cleanup?.();
          }
        }
      })();
      return shutdown;
    },
  };
}
