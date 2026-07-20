import type { Page } from "@playwright/test";

// Synthetic seed credentials: the email comes from the seed script, the
// password is set by tests/e2e/serve.ts via HATCHECK_SEED_ADMIN_PASSWORD.
export const ADMIN_EMAIL = "admin@hatcheck.test";
export const ADMIN_PASSWORD = "e2e-admin-password-0k";

export async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
  await page.getByLabel(/password/i).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"));
}

/**
 * Click a primary-nav item. Scoped to the header nav (aria-label
 * "Primary") because page bodies may carry same-named links (back links,
 * cross-references), which would trip strict mode.
 */
export async function navTo(page: Page, name: string): Promise<void> {
  await page.getByLabel("Primary").getByRole("link", { name }).click();
}
