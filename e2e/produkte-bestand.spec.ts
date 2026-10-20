import type { Page } from "@playwright/test";
import { ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * Bestand (F03 PRD-090…097) as the signed-in owner: a good with stock tracking and a reorder level, a Zugang and an
 * Abgang with mandatory texts, the running balance in the „Buchungsverlauf“ and the „Unter Meldebestand“ badge.
 * Needs the backend and runs after e2e/journey.spec.ts and e2e/kontakte-produkte.spec.ts (the service „Wartung
 * Heizung“) in the same project (single worker, files in order).
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-stock.json`;
let ready = false;

test.beforeAll(async ({ browser }, testInfo) => {
  ready = (await ownerStorageState(browser, testInfo.project.use, STATE(testInfo.project.name))) !== null;
});
test.beforeEach(() => {
  test.skip(!ready, "needs the backend journey (owner with completed setup)");
});
test.use({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures must destructure their first argument
  storageState: async ({}, use, testInfo) => use(ready ? STATE(testInfo.project.name) : undefined),
});
test.describe.configure({ mode: "serial" });

const h1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name });

async function book(page: Page, kind: string, quantity: string, text: string) {
  await page.getByRole("button", { name: "Bestand buchen" }).click();
  const dialog = page.getByRole("dialog", { name: "Bestand buchen" });
  await dialog.getByLabel("Art").selectOption({ label: kind });
  await dialog.getByLabel(/^Menge/).fill(quantity);
  await dialog.getByLabel(/^Text/).fill(text);
  await dialog.getByRole("button", { name: "Bestand buchen" }).click();
  await expect(dialog).toBeHidden();
}

test("PRD-090 PRD-094 PRD-096 PRD-097 a good tracks stock with manual movements and the reorder level", async ({
  page,
  expectNoAxeViolations,
}, testInfo) => {
  const name = `E2E Lagerartikel ${testInfo.project.name}`;
  await page.goto("/produkte/neu");
  await page.getByRole("radio", { name: "Ware" }).check();
  await page.getByLabel("Name", { exact: false }).first().fill(name);
  await page.getByLabel("VK netto").fill("10");
  await page.getByRole("button", { name: "Produkt anlegen" }).click();
  await expect(page).toHaveURL(/\/produkte\/(?!neu$)[a-z0-9]+$/, { timeout: 20_000 });
  await expect(h1(page, name)).toBeVisible();

  await page.getByRole("tab", { name: "Bestand" }).click();
  await expect(page.getByText("Für dieses Produkt wird kein Bestand geführt.")).toBeVisible();
  await expectNoAxeViolations();
  await page.getByLabel("Bestand führen").check();
  await page.getByLabel("Meldebestand").fill("5");
  await page.getByRole("button", { name: "Einstellungen speichern" }).click();
  await expect(page.getByTestId("stock-quantity")).toHaveText(/^0 /);

  await book(page, "Zugang", "10", "Wareneingang");
  await expect(page.getByTestId("stock-quantity")).toHaveText(/^10 /);
  await expect(page.getByText("Unter Meldebestand")).toHaveCount(0);

  await book(page, "Abgang", "7", "Eigenverbrauch Muster");
  await expect(page.getByTestId("stock-quantity")).toHaveText(/^3 /);
  await expect(page.getByText("Unter Meldebestand")).toBeVisible();

  const rows = page.getByTestId("stock-history").getByRole("row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText("Abgang");
  await expect(rows.nth(1)).toContainText("-7");
  await expect(rows.nth(1)).toContainText("Eigenverbrauch Muster");
  await expect(rows.nth(2)).toContainText("+10");
  await expectNoAxeViolations();
});

test("PRD-090 services have no Bestand tab", async ({ page }) => {
  await page.goto("/produkte");
  await page.getByRole("link", { name: "Wartung Heizung" }).filter({ visible: true }).first().click();
  await expect(page.getByRole("tab", { name: "Preise" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Bestand" })).toHaveCount(0);
});
