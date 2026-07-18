import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import type { Store } from "../db/store";
import { createSqliteStore } from "../db/store.sqlite";
import {
  AiNotConfiguredError,
  AiNotImplementedError,
  createAiAdapter,
} from "./index";

describe("ai adapter stub", () => {
  let store: Store;

  beforeEach(async () => {
    store = await createSqliteStore(":memory:");
    await store.migrate();
  });

  afterEach(async () => {
    await store.close();
  });

  it("is disabled by default with an empty environment", () => {
    const config = loadConfig({});
    const ai = createAiAdapter(config, store);
    expect(ai.status()).toEqual({ enabled: false, provider: null });
  });

  it("status reflects HATCHECK_AI_PROVIDER", () => {
    const config = loadConfig({ HATCHECK_AI_PROVIDER: "ollama" });
    const ai = createAiAdapter(config, store);
    expect(ai.status()).toEqual({ enabled: true, provider: "ollama" });
  });

  it("rejects an unknown provider name at config time", () => {
    expect(() => loadConfig({ HATCHECK_AI_PROVIDER: "skynet" })).toThrow();
  });

  it("invoke when disabled throws AiNotConfiguredError and writes no audit rows", async () => {
    const config = loadConfig({});
    const ai = createAiAdapter(config, store);
    await expect(
      ai.invoke("docs.summarize", { userId: null, email: null }),
    ).rejects.toBeInstanceOf(AiNotConfiguredError);
    expect(await store.countAudit()).toBe(0);
  });

  it("invoke when enabled writes exactly one ai.call audit row then throws AiNotImplementedError", async () => {
    const config = loadConfig({ HATCHECK_AI_PROVIDER: "anthropic" });
    const ai = createAiAdapter(config, store);
    await expect(
      ai.invoke("docs.summarize", {
        userId: "user-1",
        email: "admin@hatcheck.test",
      }),
    ).rejects.toBeInstanceOf(AiNotImplementedError);

    expect(await store.countAudit()).toBe(1);
    const entries = await store.listAudit({ limit: 10 });
    const entry = entries[0];
    expect(entry).toBeDefined();
    expect(entry?.action).toBe("ai.call");
    expect(entry?.actorUserId).toBe("user-1");
    expect(entry?.actorEmail).toBe("admin@hatcheck.test");
    expect(entry?.entityType).toBe("ai");
    expect(JSON.parse(entry?.details ?? "null")).toEqual({
      feature: "docs.summarize",
      provider: "anthropic",
    });
  });
});
