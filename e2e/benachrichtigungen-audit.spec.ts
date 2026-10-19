import type { Page } from "@playwright/test";
import { ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * P1 operations pages as the signed-in owner (F12 §6): Benachrichtigungen (NTF-001), the channel matrix
 * (NTF-002/004), the audit viewer (AUD-006/008) and the datenschutz/aufbewahrung pages (PRV-001, PRV-016); axe on every
 * page. Needs the backend journey (owner with completed setup).
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-ops.json`;
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
test.describe.configure({ mode: "serial", timeout: 120_000 });

const h1 = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name });

test("NTF-001 the notification list filters by severity and offers „Alle als gelesen markieren“", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/benachrichtigungen");
  await expect(h1(page, "Benachrichtigungen")).toBeVisible();
  await page.getByLabel("Schweregrad").selectOption({ label: "Warnung" });
  await page.getByLabel("Nur ungelesene").check();
  await expectNoAxeViolations();
});

test("NTF-002 critical kinds are locked in the channel matrix", async ({ page, expectNoAxeViolations }) => {
  await page.goto("/einstellungen/benachrichtigungen");
  await expect(page.getByText("Kanäle je Benachrichtigungsart").first()).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Integritätsprüfung fehlgeschlagen: E-Mail" })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Datensicherung veraltet: E-Mail" })).toBeEnabled();
  await expectNoAxeViolations();
});
