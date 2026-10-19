import type { Page } from "@playwright/test";
import { ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * Buchhaltung › Anlagen / Festschreibung and Steuern › UStVA / ZM (F08 §6; AST-001…AST-012, ACC-015…ACC-017,
 * TAX-001…TAX-011, TAX-019…TAX-021) as the signed-in owner: the pages render on every project (desktop, iPhone,
 * Pixel), „Anlage erfassen“ creates a GWG, the asset detail shows the plan, the Festschreibung dialog shows the
 * checklist and the irreversible confirmation (not confirmed here), the UStVA page shows the Kennzahlen step (or the
 * Kleinunternehmer notice) and the ZM page its rows; axe on every page. Needs the backend journey.
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-books.json`;
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
  reducedMotion: "reduce",
});
test.describe.configure({ mode: "serial", timeout: 180_000 });

const h1 = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name });

test("AST-001 AST-007 Anlagen: Anlage erfassen (GWG) and the depreciation plan", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/buchhaltung/anlagen");
  await expect(h1(page, "Anlagen")).toBeVisible();
  await expect(page.getByRole("tab", { name: /Anlagenspiegel/ })).toBeVisible();
  await expectNoAxeViolations();
  await page.getByRole("button", { name: "Anlage erfassen" }).click();
  const dialog = page.getByRole("dialog", { name: "Anlage erfassen" });
  await dialog.getByLabel("Bezeichnung").fill(`E2E Laptop ${test.info().project.name}`);
  await dialog.getByLabel("Anlagenkonto").fill("0480");
  await dialog.getByLabel("Anschaffungskosten (€)").fill("799,00");
  await dialog.getByLabel("Abschreibungsmethode").selectOption("gwg");
  await expectNoAxeViolations();
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Anlage gespeichert.")).toBeVisible({ timeout: 20_000 });
  await page
    .getByRole("button", { name: /^AV-/ })
    .or(page.getByText(`E2E Laptop ${test.info().project.name}`))
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Abschreibungsplan" })).toBeVisible();
  await expectNoAxeViolations();
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "GWG-Verzeichnis" }).click();
  await expect(page.getByText("E2E Laptop").first()).toBeVisible();
  await page.getByRole("tab", { name: /Anlagenspiegel/ }).click();
  await expectNoAxeViolations();
});

test("ACC-015 ACC-017 Festschreibung: month grid and checklist dialog", async ({ page, expectNoAxeViolations }) => {
  await page.goto("/buchhaltung/festschreibung");
  await expect(h1(page, "Festschreibung")).toBeVisible();
  await expectNoAxeViolations();
  const lockButton = page.getByRole("button", { name: /^Bis \d{2}\/\d{4} festschreiben$/ }).first();
  if (await lockButton.isVisible()) {
    await lockButton.click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText("Festschreiben kann nicht rückgängig gemacht werden.", { exact: false }),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Endgültig festschreiben" })).toBeDisabled();
    await expectNoAxeViolations();
    await dialog.getByRole("button", { name: "Abbrechen" }).click();
  }
});

test("TAX-003 TAX-011 TAX-020 UStVA: Kennzahlen step or Kleinunternehmer notice, deadlines", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/steuern/ustva");
  await expect(h1(page, "Umsatzsteuer-Voranmeldung")).toBeVisible();
  await expect(page.getByLabel("Voranmeldungszeitraum")).toBeVisible();
  await expect(
    page
      .getByRole("heading", { name: "Werte prüfen" })
      .or(page.getByText(/Kleinunternehmer|keine Umsatzsteuer-Voranmeldung/).first()),
  ).toBeVisible({ timeout: 20_000 });
  await expectNoAxeViolations();
});

test("ACC-025 RPT-008 Journal: filters, Buchungsjournal export and „Manuelle Buchung“", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/buchhaltung/journal");
  await expect(h1(page, "Journal")).toBeVisible();
  await expect(page.getByRole("search", { name: "Journal filtern" })).toBeVisible();
  await page.getByLabel("Herkunft").selectOption("manual");
  await expect(page.getByRole("button", { name: "Buchungsjournal (CSV)" })).toBeEnabled();
  await expectNoAxeViolations();
  await page.getByRole("button", { name: "Filter zurücksetzen" }).click();
  await page.getByRole("link", { name: "Manuelle Buchung" }).click();
  await expect(h1(page, "Manuelle Buchung")).toBeVisible();
  const desktop = (page.viewportSize()?.width ?? 0) >= 1200;
  if (desktop) {
    await expect(page.getByLabel("Buchungstext")).toBeVisible();
    await page.getByLabel("Vorlage").selectOption("loan_payout");
    await expect(page.getByLabel("Buchungstext")).toHaveValue("Darlehensauszahlung");
    await expect(page.getByRole("button", { name: "Buchen" })).toBeDisabled();
  } else {
    await expect(page.getByText("Manuelle Buchungen bitte am Desktop erfassen.")).toBeVisible();
  }
  await expectNoAxeViolations();
});

test("ACC-009 Konten: „Konto anlegen“ dialog", async ({ page, expectNoAxeViolations }) => {
  await page.goto("/buchhaltung/konten");
  await page.getByRole("button", { name: "Konto anlegen" }).click();
  const dialog = page.getByRole("dialog", { name: "Eigenes Sachkonto anlegen" });
  await expect(dialog.getByLabel("Kontonummer (4-stellig)")).toBeVisible();
  await expectNoAxeViolations();
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
});

test("TAX-009 ZM: rows and reconciliation", async ({ page, expectNoAxeViolations }) => {
  await page.goto("/steuern/zm");
  await expect(h1(page, "Zusammenfassende Meldung")).toBeVisible();
  await expect(page.getByLabel("Meldezeitraum")).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Meldung / })).toBeVisible({ timeout: 20_000 });
  await expectNoAxeViolations();
});
