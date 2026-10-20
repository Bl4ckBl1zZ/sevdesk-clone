import type { Page } from "@playwright/test";
import { ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * P3 privacy flows as the signed-in owner (F12 §6): DSGVO request register (PRV-010), access export (PRV-013),
 * retention worklist / Betriebsprüfung-Modus (PRV-003/004). Nothing is purged here — in a fresh journey no retention
 * period has ended, so the purge button stays disabled (GOBD-21). axe on every state.
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-privacy.json`;
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

test("PRV-010 a DSGVO request without contact is registered with its one-month deadline", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/einstellungen/datenschutz?tab=anfragen");
  await expect(h1(page, "Datenschutz")).toBeVisible();
  await page.getByRole("button", { name: "Anfrage erfassen" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Art der Anfrage").selectOption("access");
  await dialog.getByLabel("Name der Person").fill("E2E Interessent");
  await expectNoAxeViolations();
  await dialog.getByRole("button", { name: "Speichern" }).click();
  const item = page.getByRole("list", { name: "Datenschutzanfragen" }).getByRole("listitem").filter({
    hasText: "E2E Interessent",
  });
  await expect(item.first()).toContainText("Auskunft (Art. 15)");
  await expect(item.first()).toContainText("Frist");
  await item.first().getByRole("button", { name: "Identität bestätigen" }).click();
  await page.getByRole("dialog").getByLabel("Prüfweg").fill("Rückruf");
  await page.getByRole("dialog").getByRole("button", { name: "Identität bestätigen" }).click();
  await expect(item.first()).toContainText("Identität bestätigt (Rückruf)");
  await expectNoAxeViolations();
});

test("PRV-003 PRV-004 the retention tab shows the worklist; the purge is disabled while nothing is due", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/einstellungen/datenschutz?tab=aufbewahrung");
  await expect(page.getByRole("heading", { name: "Löschvorschläge" })).toBeVisible();
  await expect(page.getByText("Derzeit sind keine Aufbewahrungsfristen abgelaufen.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Löschlauf starten" })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Löschläufe" })).toBeVisible();
  await expectNoAxeViolations();
});

test("CON-164 the contact page links to a DSGVO request for that contact", async ({ page, expectNoAxeViolations }) => {
  await page.goto("/kontakte");
  const first = page
    .getByRole("link", { name: /Muster Handwerk GmbH/ })
    .filter({ visible: true })
    .first();
  test.skip((await first.count()) === 0, "no contact in this journey");
  await first.click();
  await page.getByRole("link", { name: "DSGVO-Anfrage" }).click();
  await expect(page).toHaveURL(/tab=anfragen&contact=/);
  await expect(page.getByRole("dialog")).toContainText("Anfrage zu diesem Kontakt erfassen.");
  await expectNoAxeViolations();
});
