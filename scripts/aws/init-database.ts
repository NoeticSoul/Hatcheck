/**
 * One-off RDS role initialization. Execute only against Hatcheck's dedicated
 * database through the initialize ECS task, never the application task role.
 * RDS's managed master login has CREATEROLE but is not a PostgreSQL superuser.
 * Passwords arrive through ECS secret injection and never reach logs/argv.
 */
import postgres from "postgres";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { loadConfig } from "../../src/config";
import { postgresSslOptions } from "../../src/db/postgres-options";

const OWNER = "hatcheck_owner";
const RUNTIME = "hatcheck_app";

function requirePassword(name: string): string {
  const value = process.env[name];
  if (!value || !/^[\x21-\x7e]{24,1024}$/.test(value)) {
    throw new Error(`${name} must contain a 24-1024 character printable ASCII secret`);
  }
  return value;
}

function scramVerifier(password: string): string {
  // PostgreSQL accepts a SCRAM verifier in PASSWORD. Printable ASCII has
  // identical SASLprep/UTF-8 bytes, so a password never enters a SQL statement
  // or PostgreSQL's error statement log, even if a utility statement fails.
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const client = createHmac("sha256", salted).update("Client Key").digest();
  const stored = createHash("sha256").update(client).digest("base64");
  const server = createHmac("sha256", salted).update("Server Key").digest("base64");
  return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${stored}:${server}`;
}

// PostgreSQL utility statements (CREATE/ALTER ROLE) do not accept bind
// parameters in their password clause. Escape every literal explicitly;
// never interpolate a password through shell evaluation or a SQL logger.
function literal(value: string): string {
  return `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function initialize(): Promise<void> {
  const config = loadConfig();
  if (config.db.kind !== "postgres" || !config.db.databaseUrl || config.db.sslMode !== "verify-full") {
    throw new Error("RDS initialization requires PostgreSQL with verify-full TLS");
  }
  const master = process.env.PGUSER;
  const database = process.env.PGDATABASE;
  if (!master || !database || master === OWNER || master === RUNTIME) {
    throw new Error("Use the dedicated RDS managed master login and database");
  }
  const passwords = { [OWNER]: requirePassword("POSTGRES_OWNER_PASSWORD"), [RUNTIME]: requirePassword("POSTGRES_APP_PASSWORD") };
  const sql = postgres(config.db.databaseUrl, { ...postgresSslOptions(config.db), max: 1, connect_timeout: 10 });
  try {
    await sql.begin(async (tx) => {
      // Same advisory key as the owner migrator: concurrent operator tasks
      // cannot change credentials/ownership during schema initialization.
      await tx`select pg_advisory_xact_lock(753223850)`;
      // PG17 grants the creator ADMIN automatically, but not INHERIT/SET.
      // Request both at creation; granting ADMIN back to one's own grantor
      // is rejected by PostgreSQL and is unnecessary here.
      await tx.unsafe("SET LOCAL createrole_self_grant = 'inherit,set'");
      const [connection] = await tx<{ username: string; database: string }[]>`select current_user as username, current_database() as database`;
      if (connection?.username !== master || connection.database !== database) {
        throw new Error("Initialization connection does not match the selected master/database");
      }
      for (const role of [OWNER, RUNTIME] as const) {
        const [existing] = await tx<{ unsafe: boolean }[]>`
          select rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls as unsafe
          from pg_roles where rolname = ${role}
        `;
        if (existing?.unsafe) throw new Error(`Refusing existing privileged role ${role}`);
        const [membership] = await tx<{ count: number }[]>`
          select count(*)::integer as count from pg_auth_members
          where member = (select oid from pg_roles where rolname = ${role})
        `;
        if (membership && membership.count > 0) throw new Error(`Refusing inherited privileges on role ${role}`);
        if (!existing) {
          await tx.unsafe(`CREATE ROLE ${identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(scramVerifier(passwords[role]))}`);
        } else {
          // Re-running with the same current secret is safe; an explicitly
          // rotated secret is applied only during this reviewed maintenance task.
          await tx.unsafe(`ALTER ROLE ${identifier(role)} LOGIN PASSWORD ${literal(scramVerifier(passwords[role]))}`);
        }
        // Keep the creator's existing ADMIN while allowing ownership changes.
        await tx.unsafe(`GRANT ${identifier(role)} TO ${identifier(master)} WITH INHERIT TRUE, SET TRUE`);
      }
      await tx.unsafe(`ALTER DATABASE ${identifier(database)} OWNER TO ${identifier(OWNER)}`);
      await tx.unsafe(`REVOKE ALL ON DATABASE ${identifier(database)} FROM PUBLIC`);
      await tx.unsafe(`GRANT CONNECT ON DATABASE ${identifier(database)} TO ${identifier(OWNER)}, ${identifier(RUNTIME)}`);
      await tx.unsafe(`ALTER SCHEMA public OWNER TO ${identifier(OWNER)}`);
      await tx.unsafe("REVOKE ALL ON SCHEMA public FROM PUBLIC");
      await tx.unsafe(`GRANT USAGE ON SCHEMA public TO ${identifier(RUNTIME)}`);
    });
    console.log("Hatcheck database roles initialized. Run the owner migration task before starting the service.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

try {
  await initialize();
} catch (error) {
  // PostgreSQL utility errors can carry the original SQL (and its secret).
  // Only a SQLSTATE/class is safe to publish to CloudWatch.
  const code = error instanceof postgres.PostgresError ? error.code : "INITIALIZATION_FAILED";
  console.error(`Database role initialization failed (${code}). Check configuration and permissions without printing secret-bearing SQL.`);
  process.exitCode = 1;
}
