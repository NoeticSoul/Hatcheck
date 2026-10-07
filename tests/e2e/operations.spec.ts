import { expect, test } from "@playwright/test";
import { ADMIN_PASSWORD, loginAsAdmin, navTo } from "./helpers";

const RUN = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

test("administrator manages access and a local user changes their own password", async ({ page }) => {
  const name = `Operations User ${RUN}`;
  const email = `operations-${RUN}@example.test`;
  const initialPassword = `initial-password-${RUN}`;
  const resetPassword = `reset-password-${RUN}`;
  const finalPassword = `final-password-${RUN}`;
  await loginAsAdmin(page);
  await navTo(page, "Users");
  await page.getByRole("button", { name: "New user", exact: true }).click();
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Role", { exact: true }).selectOption("readonly");
  await page.getByLabel("Initial password").fill(initialPassword);
  await page.getByRole("button", { name: "Create user", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: email });
  await expect(row).toContainText("Active");
  await row.getByRole("button", { name: `Edit ${name}`, exact: true }).click();
  await page.getByLabel("Account active").uncheck();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(row).toContainText("Inactive");
  await row.getByRole("button", { name: `Edit ${name}`, exact: true }).click();
  await page.getByLabel("Account active").check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(row).toContainText("Active");
  await row.getByRole("button", { name: `Reset password for ${name}`, exact: true }).click();
  await page.getByLabel("New password", { exact: true }).fill(resetPassword);
  await page.getByRole("dialog").getByRole("button", { name: "Reset password", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(resetPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("banner")).toContainText("readonly");
  await expect(page.getByLabel("Primary").getByRole("link", { name: "Users", exact: true })).toBeHidden();
  await page.getByRole("link", { name: "Your account", exact: true }).click();
  await page.getByLabel("Current password", { exact: true }).fill("incorrect-current-password");
  await page.getByLabel("New password", { exact: true }).fill(finalPassword);
  await page.getByLabel("Confirm new password", { exact: true }).fill(finalPassword);
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/account$/);
  await page.getByLabel("Current password", { exact: true }).fill(resetPassword);
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  await expect(page).toHaveURL(/\/login\?passwordChanged=1/);
  await expect(page.getByRole("status")).toContainText("Password changed");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(finalPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
});

test("failed sign out stays honest and can be retried", async ({ page }) => {
  await loginAsAdmin(page);
  await page.route("**/api/v1/auth/logout", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Temporary outage" } }) }));
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Your session may still be active");
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole("banner")).toContainText("admin");
  await page.unroute("**/api/v1/auth/logout");
  await page.getByRole("button", { name: "Retry sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("session expiry redirects from a page request and restores the destination", async ({ page }) => {
  await loginAsAdmin(page);
  await page.route("**/api/v1/assets?**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "unauthorized", message: "Session expired" } }) }));
  await page.goto("/assets?status=in_repair");
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  await page.unroute("**/api/v1/assets?**");
  await page.getByLabel("Email", { exact: true }).fill("admin@hatcheck.test");
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/assets\?status=in_repair$/);
  await expect(page.getByLabel("Filter by status")).toHaveValue("in_repair");
});

test("mobile asset dialog stays within the viewport, traps focus, and restores it", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await loginAsAdmin(page);
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toHaveAccessibleName("Sign out");
  await navTo(page, "Assets");
  const trigger = page.getByRole("button", { name: "New asset", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "New asset", exact: true });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(667);
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "Close dialog" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close dialog", exact: true })).toBeFocused();
  await page.getByLabel("Name", { exact: true }).fill(`Mobile Asset ${RUN}`);
  await page.getByLabel("Notes", { exact: true }).fill("Reachable bottom field");
  await expect(dialog.getByRole("button", { name: "Create asset", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
});

test("dashboard cards link to the inventory state they count", async ({ page }) => {
  await loginAsAdmin(page);
  await page.getByRole("link", { name: /^In repair \d+$/ }).click();
  await expect(page).toHaveURL(/\/assets\?status=in_repair$/);
  await expect(page.getByLabel("Filter by status")).toHaveValue("in_repair");
});
