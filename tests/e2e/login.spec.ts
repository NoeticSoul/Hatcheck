import { expect, test } from "@playwright/test";

// Synthetic seed credentials: the email comes from the seed script, the
// password is set by tests/e2e/serve.ts via HATCHECK_SEED_ADMIN_PASSWORD.
const ADMIN_EMAIL = "admin@hatcheck.test";
const ADMIN_PASSWORD = "e2e-admin-password-0k";

test("unauthenticated visit to / redirects to /login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
});

test("local login reaches the dashboard, logout returns to login", async ({
  page,
}) => {
  await page.goto("/login");

  await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
  await page.getByLabel(/password/i).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign in|log in/i }).click();

  // Dashboard shell: top bar carries the product name and the role badge.
  await expect(page).not.toHaveURL(/\/login$/);
  const topBar = page.getByRole("banner");
  await expect(topBar).toContainText("Hatcheck");
  await expect(topBar).toContainText("admin");

  await page.getByRole("button", { name: /log out|sign out/i }).click();
  await expect(page).toHaveURL(/\/login$/);
});
