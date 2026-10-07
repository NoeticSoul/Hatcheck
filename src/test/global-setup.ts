import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createPgStore } from "../db/store.pg";

export default async function setup() {
  const baseUrl = process.env.HATCHECK_TEST_PG_URL;
  if (!baseUrl) {
    if (process.env.HATCHECK_TEST_DB === "postgres") throw new Error("Set HATCHECK_TEST_PG_URL to a disposable PostgreSQL test service.");
    return;
  }
  const prefix = `hctest_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const template = `${prefix}_template`;
  const admin = postgres(baseUrl, { max: 1 });
  const cleanup = async () => {
    const rows = await admin<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE starts_with(datname, ${prefix + "_"})
    `;
    for (const row of rows) {
      if (!/^[a-z0-9_]+$/.test(row.datname)) throw new Error("Unsafe test database name.");
      await admin.unsafe(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`);
    }
    await admin.end();
  };
  try {
    await admin.unsafe(`CREATE DATABASE "${template}"`);
    const url = new URL(baseUrl);
    url.pathname = `/${template}`;
    const store = createPgStore(url.toString());
    try { await store.migrate(); } finally { await store.close(); }
    process.env.HATCHECK_TEST_PREFIX = prefix;
    process.env.HATCHECK_TEST_TEMPLATE = template;
  } catch (error) {
    await cleanup();
    throw error;
  }
  // Catch fixtures whose failed assertion interrupted their close() call.
  return cleanup;
}
