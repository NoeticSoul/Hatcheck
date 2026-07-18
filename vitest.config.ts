import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // PG integration tests self-skip when HATCHECK_TEST_PG_URL is not set;
    // CI sets it in the postgres matrix leg.
  },
});
