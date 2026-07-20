// Password hashing adapter. Bun runs use the built-in Bun.password
// (argon2id, no native addon — which is what lets the standalone
// compiled binary exist); Node runs use @node-rs/argon2. Both emit
// standard argon2id PHC strings and verify each other's output
// (interop-tested in password.test.ts), so a database written under one
// runtime keeps working under the other. The node library is loaded
// lazily and marked external at compile time, keeping the native addon
// out of compiled binaries entirely.

interface BunPasswordSurface {
  password: {
    hash(
      password: string,
      options: { algorithm: "argon2id" },
    ): Promise<string>;
    verify(password: string, hash: string): Promise<boolean>;
  };
}

// bun-types is not installed (tsconfig types: node); declare the minimal
// surface, same pattern as index.ts.
declare const Bun: BunPasswordSurface;

type NodeArgon2 = typeof import("@node-rs/argon2");
let nodeArgon2: Promise<NodeArgon2> | null = null;
function loadNodeArgon2(): Promise<NodeArgon2> {
  nodeArgon2 ??= import("@node-rs/argon2");
  return nodeArgon2;
}

const isBun = process.versions.bun !== undefined;

export async function hashPassword(password: string): Promise<string> {
  if (isBun) {
    return Bun.password.hash(password, { algorithm: "argon2id" });
  }
  return (await loadNodeArgon2()).hash(password);
}

/** Argument order matches @node-rs/argon2: stored hash first. */
export async function verifyPassword(
  storedHash: string,
  password: string,
): Promise<boolean> {
  try {
    if (isBun) {
      return await Bun.password.verify(password, storedHash);
    }
    return await (await loadNodeArgon2()).verify(storedHash, password);
  } catch {
    // A malformed stored hash is a non-match, not a 500.
    return false;
  }
}
