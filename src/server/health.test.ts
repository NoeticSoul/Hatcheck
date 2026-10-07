import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { createSqliteStore } from "../db/store.sqlite";
import { createApp } from "./app";

describe("operational health endpoints", () => {
  it("keeps liveness serving when database readiness fails, without leaking driver errors", async () => {
    const store = await createSqliteStore(":memory:");
    await store.migrate();
    const app = createApp(store, loadConfig({ NODE_ENV: "test" }));
    expect((await app.request("/api/v1/ready")).status).toBe(200);
    await store.close();
    for (const path of ["/api/v1/health", "/api/v1/ready"]) {
      const response = await app.request(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: "not_ready", message: "Database is unavailable" } });
    }
    expect((await app.request("/api/v1/live")).status).toBe(200);
  });
});
