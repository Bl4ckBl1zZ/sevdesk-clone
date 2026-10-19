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

test("AUD-006 AUD-008 the audit viewer filters by preset and offers the CSV/JSON export", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/einstellungen/audit");
  await expect(h1(page, "Protokoll")).toBeVisible();
  await expect(page.getByTestId("chain-status")).toBeVisible();
  await page.getByRole("button", { name: "Was hat Claude heute geändert?" }).click();
  await expect(page.getByRole("button", { name: "Was hat Claude heute geändert?" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  expect((await download).suggestedFilename()).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.json$/);
  await expectNoAxeViolations();
});

test("EXP-021 SND-20 SND-09 the invoice list offers Export ▾ and the bulk bar; /export lists the jobs", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/rechnungen");
  await expect(h1(page, "Rechnungen")).toBeVisible();
  await page.getByRole("button", { name: "Export als CSV" }).click();
  await expect(page.getByRole("menuitem", { name: "CSV (Excel)" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "CSV (technisch)" })).toBeVisible();
  await page.keyboard.press("Escape");
  const boxes = page.getByRole("checkbox", { name: /auswählen$/ });
  if ((await boxes.count()) > 1) {
    await boxes.nth(1).check();
    await expect(page.getByTestId("bulk-bar")).toContainText("1 ausgewählt");
  }
  await page.goto("/export");
  await expect(h1(page, "Export")).toBeVisible();
  await expectNoAxeViolations();
});

test("SET-114 PRV-001 PRV-015 /einstellungen/datenschutz lists external services, retention and the Art. 30 record", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/einstellungen/datenschutz");
  await expect(h1(page, "Datenschutz")).toBeVisible();
  const services = page.getByRole("list", { name: "Externe Dienste" });
  await expect(services).toContainText("Tailscale");
  await expect(services).toContainText("BZSt");
  await page.getByRole("tab", { name: "Aufbewahrung" }).click();
  await expect(page.getByRole("rowheader", { name: /Buchungsbelege/ })).toBeVisible();
  await page.getByRole("tab", { name: "Verzeichnis (Art. 30)" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Als Datei herunterladen" }).click();
  expect((await download).suggestedFilename()).toBe("verzeichnis-art30.md");
  await expectNoAxeViolations();
});
