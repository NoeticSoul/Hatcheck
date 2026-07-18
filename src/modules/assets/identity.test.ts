import { describe, expect, it } from "vitest";
import {
  normalizeIdentityKey,
  normalizeSystemUuid,
  parseMac,
} from "./identity";

describe("normalizeIdentityKey", () => {
  it("trims and upper-cases values", () => {
    expect(normalizeIdentityKey("  sn-alpha-01  ")).toBe("SN-ALPHA-01");
    expect(normalizeIdentityKey("it-0001")).toBe("IT-0001");
    expect(normalizeIdentityKey("ALREADY-UPPER")).toBe("ALREADY-UPPER");
    expect(normalizeIdentityKey("\tmix3d Ca5e\n")).toBe("MIX3D CA5E");
  });

  it("maps blank, undefined, and null to null", () => {
    expect(normalizeIdentityKey("")).toBeNull();
    expect(normalizeIdentityKey("   ")).toBeNull();
    expect(normalizeIdentityKey("\t\n")).toBeNull();
    expect(normalizeIdentityKey(undefined)).toBeNull();
    expect(normalizeIdentityKey(null)).toBeNull();
  });
});

describe("normalizeSystemUuid", () => {
  it("trims and lower-cases values", () => {
    expect(
      normalizeSystemUuid("  9F8E7D6C-1234-4ABC-8DEF-000000000001  "),
    ).toBe("9f8e7d6c-1234-4abc-8def-000000000001");
    expect(normalizeSystemUuid("already-lower")).toBe("already-lower");
  });

  it("maps blank, undefined, and null to null", () => {
    expect(normalizeSystemUuid("")).toBeNull();
    expect(normalizeSystemUuid("   ")).toBeNull();
    expect(normalizeSystemUuid(undefined)).toBeNull();
    expect(normalizeSystemUuid(null)).toBeNull();
  });
});

describe("parseMac", () => {
  // All MACs below are from the RFC 7042 documentation range
  // 00:00:5e:00:53:xx (synthetic data only).
  it("canonicalizes colon, dash, dot, and bare hex forms", () => {
    expect(parseMac("00:00:5E:00:53:01")).toBe("00:00:5e:00:53:01");
    expect(parseMac("00-00-5E-00-53-02")).toBe("00:00:5e:00:53:02");
    expect(parseMac("0000.5e00.5303")).toBe("00:00:5e:00:53:03");
    expect(parseMac("00005E005304")).toBe("00:00:5e:00:53:04");
    expect(parseMac("  00:00:5e:00:53:05  ")).toBe("00:00:5e:00:53:05");
    // Already-canonical input is a fixed point.
    expect(parseMac("00:00:5e:00:53:06")).toBe("00:00:5e:00:53:06");
  });

  it("returns null for malformed values", () => {
    expect(parseMac("")).toBeNull();
    expect(parseMac("   ")).toBeNull();
    expect(parseMac("00:00:5e:00:53")).toBeNull();
    expect(parseMac("00:00:5e:00:53:01:02")).toBeNull();
    expect(parseMac("00:00:5g:00:53:01")).toBeNull();
    expect(parseMac("00005e00530")).toBeNull();
    expect(parseMac("not-a-mac")).toBeNull();
  });
});
