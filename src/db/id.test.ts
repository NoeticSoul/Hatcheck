import { describe, expect, it } from "vitest";
import { timeOrderedId } from "./id";

describe("timeOrderedId", () => {
  it("produces 26 lowercase hex chars with a leading ms timestamp", () => {
    const before = Date.now();
    const id = timeOrderedId();
    const after = Date.now();
    expect(id).toMatch(/^[0-9a-f]{26}$/);
    // First 12 hex chars encode the millisecond timestamp.
    const ms = parseInt(id.slice(0, 12), 16);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });

  it("is unique across a tight burst of calls", () => {
    const n = 5000;
    const ids = new Set<string>();
    for (let i = 0; i < n; i++) {
      ids.add(timeOrderedId());
    }
    expect(ids.size).toBe(n);
  });

  it("sorts lexicographically in generation order", () => {
    const ids: string[] = [];
    for (let i = 0; i < 2000; i++) {
      ids.push(timeOrderedId());
    }
    // A tight loop guarantees many same-millisecond ids, so this exercises
    // the 16-bit tie-breaker, not just the timestamp prefix.
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    // Strictly increasing: ORDER BY id is a total order for one process.
    let prev = "";
    for (const id of ids) {
      expect(id > prev).toBe(true);
      prev = id;
    }
  });
});
