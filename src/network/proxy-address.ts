import { isIP } from "node:net";

interface Address {
  bits: number;
  value: bigint;
}

function address(text: string): Address | null {
  const family = isIP(text);
  if (family === 0 || text.includes("%")) return null;
  if (family === 4) {
    return { bits: 32, value: text.split(".").reduce((n, part) => (n << 8n) | BigInt(part), 0n) };
  }
  let expanded = text.toLowerCase();
  // IPv4 tails occupy the last two IPv6 words, including mapped sockets.
  if (expanded.includes(".")) {
    const separator = expanded.lastIndexOf(":");
    const tail = address(expanded.slice(separator + 1));
    if (tail === null) return null;
    expanded = expanded.slice(0, separator + 1) +
      `${(tail.value >> 16n).toString(16)}:${(tail.value & 65535n).toString(16)}`;
  }
  const halves = expanded.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words = halves.length === 2
    ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
    : left;
  return { bits: 128, value: words.reduce((n, word) => (n << 16n) | BigInt(`0x${word}`), 0n) };
}

function range(entry: string): { address: Address; prefix: number } | null {
  const parts = entry.split("/");
  const parsed = address(parts[0] ?? "");
  if (parsed === null || parts.length > 2) return null;
  const rawPrefix = parts[1];
  if (rawPrefix !== undefined && !/^(0|[1-9][0-9]*)$/.test(rawPrefix)) return null;
  const prefix = rawPrefix === undefined ? parsed.bits : Number(rawPrefix);
  if (prefix > parsed.bits) return null;
  return { address: parsed, prefix };
}

export function isProxyAddress(entry: string): boolean {
  return range(entry) !== null;
}

/** Match only the actual socket peer; forwarded headers never establish trust. */
export function matchesProxyAddress(peer: string, entry: string): boolean {
  const trusted = range(entry);
  let candidate = address(peer);
  if (trusted === null || candidate === null) return false;
  if (trusted.address.bits === 32 && candidate.bits === 128 &&
      candidate.value >> 32n === 65535n) {
    candidate = { bits: 32, value: candidate.value & 4294967295n };
  }
  if (candidate.bits !== trusted.address.bits) return false;
  const shift = BigInt(candidate.bits - trusted.prefix);
  return candidate.value >> shift === trusted.address.value >> shift;
}
