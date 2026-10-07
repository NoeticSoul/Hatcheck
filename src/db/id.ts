// Time-ordered ids for append-only event tables (custody events, import
// rows). IDs increase within one process, including clock rollback and
// same-millisecond bursts. They are identifiers and display tie-breakers:
// cross-process causal ordering must use the persisted custody sequence.

let lastMs = 0;
let seq = 0;

export function timeOrderedId(): string {
  let now = Math.max(Date.now(), lastMs);
  if (now === lastMs) {
    seq += 1;
    if (seq > 0xffff) {
      now += 1;
      lastMs = now;
      seq = 0;
    }
  } else {
    lastMs = now;
    seq = 0;
  }
  const ms = now.toString(16).padStart(12, "0");
  const tie = seq.toString(16).padStart(4, "0");
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  return `${ms}${tie}${rand}`;
}
