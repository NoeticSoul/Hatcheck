// Time-ordered ids for append-only event tables (custody events, import
// rows). Lexicographic order == chronological order, with a per-process
// counter breaking same-millisecond ties, so `ORDER BY (at, id)` is total
// and portable without relying on engine-specific autoincrement semantics.
// Across processes (multi-replica PG) same-millisecond ordering between
// writers is arbitrary but stable, which is acceptable for history views.

let lastMs = 0;
let seq = 0;

export function timeOrderedId(): string {
  const now = Date.now();
  if (now === lastMs) {
    // 16 bits of tie-breaker; wrapping within one millisecond would need
    // >65k events/ms from one process, far beyond any realistic burst.
    seq = (seq + 1) & 0xffff;
  } else {
    lastMs = now;
    seq = 0;
  }
  const ms = now.toString(16).padStart(12, "0");
  const tie = seq.toString(16).padStart(4, "0");
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  return `${ms}${tie}${rand}`;
}
