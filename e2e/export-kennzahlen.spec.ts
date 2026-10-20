import { ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * F09 EXP-020 „Kennzahlen" card on /export as the owner: the UStVA sheet of the current month as CSV and PDF.
 * axe on the page. Needs the backend journey (owner with completed setup).
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-kennzahlen.json`;
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

test("EXP-020 the owner downloads the UStVA Kennzahlen of the current month as CSV and PDF", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/export");
  await expect(page.getByRole("heading", { name: "Kennzahlen" })).toBeVisible();
  await expectNoAxeViolations();
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  await page.getByLabel("Meldung").selectOption("ustva");
  await page.getByRole("textbox", { name: "Zeitraum", exact: true }).fill(period);
  const csv = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV herunterladen" }).click();
  expect((await csv).suggestedFilename()).toBe(`UStVA_${period}_Kennzahlen.csv`);
  const pdf = page.waitForEvent("download");
  await page.getByRole("button", { name: "PDF herunterladen" }).click();
  expect((await pdf).suggestedFilename()).toBe(`UStVA_${period}_Kennzahlen.pdf`);
});
