import { expect, test } from "@playwright/test";
import { loginAsAdmin, navTo } from "./helpers";

const RUN = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

test("an outdated preview cannot enable commit and edited input requires a new preview", async ({ page }) => {
  await loginAsAdmin(page);
  await navTo(page, "Import");
  const original = `name,serial_number\nOld preview,SN-OLD-${RUN}\n`;
  const edited = `name,serial_number\nReviewed input,SN-REVIEWED-${RUN}\n`;
  let respond: (() => void) | undefined;
  const responseGate = new Promise<void>((resolve) => { respond = resolve; });
  let intercepted: (() => void) | undefined;
  const interceptGate = new Promise<void>((resolve) => { intercepted = resolve; });
  await page.route("**/api/v1/imports/assets?**", async (route) => {
    const response = await route.fetch();
    intercepted!();
    await responseGate;
    await route.fulfill({ response });
  });
  await page.getByLabel("CSV content").fill(original);
  const commit = page.getByRole("button", { name: "Commit import", exact: true });
  await expect(commit).toBeDisabled();
  await page.getByRole("button", { name: /Preview \(dry run\)/ }).click();
  await interceptGate;
  await page.getByLabel("CSV content").fill(edited);
  respond!();
  await expect(page.getByRole("button", { name: /Preview \(dry run\)/ })).toBeEnabled();
  await expect(page.getByTestId("import-result")).toBeHidden();
  await expect(commit).toBeDisabled();
  await page.unroute("**/api/v1/imports/assets?**");
  await page.getByRole("button", { name: /Preview \(dry run\)/ }).click();
  await expect(page.getByText("Dry-run preview", { exact: true })).toBeVisible();
  await expect(commit).toBeEnabled();
  await page.getByLabel("Filename", { exact: true }).fill("edited.csv");
  await expect(commit).toBeDisabled();
  await expect(page.getByTestId("import-result")).toBeHidden();
});

test("saved import reports page through outcomes and download the complete report", async ({ page }) => {
  await loginAsAdmin(page);
  await navTo(page, "Import");
  await page.getByLabel("Filename", { exact: true }).fill(`history-${RUN}.csv`);
  await page.getByLabel("CSV content").fill("name,serial_number\n" + Array.from({ length: 52 }, (_, index) => `History ${index},SN-HISTORY-${RUN}-${index}`).join("\n"));
  await page.getByRole("button", { name: /Preview \(dry run\)/ }).click();
  await expect(page.getByText("Dry-run preview", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Open full report and download outcomes" }).click();
  await expect(page.getByRole("heading", { name: "Import report", exact: true })).toBeVisible();
  await expect(page.getByText("Showing 1-50 of 52 rows", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Showing 51-52 of 52 rows", { exact: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "would be created" })).toHaveCount(2);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download outcomes CSV", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^import-.*-outcomes\.csv$/);
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  let contents = "";
  for await (const chunk of stream!) contents += chunk.toString();
  expect(contents).toContain(`SN-HISTORY-${RUN}-51`);
  expect(contents.trim().split("\r\n")).toHaveLength(53);
});

test("list failures show a retry action instead of indefinite loading", async ({ page }) => {
  await loginAsAdmin(page);
  await page.route("**/api/v1/assets?**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Inventory unavailable" } }) }));
  await navTo(page, "Assets");
  await expect(page.getByRole("alert")).toContainText("Inventory unavailable");
  await page.unroute("**/api/v1/assets?**");
  await page.getByRole("button", { name: "Retry assets" }).click();
  await expect(page.getByRole("alert")).toBeHidden();
  await expect(page.getByRole("cell", { name: "Loading...", exact: true })).toBeHidden();
});
