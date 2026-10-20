import type { Page } from "@playwright/test";
import { ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * F09 EXP-001…016 DATEV card on /export as the owner: set Berater-/Mandantennummer, „Prüfen" (report drawer),
 * „Export erstellen" (job), the history entry and the „Testexport" download confirmation (EXP-016, TST-EXP-14).
 * axe on the page and the drawer. Needs the backend journey (owner with completed setup).
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-datev.json`;
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
test.describe.configure({ mode: "serial", timeout: 240_000 });

const h1 = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name });

test("EXP-007 EXP-009 TST-EXP-14 the owner checks, creates and downloads a DATEV Testexport", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/einstellungen/steuern");
  await page.getByLabel("Beraternummer").fill("1234567");
  await page.getByLabel("Mandantennummer").fill("12345");
  await page.getByRole("button", { name: "Speichern" }).first().click();
  await expect(page.getByText(/Gespeichert/).first()).toBeVisible({ timeout: 20_000 });

  await page.goto("/export");
  await expect(h1(page, "Export")).toBeVisible();
  await expect(page.getByRole("heading", { name: "DATEV-Export" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "DATEV-Import noch nicht" })).toBeVisible();
  await page.getByRole("button", { name: "Vorjahr" }).click();
  const year = new Date().getFullYear();
  await page.getByLabel("Bis").fill(`${year}-12-31`);
  await page.getByRole("button", { name: "Prüfen" }).click();
  const drawer = page.getByRole("dialog", { name: "Prüfbericht" });
  await expect(drawer).toBeVisible({ timeout: 60_000 });
  await expectNoAxeViolations();
  const create = drawer.getByRole("button", { name: "Export erstellen" });
  test.skip(await create.isDisabled(), "no bookings in the range or blocking issues on this deployment");
  await create.click();

  const history = page.getByRole("region", { name: "Export-Historie" });
  const download = history.getByRole("button", { name: /DATEV_.*_Testexport\.zip herunterladen/ }).first();
  await expect(download).toBeVisible({ timeout: 120_000 });
  await download.click();
  const confirm = page.getByRole("dialog", { name: "Testexport herunterladen" });
  await expect(confirm.getByRole("button", { name: "Herunterladen" })).toBeDisabled();
  await confirm.getByRole("checkbox", { name: /mir ist bekannt/ }).check();
  const file = page.waitForEvent("download");
  await confirm.getByRole("button", { name: "Herunterladen" }).click();
  expect((await file).suggestedFilename()).toMatch(/\.zip$/);
  await expectNoAxeViolations();
});
