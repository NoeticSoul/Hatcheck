import { describe, expect, it, vi } from "vitest";
import type { Store } from "../db/store";
import { createLifecycle } from "./lifecycle";

describe("runtime lifecycle", () => {
  it("drains active requests and an in-flight sweep before closing the store once", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      let finishRequest!: () => void;
      let finishSweep!: () => void;
      const request = new Promise<void>((resolve) => { finishRequest = resolve; });
      const sweep = new Promise<void>((resolve) => { finishSweep = resolve; });
      const store = {
        deleteExpiredSessions: vi.fn(() => { calls.push("sweep"); return sweep; }),
        close: vi.fn(async () => { calls.push("close"); }),
      } as unknown as Store;
      const lifecycle = createLifecycle(store, { stop: vi.fn(() => { calls.push("drain"); return request; }) }, {
        sweepIntervalMs: 10, cleanup: () => { calls.push("cleanup"); },
      });
      await vi.advanceTimersByTimeAsync(10);
      const stop = lifecycle.stop();
      expect(lifecycle.stop()).toBe(stop);
      finishRequest();
      await Promise.resolve();
      expect(store.close).not.toHaveBeenCalled();
      finishSweep();
      await stop;
      await vi.advanceTimersByTimeAsync(100);
      expect(calls).toEqual(["sweep", "drain", "close", "cleanup"]);
    } finally { vi.useRealTimers(); }
  });

  it("forces remaining connections closed after the configured drain deadline", async () => {
    vi.useFakeTimers();
    try {
      const server = { stop: vi.fn((force?: boolean) => force ? Promise.resolve() : new Promise<void>(() => {})) };
      const close = vi.fn(async () => {});
      const lifecycle = createLifecycle({ close, deleteExpiredSessions: vi.fn() } as unknown as Store, server, { drainTimeoutMs: 20 });
      const stop = lifecycle.stop();
      await vi.advanceTimersByTimeAsync(20);
      await stop;
      expect(server.stop.mock.calls).toEqual([[false], [true]]);
      expect(close).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});
