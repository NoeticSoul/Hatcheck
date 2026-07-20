// CSV import through the real UI: dry-run preview creates nothing,
// commit creates assets, and an identity collision surfaces as an open
// exception that a human resolves. Synthetic data only; identities carry
// a per-attempt suffix so CI retries and parallel spec files sharing one
// server never collide with earlier data.
import { expect, test } from "@playwright/test";
import { loginAsAdmin, navTo } from "./helpers";

const RUN = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
const LAPTOP = `E2I Cart Laptop ${RUN}`;
const CSV =
  "name,serial_number,asset_tag\n" +
  `${LAPTOP},SN-E2I-A-${RUN},HT-E2I-A-${RUN}\n` +
  `E2I Spare Dock ${RUN},SN-E2I-B-${RUN},HT-E2I-B-${RUN}\n`;

test("dry run previews without creating, commit imports the file", async ({
  page,
}) => {
  await loginAsAdmin(page);

  await navTo(page, "Import");
  await page.getByLabel("CSV content").fill(CSV);

  // Dry run: full per-row report, nothing persisted.
  await page.getByRole("button", { name: /preview \(dry run\)/i }).click();
  await expect(page.getByText("Dry-run preview")).toBeVisible();
  await expect(
    page
      .getByTestId("import-result")
      .getByText("2 rows: 2 created, 0 skipped, 0 collisions, 0 errors"),
  ).toBeVisible();
  await navTo(page, "Assets");
  await page.getByLabel("Search assets").fill(LAPTOP);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("No assets match.")).toBeVisible();

  // Commit: the same file now creates both assets.
  await navTo(page, "Import");
  await page.getByLabel("CSV content").fill(CSV);
  await page.getByRole("button", { name: /commit import/i }).click();
  await expect(page.getByText("Import result")).toBeVisible();
  await expect(
    page
      .getByTestId("import-result")
      .getByText("2 rows: 2 created, 0 skipped, 0 collisions, 0 errors"),
  ).toBeVisible();

  await navTo(page, "Assets");
  await page.getByLabel("Search assets").fill(LAPTOP);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("link", { name: LAPTOP })).toBeVisible();
});

test("identity collision becomes an exception a human resolves", async ({
  page,
}) => {
  const serial = `SN-E2I-C-${RUN}`;
  await loginAsAdmin(page);

  // Seed the owning asset through a committed import.
  await navTo(page, "Import");
  await page
    .getByLabel("CSV content")
    .fill(
      `name,serial_number,asset_tag\nE2I Owner ${RUN},${serial},HT-E2I-C1-${RUN}\n`,
    );
  await page.getByRole("button", { name: /commit import/i }).click();
  await expect(
    page
      .getByTestId("import-result")
      .getByText("1 rows: 1 created, 0 skipped, 0 collisions, 0 errors"),
  ).toBeVisible();

  // Same serial, different tag: refused and routed to review.
  await page
    .getByLabel("CSV content")
    .fill(
      `name,serial_number,asset_tag\nE2I Intruder ${RUN},${serial},HT-E2I-C9-${RUN}\n`,
    );
  await page.getByRole("button", { name: /commit import/i }).click();
  await expect(
    page
      .getByTestId("import-result")
      .getByText("1 rows: 0 created, 0 skipped, 1 collisions, 0 errors"),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: /asset_tag differs/ }),
  ).toBeVisible();

  // The exception is open, carries the conflict, and can be resolved.
  await navTo(page, "Exceptions");
  const row = page.getByRole("row", { name: new RegExp(serial) });
  await expect(row).toContainText("Open");
  await row.getByRole("button", { name: "Review" }).click();
  await expect(
    page.getByRole("dialog").getByText(`E2I Owner ${RUN}`),
  ).toBeVisible();
  await page.getByLabel("Decision").selectOption("dismissed");
  await page.getByLabel(/note/i).fill("Known dock shared between carts");
  await page.getByRole("button", { name: /record decision/i }).click();

  // Open filter no longer shows it; the dismissed filter does.
  await expect(row).toBeHidden();
  await page.getByLabel("Filter by status").selectOption("dismissed");
  await expect(
    page.getByRole("row", { name: new RegExp(serial) }),
  ).toContainText("Dismissed");
});
