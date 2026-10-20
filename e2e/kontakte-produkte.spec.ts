import type { Page } from "@playwright/test";
import { ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * Kontakte (F02) and Produkte (F03) as the signed-in owner: create, detail tabs, timeline, list search, product with
 * the gross price, customer price, categories. Needs the backend and runs after e2e/00-journey.spec.ts in the same
 * project (single worker, files in order), which created the owner, the number ranges and completed the setup.
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-catalog.json`;
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

test("CON-001 CON-003 CON-120 PAY-004 an organisation is created with address and e-mail and gets a timeline note", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/kontakte");
  await expect(h1(page, "Kontakte")).toBeVisible();
  await expect(page.getByText("Noch keine Kontakte vorhanden.")).toBeVisible();
  await expectNoAxeViolations();

  await page.goto("/kontakte/neu");
  await expect(h1(page, "Neuer Kontakt")).toBeVisible();
  await expect(page.getByText(/Leer lassen: wird automatisch vergeben \(\d+\)\./)).toBeVisible();
  await expectNoAxeViolations();
  await page.getByLabel("Firma", { exact: false }).first().fill("Muster Handwerk GmbH");
  await page.getByLabel("Straße und Hausnummer").fill("Hauptstraße 1");
  await page.getByLabel("PLZ").fill("10115");
  await page.getByLabel("Ort", { exact: true }).fill("Berlin");
  await page.getByLabel("E-Mail", { exact: true }).fill("rechnung@muster-handwerk.de");
  await page.getByRole("button", { name: "Kontakt anlegen" }).click();

  await expect(page).toHaveURL(/\/kontakte\/(?!neu$)[a-z0-9]+$/, { timeout: 20_000 });
  await expect(h1(page, "Muster Handwerk GmbH")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Verlauf" })).toHaveAttribute("aria-selected", "true");
  await expectNoAxeViolations();

  await page.getByLabel("Text", { exact: true }).fill("Erstgespräch: Angebot für Wartung gewünscht.");
  await page.getByRole("button", { name: "Hinzufügen" }).click();
  await expect(page.getByText("Erstgespräch: Angebot für Wartung gewünscht.")).toBeVisible();

  await page.getByRole("tab", { name: "Adressen & Kommunikation" }).click();
  await expect(page.getByText("Hauptstraße 1")).toBeVisible();
  await expect(page.getByRole("link", { name: "rechnung@muster-handwerk.de" }).first()).toBeVisible();
  await expectNoAxeViolations();

  await page.getByRole("tab", { name: "Steuer & E-Rechnung" }).click();
  await expect(page.getByRole("heading", { name: "Abgeleiteter Steuerfall" })).toBeVisible();
  await expect(page.getByText("Keine USt-IdNr hinterlegt.")).toBeVisible();
  await expectNoAxeViolations();

  // PAY-004: a customer has the „Offene Posten" tab (empty before the first invoice).
  await page.getByRole("tab", { name: "Offene Posten" }).click();
  await expect(page.getByRole("heading", { name: "Zahlungshistorie" })).toBeVisible();
  await expect(page.getByText("Keine offenen Posten.")).toBeVisible();
  await expect(page.getByText("Noch keine bezahlten Rechnungen")).toBeVisible();
  await expectNoAxeViolations();
});

test("CON-172 CON-173 the list finds the contact by search and keeps the filter in the URL", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/kontakte");
  await page.getByRole("searchbox", { name: "Kontakte durchsuchen" }).fill("Muster");
  await expect(page).toHaveURL(/q=Muster/);
  await expect(
    page
      .getByRole("link", { name: /Muster Handwerk GmbH/ })
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  await expectNoAxeViolations();
  await page.getByRole("link", { name: "Kunden", exact: true }).click();
  await expect(page).toHaveURL(/status=customer/);
  await expect(
    page
      .getByRole("link", { name: /Muster Handwerk GmbH/ })
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
});

test("PRD-011 PRD-013 PRD-030 a product entered gross gets a customer price", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/produkte/neu");
  await expect(h1(page, "Neues Produkt")).toBeVisible();
  await expectNoAxeViolations();
  await page.getByLabel("Name", { exact: false }).first().fill("Wartung Heizung");
  await page.getByLabel("VK brutto").fill("119");
  await expect(page.getByLabel("VK netto")).toHaveValue("100,00");
  await page.getByRole("button", { name: "Produkt anlegen" }).click();

  await expect(page).toHaveURL(/\/produkte\/(?!neu$)[a-z0-9]+$/, { timeout: 20_000 });
  await expect(h1(page, "Wartung Heizung")).toBeVisible();
  await expectNoAxeViolations();

  await page.getByRole("tab", { name: "Preise" }).click();
  await page.getByRole("button", { name: "Kundenpreis hinzufügen" }).click();
  const dialog = page.getByRole("dialog", { name: "Kundenpreis hinzufügen" });
  await dialog.getByLabel("Kontakt suchen").fill("Muster");
  const select = dialog.getByLabel("Kunde", { exact: false });
  await expect(select.locator("option", { hasText: "Muster Handwerk GmbH" })).toHaveCount(1);
  await select.selectOption({ label: (await select.locator("option", { hasText: "Muster" }).textContent()) ?? "" });
  await dialog.getByRole("textbox", { name: "Preis" }).fill("90");
  await expectNoAxeViolations();
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("cell", { name: "90,00 €" })).toBeVisible();

  await page.goto("/produkte");
  await expect(page.getByRole("link", { name: "Wartung Heizung" }).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText("119,00 €").filter({ visible: true }).first()).toBeVisible();
  await expectNoAxeViolations();
});

test("PRD-060 categories are listed with their product counts", async ({ page, expectNoAxeViolations }) => {
  await page.goto("/produkte/kategorien");
  await expect(h1(page, "Produktkategorien")).toBeVisible();
  await expect(page.getByText("Dienstleistungen", { exact: true })).toBeVisible();
  await expectNoAxeViolations();
});
