import type { Locator, Page } from "@playwright/test";
import { ownerStorageState, recordTestPayment } from "./backend";
import { expect, test } from "./fixtures";

/**
 * Storno, Rechnungskorrektur, Rechnungsberichtigung and the advance → final chain (F04 P1, §4.7/§4.8, §6.3/§6.4)
 * as the signed-in owner. Needs the backend and runs after e2e/journey.spec.ts and e2e/kontakte-produkte.spec.ts in
 * the same project (single worker, files in order) and before e2e/rechnungen.spec.ts. It uses its own contact
 * „Korrektur Bau KG“ so the address change of the Berichtigung does not touch the other journeys. Payments come
 * from the IS_TEST-only stand-in for the payments slice (e2e/backend.ts `recordTestPayment`).
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-corrections.json`;
const CUSTOMER = "Korrektur Bau KG";
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

const h1 = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name });
const visible = (l: Locator) => l.filter({ visible: true }).first();
const cents = (n: number) => Math.round(n * 100);

async function selectByText(select: Locator, text: string): Promise<void> {
  const option = select.locator("option", { hasText: text }).first();
  await expect(option).toBeAttached({ timeout: 20_000 });
  await select.selectOption((await option.getAttribute("value")) ?? "");
}

/** Today in Berlin as YYYY-MM-DD (the order date of the chain must not lie after the advance). */
const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date());

/** New draft for „Korrektur Bau KG“ with one manual line; `advance` switches the Belegart and sets the order. */
async function newDraft(page: Page, line: { name: string; price: string }, advance?: { order: string }) {
  await page.goto("/rechnungen/neu");
  await expect(h1(page, "Neue Rechnung")).toBeVisible();
  await selectByText(page.getByRole("combobox", { name: "Kunde", exact: true }), CUSTOMER);
  await expect(page.getByTestId("buyer")).toContainText(CUSTOMER);
  if (advance) {
    await page.getByRole("combobox", { name: "Belegart" }).selectOption("advance_invoice");
    await page.getByLabel("Auftrag / Bestellnummer").fill(advance.order);
    await page.getByLabel("Auftragsdatum").fill(today());
    await expect(page.getByLabel("Voraussichtlicher Leistungszeitpunkt")).toBeVisible();
  }
  await page.getByLabel("Bezeichnung (Pos. 1)").fill(line.name);
  await page.getByLabel("Menge").first().fill("1");
  await page.getByLabel("Einzelpreis").first().fill(line.price);
  await page.getByRole("button", { name: "Entwurf speichern" }).click();
  await expect(page).toHaveURL(/\/rechnungen\/[a-z0-9]+$/, { timeout: 30_000 });
}

/** Finalises the open draft and waits for the archived artifacts; returns the number from the title. */
async function finalizeDraft(page: Page, title: string): Promise<string> {
  await expect(page.getByTestId("compliance").getByRole("status")).toHaveText(/Bereit zum Fertigstellen/, {
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Fertigstellen" }).click();
  const dialog = page.getByRole("dialog", { name: `${title} fertigstellen?` });
  await expect(dialog.getByRole("button", { name: "Jetzt fertigstellen" })).toBeEnabled({ timeout: 20_000 });
  await dialog.getByRole("button", { name: "Jetzt fertigstellen" }).click();
  const heading = h1(page, new RegExp(`^${title} \\S+$`));
  await expect(heading).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Exportieren" })).toBeEnabled({ timeout: 90_000 });
  return ((await heading.textContent()) ?? "").replace(`${title} `, "").trim();
}

/** „Weitere Aktionen“ menu of a finalised document. */
async function action(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Weitere Aktionen" }).click();
  await page.getByRole("menuitem", { name }).click();
}

test("SET-050 setup: invoice account and the customer „Korrektur Bau KG“", async ({ page }) => {
  await page.goto("/einstellungen/bank");
  await expect(h1(page, /Bank/)).toBeVisible();
  const account = page.getByText("DE89 3704 0044 0532 0130 00").or(page.getByText("DE89370400440532013000"));
  if ((await account.count()) === 0) {
    await page.getByRole("button", { name: "Konto hinzufügen" }).click();
    const dialog = page.getByRole("dialog", { name: "Rechnungskonto hinzufügen" });
    await dialog.getByLabel("Bezeichnung").fill("Revolut Business");
    await dialog.getByLabel("IBAN").fill("DE89 3704 0044 0532 0130 00");
    await dialog.getByLabel("Kontoinhaber").fill("Erika Musterfrau");
    await dialog.getByRole("button", { name: "Konto hinzufügen" }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
  }
  await expect(account.first()).toBeVisible({ timeout: 20_000 });

  await page.goto("/kontakte/neu");
  await expect(h1(page, "Neuer Kontakt")).toBeVisible();
  await page.getByLabel("Firma", { exact: false }).first().fill(CUSTOMER);
  await page.getByLabel("Straße und Hausnummer").fill("Baustraße 5");
  await page.getByLabel("PLZ").fill("10117");
  await page.getByLabel("Ort", { exact: true }).fill("Berlin");
  await page.getByLabel("E-Mail", { exact: true }).fill("buchhaltung@korrektur-bau.de");
  await page.getByRole("button", { name: "Kontakt anlegen" }).click();
  await expect(h1(page, CUSTOMER)).toBeVisible({ timeout: 20_000 });
});

test("INV-10 Storno of an unpaid invoice: assistant → mirror preview → Stornorechnung", async ({
  page,
  expectNoAxeViolations,
}) => {
  await newDraft(page, { name: "Fliesenarbeiten Bad", price: "500,00" });
  const number = await finalizeDraft(page, "Rechnung");

  await action(page, "Korrigieren …");
  const assistant = page.getByRole("dialog", { name: `Rechnung ${number} korrigieren` });
  await expect(assistant).toBeVisible();
  await expectNoAxeViolations();
  await assistant.getByRole("radio", { name: /^Storno – Rechnung vollständig aufheben/ }).check();
  await assistant.getByRole("button", { name: "Weiter zum Storno" }).click();

  const storno = page.getByRole("dialog", { name: `Rechnung ${number} stornieren?` });
  await expect(storno.getByTestId("storno-gross")).toHaveText(/-595,00\s€/, { timeout: 20_000 });
  await expect(storno.getByTestId("storno-blocked")).toHaveCount(0);
  await expectNoAxeViolations();
  await storno.getByLabel(/^Grund/).fill("Doppelt erstellt");
  await storno.getByRole("button", { name: "Stornorechnung erstellen" }).click();

  await expect(h1(page, /^Stornorechnung \S+$/)).toBeVisible({ timeout: 60_000 });
  const relations = page.getByTestId("relations");
  await expect(relations).toContainText(`Bezieht sich auf Rechnung ${number}`);
  await expect(visible(page.getByText("Doppelt erstellt"))).toBeVisible();
  await expect(page.getByRole("button", { name: "Exportieren" })).toBeEnabled({ timeout: 90_000 });
  await expectNoAxeViolations();

  await relations.getByRole("link", { name: number }).click();
  await expect(h1(page, `Rechnung ${number}`)).toBeVisible();
  await expect(page.getByTestId("relations")).toContainText("Storniert durch");
});

test("INV-11 INV-12 a paid invoice cannot be cancelled; the Rechnungskorrektur credits the price reduction", async ({
  page,
  expectNoAxeViolations,
}) => {
  await newDraft(page, { name: "Dachrinne erneuern", price: "1.000,00" });
  const number = await finalizeDraft(page, "Rechnung");
  await recordTestPayment(number, cents(1190));
  await page.reload();
  await expect(h1(page, `Rechnung ${number}`)).toBeVisible();

  await action(page, "Korrigieren …");
  const assistant = page.getByRole("dialog", { name: `Rechnung ${number} korrigieren` });
  await assistant.getByRole("radio", { name: /^Storno – Rechnung vollständig aufheben/ }).check();
  await expect(assistant.getByRole("alert")).toContainText("Rechnungskorrektur", { timeout: 20_000 });
  await expect(assistant.getByRole("button", { name: "Weiter zum Storno" })).toBeDisabled();

  await assistant.getByRole("radio", { name: /^Rechnungskorrektur – Betrag mindern/ }).check();
  await assistant.getByLabel("Neuer Einzelpreis Pos. 1").fill("800,00");
  await expectNoAxeViolations();
  await assistant.getByRole("button", { name: "Entwurf anlegen" }).click();

  await expect(h1(page, "Entwurf Rechnungskorrektur")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("draft-banner")).toContainText("Rechnungskorrektur");
  await expect(page.getByTestId("gross")).toHaveText(/-238,00\s€/, { timeout: 20_000 });
  await expectNoAxeViolations();
  await finalizeDraft(page, "Rechnungskorrektur");
  await expect(page.getByTestId("relations")).toContainText(`Bezieht sich auf Rechnung ${number}`);
  await expectNoAxeViolations();
});

test("INV-13 Rechnungsberichtigung of the address: same amounts, corrected buyer address", async ({
  page,
  expectNoAxeViolations,
}) => {
  await newDraft(page, { name: "Malerarbeiten Treppenhaus", price: "300,00" });
  const number = await finalizeDraft(page, "Rechnung");
  const invoiceUrl = page.url();

  // The customer moved before the invoice was issued: correct the address at the contact first.
  await page.goto("/kontakte");
  await visible(page.getByRole("link", { name: CUSTOMER })).click();
  await expect(h1(page, CUSTOMER)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("tab", { name: "Adressen & Kommunikation" }).click();
  await page.getByRole("region", { name: "Adressen" }).getByRole("button", { name: "Bearbeiten" }).first().click();
  const edit = page.getByRole("dialog", { name: "Adresse bearbeiten" });
  await edit.getByLabel("Straße und Hausnummer").fill("Neue Allee 7");
  await edit.getByRole("button", { name: "Speichern" }).click();
  await expect(edit).toBeHidden({ timeout: 20_000 });
  await expect(page.getByText("Neue Allee 7").first()).toBeVisible();

  await page.goto(invoiceUrl);
  await expect(h1(page, `Rechnung ${number}`)).toBeVisible();
  await action(page, "Korrigieren …");
  const assistant = page.getByRole("dialog", { name: `Rechnung ${number} korrigieren` });
  await expect(assistant.getByRole("radio", { name: /^Rechnungsberichtigung/ })).toBeChecked();
  await assistant.getByRole("button", { name: "Entwurf anlegen" }).click();

  await expect(h1(page, "Entwurf Rechnungsberichtigung")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("buyer")).toContainText("Neue Allee 7", { timeout: 20_000 });
  await expect(page.getByTestId("gross")).toHaveText("357,00 €", { timeout: 20_000 });
  await expectNoAxeViolations();
  await finalizeDraft(page, "Rechnungsberichtigung");
  const relations = page.getByTestId("relations");
  await expect(relations).toContainText(`Bezieht sich auf Rechnung ${number}`);
  await expect(relations).toContainText("Berichtigt: Anschrift des Leistungsempfängers");
});

test("INV-03 INV-06 INV-09 a paid advance is deducted in the final invoice", async ({
  page,
  expectNoAxeViolations,
}) => {
  await newDraft(page, { name: "Abschlag 30 % Heizungsbau", price: "3.000,00" }, { order: "B-E2E-1" });
  await expect(h1(page, "Entwurf Abschlagsrechnung")).toBeVisible();
  await expect(page.getByTestId("draft-banner")).toContainText("Mindest-Ist");
  const advance = await finalizeDraft(page, "Abschlagsrechnung");
  await recordTestPayment(advance, cents(3570));
  await page.reload();
  await expect(h1(page, `Abschlagsrechnung ${advance}`)).toBeVisible();

  await action(page, "Schlussrechnung erstellen");
  const wizard = page.getByRole("dialog", { name: "Schlussrechnung zu Auftrag B-E2E-1" });
  await expect(wizard.getByTestId(`advance-${advance}`)).toContainText("Bezahlt – wird abgezogen", {
    timeout: 20_000,
  });
  await expect(wizard.getByTestId("advance-not-settled")).toHaveCount(0);
  await expectNoAxeViolations();
  await wizard.getByRole("button", { name: "Schlussrechnung anlegen" }).click();

  await expect(h1(page, "Entwurf Schlussrechnung")).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Bezeichnung (Pos. 1)").fill("Heizungsbau komplett");
  await page.getByLabel("Einzelpreis").first().fill("10.000,00");
  await page.getByRole("button", { name: "Entwurf speichern" }).click();
  await expect(page.getByTestId("gross")).toHaveText("11.900,00 €", { timeout: 20_000 });
  const final = await finalizeDraft(page, "Schlussrechnung");
  expect(final).not.toBe(advance);
  await expect(page.getByTestId("deductions")).toContainText(advance);
  await expect(visible(page.getByText(/8\.330,00\s€/))).toBeVisible();
  await expectNoAxeViolations();
});

test("EC-071 a partly paid advance blocks the final invoice until it is reduced to the amount received", async ({
  page,
  expectNoAxeViolations,
}) => {
  await newDraft(page, { name: "Abschlag Dachstuhl", price: "2.000,00" }, { order: "B-E2E-2" });
  const advance = await finalizeDraft(page, "Abschlagsrechnung");
  await recordTestPayment(advance, cents(1000));
  await page.reload();
  await expect(h1(page, `Abschlagsrechnung ${advance}`)).toBeVisible();

  await action(page, "Schlussrechnung erstellen");
  const wizard = page.getByRole("dialog", { name: "Schlussrechnung zu Auftrag B-E2E-2" });
  const row = wizard.getByTestId(`advance-${advance}`);
  await expect(row).toContainText("Teilweise bezahlt", { timeout: 20_000 });
  await expect(wizard.getByTestId("advance-not-settled")).toContainText("Nicht abziehen");
  await expect(wizard.getByRole("button", { name: "Schlussrechnung anlegen" })).toBeDisabled();
  await expectNoAxeViolations();

  // EC-071: Rechnungskorrektur of the advance down to the 1.000,00 € received (finalised in one step).
  await row.getByRole("button", { name: /^Auf 1\.000,00\s€ mindern$/ }).click();
  await expect(row).toContainText("Bezahlt – wird abgezogen", { timeout: 60_000 });
  await expect(wizard.getByTestId("advance-not-settled")).toHaveCount(0);
  await wizard.getByRole("button", { name: "Schlussrechnung anlegen" }).click();

  await expect(h1(page, "Entwurf Schlussrechnung")).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Bezeichnung (Pos. 1)").fill("Dachstuhl komplett");
  await page.getByLabel("Einzelpreis").first().fill("5.000,00");
  await page.getByRole("button", { name: "Entwurf speichern" }).click();
  await expect(page.getByTestId("gross")).toHaveText("5.950,00 €", { timeout: 20_000 });
  await finalizeDraft(page, "Schlussrechnung");
  await expect(page.getByTestId("deductions")).toContainText(advance);
  await expect(visible(page.getByText(/4\.950,00\s€/))).toBeVisible();
  await expectNoAxeViolations();
});
