import { describe, expect, it } from "vitest";
import { isProxyAddress, matchesProxyAddress } from "./proxy-address";

describe("trusted proxy address boundaries", () => {
  it.each(["*", "proxy.example.test", "10.0.1.0/33", "10.0.1.0/-1", "10.0.1.0/08", "10.0.1.0/", "10.0.1.0/24/1", "::1/129", "fe80::1%eth0", "999.0.0.1", "::1/2x"])(
    "rejects malformed entries %s", (entry) => expect(isProxyAddress(entry)).toBe(false),
  );

  it("restricts changing ALB socket addresses to their explicit subnet", () => {
    expect(matchesProxyAddress("10.0.1.10", "10.0.1.0/24")).toBe(true);
    expect(matchesProxyAddress("10.0.1.255", "10.0.1.0/24")).toBe(true);
    expect(matchesProxyAddress("::ffff:10.0.1.10", "10.0.1.0/24")).toBe(true);
    expect(matchesProxyAddress("::ffff:a00:10a", "10.0.1.0/24")).toBe(true);
    expect(matchesProxyAddress("10.0.2.10", "10.0.1.0/24")).toBe(false);
    expect(matchesProxyAddress("203.0.113.10", "10.0.1.0/24")).toBe(false);
    expect(matchesProxyAddress("invalid", "10.0.1.0/24")).toBe(false);
  });

  it("compares IPv6 numerically and respects prefixes and literal addresses", () => {
    expect(matchesProxyAddress("2001:db8:1:abcd::42", "2001:db8:1::/48")).toBe(true);
    expect(matchesProxyAddress("2001:db8:2::42", "2001:db8:1::/48")).toBe(false);
    expect(matchesProxyAddress("0:0:0:0:0:0:0:1", "::1")).toBe(true);
    expect(matchesProxyAddress("127.0.0.2", "127.0.0.1")).toBe(false);
    expect(matchesProxyAddress("::ffff:192.0.2.1", "::ffff:192.0.2.1")).toBe(true);
  });
});
