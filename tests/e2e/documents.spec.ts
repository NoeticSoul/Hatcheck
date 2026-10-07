import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { loginAsAdmin, navTo } from "./helpers";

test("author, approve, revise and export a selected SOP with overdue review tracking", async ({ page }) => {
  const code = `SOP-LAB-${Date.now().toString().slice(-6)}`;
  const title = "Verify an inventory backup restore";
  await loginAsAdmin(page);
  await navTo(page, "Documents");
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await page.getByLabel("SOP code", { exact: true }).fill(code);
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Review date", { exact: true }).fill("2000-01-01");
  const sections = {
    Purpose: "Prove that a Hatcheck SQLite backup restores accountable inventory records.",
    Scope: "A disposable synthetic lab instance; retain the live instance and its backups.",
    Prerequisites: "Bun installed, repository checkout, a populated data/hatcheck.db, and a writable backups directory. Never use a live restore target.",
    Procedure: "1. Run bun scripts/recovery.ts sqlite backup backups/lab.db data/hatcheck.db.\n2. Run bun scripts/recovery.ts sqlite restore backups/lab.db data/restore-drill.db.\n3. Start the restored instance with HATCHECK_SQLITE_PATH=data/restore-drill.db PORT=3200 APP_URL=http://localhost:3200 bun run start.\n4. Sign in using a restored account and inspect asset custody and audit history.\n5. Stop the drill instance and retain the backup.",
    Verification: "Confirm a known synthetic asset, its latest holder, full custody history, and matching audit entries. Check that an existing destination is refused.",
    Escalation: "If verification fails, preserve the snapshot and failure output, stop the drill, and contact the instance administrator. Do not overwrite the live database.",
  };
  for (const [label, content] of Object.entries(sections)) await page.getByLabel(label, { exact: true }).fill(content);
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Overdue for review");
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.getByRole("button", { name: "Publish revision", exact: true }).click();
  await page.getByRole("button", { name: "Confirm publish", exact: true }).click();
  await expect(page.getByRole("link", { name: "Revision 1", exact: true }).locator("..")).toContainText("Published");

  // Readers keep the approved snapshot while staff prepare a later revision.
  const email = `sop-reader-${randomUUID()}@example.test`;
  const password = randomUUID();
  expect((await page.request.post("/api/v1/users", { data: { email, displayName: "SOP Reader", role: "readonly", password } })).status()).toBe(201);
  await page.getByRole("button", { name: "Edit document", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill(`${title} - updated`);
  await page.getByLabel("Review date", { exact: true }).fill("2099-12-31");
  await page.getByLabel("Change summary", { exact: true }).fill("Schedule the next review after confirming the recovery drill.");
  await page.getByRole("button", { name: "Save new revision", exact: true }).click();
  await expect(page.getByRole("heading", { name: `${title} - updated`, exact: true })).toBeVisible();
  await expect(page.getByText("Revision 1 remains visible", { exact: false })).toBeVisible();
  await navTo(page, "Dashboard");
  await page.getByRole("link", { name: /^Documents due for review \d+$/ }).click();
  await expect(page.getByLabel("Approved only", { exact: true })).toBeChecked();
  await page.getByRole("link").filter({ hasText: code }).click();
  await expect(page).toHaveURL(/revision=1$/);
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  for (const format of ["Markdown", "HTML", "DOCX"]) {
    const promise = page.waitForEvent("download");
    await page.getByRole("link", { name: `Export ${format}`, exact: true }).click();
    const download = await promise;
    expect(download.suggestedFilename()).toContain(`${code}-r1.`);
    await download.saveAs(test.info().outputPath(`recovery-sop.${format === "Markdown" ? "md" : format.toLowerCase()}`));
  }
  await page.getByRole("button", { name: "Restore as new revision", exact: true }).click();
  await expect(page.getByLabel("Change summary", { exact: true })).toHaveValue("Restore revision 1 content");
  await page.getByLabel("Title", { exact: true }).fill(`${title} - restored`);
  await page.getByRole("button", { name: "Save new revision", exact: true }).click();
  await expect(page.getByRole("heading", { name: `${title} - restored`, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Revision 3", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("banner")).toContainText("readonly");
  await page.goto(`/documents/${id}`);
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit document", exact: true })).toBeHidden();
  await expect(page.getByRole("link", { name: "Revision 2", exact: true })).toBeHidden();
  await navTo(page, "Dashboard");
  await page.getByRole("link", { name: /^Documents due for review \d+$/ }).click();
  await expect(page.getByLabel("Overdue for review", { exact: true })).toBeChecked();
  await page.getByLabel("Search documents").fill(code);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByLabel("Overdue for review", { exact: true }).check();
  await expect(page.getByRole("link").filter({ hasText: code })).toContainText("Overdue for review");
});
