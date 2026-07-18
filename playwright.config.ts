import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "bun tests/e2e/serve.ts",
    url: `${BASE_URL}/api/v1/health`,
    reuseExistingServer: false,
    // Playwright merges this over process.env for the spawned command.
    env: { PORT: String(PORT) },
    stdout: "pipe",
    // Covers the vite build that serve.ts now runs before starting.
    timeout: 120_000,
  },
});
