// Interop guarantee for the password adapter: whatever runtime the
// adapter branches to, its output must verify under @node-rs/argon2 and
// @node-rs/argon2 output must verify under the adapter. This is what
// makes a database portable between the Node toolchain, the Bun dev
// server, and the compiled standalone binary.
import { hash as rsHash, verify as rsVerify } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

const PASSWORD = "interop-check-battery-staple";

describe("password adapter", () => {
  it("round-trips its own hashes", async () => {
    const stored = await hashPassword(PASSWORD);
    expect(stored.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(stored, PASSWORD)).toBe(true);
    expect(await verifyPassword(stored, "wrong-password")).toBe(false);
  });

  it("verifies hashes produced by @node-rs/argon2", async () => {
    const stored = await rsHash(PASSWORD);
    expect(await verifyPassword(stored, PASSWORD)).toBe(true);
    expect(await verifyPassword(stored, "wrong-password")).toBe(false);
  });

  it("produces hashes @node-rs/argon2 verifies", async () => {
    const stored = await hashPassword(PASSWORD);
    expect(await rsVerify(stored, PASSWORD)).toBe(true);
  });

  it("treats a malformed stored hash as a non-match", async () => {
    expect(await verifyPassword("not-a-phc-string", PASSWORD)).toBe(false);
    expect(await verifyPassword("", PASSWORD)).toBe(false);
  });
});
