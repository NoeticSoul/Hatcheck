import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    globalSetup: ["./src/test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    maxWorkers: 4,
    // Application fixtures use the selected database; PG store contracts
    // also run when HATCHECK_TEST_PG_URL is supplied.
  },
});
