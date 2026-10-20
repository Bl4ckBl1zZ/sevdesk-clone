import type { Page } from "@playwright/test";
import { ownerStorageState } from "./backend";
import { expect, selectCustomer, test } from "./fixtures";

/**
 * Kleinunternehmer invoice (KU-02) as the signed-in owner. This file must sort **last** in its project: once a KU
 * invoice is finalised, the KU entry it was issued under is immutable (F01 SET-034, src/domain/tax/ku-history.ts
 * HISTORY_ENTRY_LOCKED) — switching the current year back to Regelbesteuerung is blocked by design, so every spec
 * that expects 19 % VAT must run before this one. Needs the contact „Muster Handwerk GmbH“ (kontakte-produkte).
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-ku.json`;
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
// Finalising waits up to 60 s for the number and 90 s for the archived PDF.
test.describe.configure({ mode: "serial", timeout: 180_000 });

const h1 = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name });

test("KU-02 Kleinunternehmer: the invoice shows no VAT and the § 19 note", async ({ page }) => {
  const year = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin", year: "numeric" }).format(new Date());
  await page.goto("/einstellungen/steuern");
  await page.getByRole("radio", { name: "Ja, Kleinunternehmer" }).check();
  await page.getByLabel(/Kleinunternehmer seit/).fill(`${year}-01-01`);
  await page.getByLabel(/Gesamtumsatz/).fill("18.000,00");
  // The earlier specs finalised invoices this year: a retroactive KU entry touches them, so the KU history
  // (SET-034, REASON_REQUIRED) asks for a reason.
  await page.getByLabel("Begründung für die Änderung").fill("E2E: Wechsel zur Kleinunternehmerregelung");
  await page.getByRole("button", { name: "Speichern" }).first().click();
  await expect(page.getByText(/Gespeichert/).first()).toBeVisible({ timeout: 20_000 });

  await page.goto("/rechnungen/neu");
  await expect(h1(page, "Neue Rechnung")).toBeVisible();
  await selectCustomer(page, "Muster Handwerk GmbH");
  await expect(page.getByTestId("buyer")).toContainText("Muster Handwerk GmbH");
  await page.getByLabel("Bezeichnung (Pos. 1)").fill("Beratung Kleinunternehmer");
  await page.getByLabel("Menge").first().fill("1");
  await page.getByLabel("Einzelpreis").first().fill("50,00");
  await expect(page.getByTestId("gross")).toHaveText("50,00 €", { timeout: 20_000 });

  await page.getByRole("button", { name: "Entwurf speichern" }).click();
  await expect(page).toHaveURL(/\/rechnungen\/(?!neu$)[a-z0-9]+$/, { timeout: 30_000 });
  await expect(page.getByTestId("compliance").getByRole("status")).toHaveText(/Bereit zum Fertigstellen/, {
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Fertigstellen" }).click();
  const dialog = page.getByRole("dialog", { name: "Rechnung fertigstellen?" });
  await dialog.getByRole("button", { name: "Jetzt fertigstellen" }).click();
  await expect(h1(page, /^Rechnung \S+$/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Exportieren" })).toBeEnabled({ timeout: 90_000 });
  await expect(page.getByText(/§ 19/).filter({ visible: true }).first()).toBeVisible();
});
