import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterEach } from "vitest";
import { createPgStore } from "../db/store.pg";
import { createSqliteStore } from "../db/store.sqlite";
import type { Store } from "../db/store";

const fixtures = new Set<Store>();
afterEach(async () => {
  const pending = [...fixtures];
  fixtures.clear();
  await Promise.all(pending.map((store) => store.close()));
});

/** Each PostgreSQL application fixture owns a database, never shared tables. */
export async function createTestStore(sqlitePath = ":memory:"): Promise<Store> {
  if (process.env.HATCHECK_TEST_DB !== "postgres") {
    const store = await createSqliteStore(sqlitePath);
    let closed = false;
    const fixture: Store = {
      ...store,
      async close() {
        if (closed) return;
        closed = true;
        fixtures.delete(fixture);
        await store.close();
      },
    };
    fixtures.add(fixture);
    return fixture;
  }
  return createPgTestStore();
}

/** Store contracts and API tests both isolate their PostgreSQL databases. */
export async function createPgTestStore(): Promise<Store> {
  const baseUrl = process.env.HATCHECK_TEST_PG_URL;
  const template = process.env.HATCHECK_TEST_TEMPLATE;
  const prefix = process.env.HATCHECK_TEST_PREFIX;
  if (!baseUrl || !template || !prefix) {
    throw new Error("PostgreSQL application tests require the Vitest global setup and HATCHECK_TEST_PG_URL.");
  }
  if (!/^[a-z0-9_]+$/.test(template) || !/^[a-z0-9_]+$/.test(prefix)) {
    throw new Error("Invalid disposable test database namespace.");
  }
  const name = `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = postgres(baseUrl, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const store = createPgStore(url.toString());
  let closed = false;
  const fixture: Store = {
    ...store,
    // The template was migrated once before workers started. Avoid repeating
    // migration discovery/DDL for each cloned application fixture.
    async migrate() {},
    async close() {
      if (closed) return;
      closed = true;
      fixtures.delete(fixture);
      await store.close();
      const cleanup = postgres(baseUrl, { max: 1 });
      try {
        await cleanup.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
  fixtures.add(fixture);
  return fixture;
}
