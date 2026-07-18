// Asset identity normalization. The database enforces uniqueness on the
// normalized shadow columns (asset_tag_norm, serial_number_norm,
// system_uuid_norm); this module is the single source of that
// normalization so SQLite and PostgreSQL never disagree on case or
// whitespace handling (CLAUDE.md hard rule 1 — no engine collation tricks).

/** Serial numbers and asset tags: trimmed, upper-cased; null when blank. */
export function normalizeIdentityKey(
  value: string | null | undefined,
): string | null {
  const v = value?.trim();
  return v === undefined || v === "" ? null : v.toUpperCase();
}

/** System UUIDs: trimmed, lower-cased; null when blank. */
export function normalizeSystemUuid(
  value: string | null | undefined,
): string | null {
  const v = value?.trim();
  return v === undefined || v === "" ? null : v.toLowerCase();
}

/**
 * MAC addresses: accepts aa:bb:cc:dd:ee:ff, aa-bb-..., aabb.ccdd.eeff, or
 * bare hex; returns canonical lower-case colon form. Returns null for a
 * malformed value — callers must treat blank input as "absent" before
 * calling. MACs are per-interface attributes and are NEVER used as a
 * primary identity/matching key (CLAUDE.md Phase 1 domain rule).
 */
export function parseMac(value: string): string | null {
  const hex = value.trim().replace(/[:.\-\s]/g, "").toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(hex)) return null;
  const pairs: string[] = [];
  for (let i = 0; i < 12; i += 2) pairs.push(hex.slice(i, i + 2));
  return pairs.join(":");
}
