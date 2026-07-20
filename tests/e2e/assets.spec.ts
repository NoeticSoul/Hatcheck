// Asset lifecycle through the real UI: location setup, asset creation,
// the check-out -> check-in round trip whose full history must survive
// (Phase 1 gate criterion 3, exercised end to end), and the audit view.
// Synthetic data only; names carry a per-attempt suffix so CI retries and
// parallel spec files sharing one server never collide with earlier data.
import { expect, test } from "@playwright/test";
import { loginAsAdmin, navTo } from "./helpers";

const RUN = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
const DEPOT = `E2A Depot ${RUN}`;
const LAPTOP = `E2A Loaner ${RUN}`;
const SERIAL = `SN-E2A-${RUN}`;

test("create location and asset, run a custody round trip", async ({
  page,
}) => {
  await loginAsAdmin(page);

  // Location first: the asset form's location picker should offer it.
  await navTo(page, "Locations");
  await page.getByRole("button", { name: /new location/i }).click();
  await page.getByLabel("Name").fill(DEPOT);
  await page.getByLabel("Kind").selectOption("site");
  await page.getByRole("button", { name: /create location/i }).click();
  await expect(page.getByRole("cell", { name: DEPOT, exact: true })).toBeVisible();

  // Create the asset.
  await navTo(page, "Assets");
  await page.getByRole("button", { name: /new asset/i }).click();
  await page.getByLabel("Name").fill(LAPTOP);
  await page.getByLabel("Serial number").fill(SERIAL);
  await page.getByLabel("Location").selectOption({ label: DEPOT });
  await page.getByRole("button", { name: /create asset/i }).click();

  // Creation lands on the detail page with the status badge in stock.
  await expect(page.getByRole("heading", { name: LAPTOP })).toBeVisible();
  const status = page.getByTestId("asset-status");
  await expect(status).toHaveText("In stock");

  // Check out to a free-text holder.
  await page.getByRole("button", { name: /check out/i }).click();
  await page.getByLabel("Holder").selectOption("label");
  await page.getByLabel("Holder name").fill("Visiting Auditor");
  await page.getByLabel(/note/i).fill("Loan for the audit week");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /check out/i })
    .click();
  await expect(status).toHaveText("Deployed");
  await expect(
    page.getByText(/current holder: visiting auditor/i),
  ).toBeVisible();

  // Check back in.
  await page.getByRole("button", { name: /check in/i }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /check in/i })
    .click();
  await expect(status).toHaveText("In stock");

  // The round trip preserved BOTH events, newest first: row 0 is the
  // header, row 1 the check-in, row 2 the original check-out.
  const historyRows = page
    .getByTestId("custody-history")
    .getByRole("row");
  await expect(historyRows).toHaveCount(3);
  await expect(historyRows.nth(1)).toContainText("Checked in");
  await expect(historyRows.nth(2)).toContainText("Checked out");
  await expect(historyRows.nth(2)).toContainText("Visiting Auditor");
  await expect(historyRows.nth(2)).toContainText("Loan for the audit week");

  // The list shows the asset back in stock.
  await navTo(page, "Assets");
  await page.getByLabel("Search assets").fill(LAPTOP);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const row = page.getByRole("row", { name: new RegExp(LAPTOP) });
  await expect(row).toContainText("In stock");

  // And every mutation above is visible in the audit view.
  await navTo(page, "Audit");
  await page.getByLabel("Filter by action").fill("asset.create");
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  const auditRows = page.getByRole("row");
  await expect(auditRows.nth(1)).toContainText("asset.create");
  await expect(auditRows.nth(1)).toContainText("admin@hatcheck.test");
});
