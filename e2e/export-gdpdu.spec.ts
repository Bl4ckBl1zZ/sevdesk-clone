import type { Page } from "@playwright/test";
import { ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * F09 EXP-017/018 GDPdU card on /export as the owner: create the Z3 package of the current year, see it in the list
 * and download it (F12 AUD-009 audited). axe on the page. Needs the backend journey (owner with completed setup).
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-gdpdu.json`;
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
test.describe.configure({ mode: "serial", timeout: 180_000 });

const h1 = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name });

test("EXP-017 TST-EXP-16 the owner creates the GDPdU package of the current year and downloads it", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/export");
  await expect(h1(page, "Export")).toBeVisible();
  const card = page.getByRole("heading", { name: "GDPdU / Z3 (Datenträgerüberlassung)" });
  await expect(card).toBeVisible();
  const year = String(new Date().getFullYear());
  await page.getByLabel("Wirtschaftsjahr").selectOption(year);
  await page.getByRole("button", { name: "GDPdU-Export erstellen" }).click();
  const list = page.getByRole("list", { name: "GDPdU-Exporte" });
  await expect(list.getByText(`Wirtschaftsjahr ${year}`).first()).toBeVisible({ timeout: 120_000 });
  await expectNoAxeViolations();
  const download = page.waitForEvent("download");
  await list
    .getByRole("button", { name: `gdpdu-${year}.zip herunterladen` })
    .first()
    .click();
  expect((await download).suggestedFilename()).toMatch(/\.zip$/);
});
