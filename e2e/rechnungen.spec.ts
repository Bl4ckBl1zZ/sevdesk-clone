import type { Locator, Page } from "@playwright/test";
import { ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * Rechnungen (F04 P1 invoices core) as the signed-in owner: contact + product → draft → finalise → export → mark as
 * sent → listed as open; variants Kleinbetrag, § 13b and Kleinunternehmer. Needs the backend and runs after
 * e2e/journey.spec.ts and e2e/kontakte-produkte.spec.ts in the same project (single worker, files in order), which
 * created the owner (setup complete), the contact „Muster Handwerk GmbH“ and the product „Wartung Heizung“.
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-invoices.json`;
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
/** The customer select (the surrounding region is labelled „Kunde“ as well). */
const customerSelect = (page: Page) => page.getByRole("combobox", { name: "Kunde", exact: true });

async function selectByText(select: Locator, text: string): Promise<void> {
  const option = select.locator("option", { hasText: text }).first();
  await expect(option).toBeAttached({ timeout: 20_000 });
  await select.selectOption((await option.getAttribute("value")) ?? "");
}

/** New invoice for „Muster Handwerk GmbH“ with the given manual line. */
async function draftWithLine(page: Page, line: { name: string; price: string; type?: "good" | "service" }) {
  await page.goto("/rechnungen/neu");
  await expect(h1(page, "Neue Rechnung")).toBeVisible();
  await selectByText(customerSelect(page), "Muster Handwerk GmbH");
  await expect(page.getByTestId("buyer")).toContainText("Muster Handwerk GmbH");
  await page.getByLabel("Bezeichnung (Pos. 1)").fill(line.name);
  await page.getByLabel("Menge").first().fill("1");
  await page.getByLabel("Einzelpreis").first().fill(line.price);
  if (line.type) await page.getByLabel("Art").first().selectOption(line.type);
}

async function saveAndFinalize(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Entwurf speichern" }).click();
  await expect(page).toHaveURL(/\/rechnungen\/[a-z0-9]+$/, { timeout: 30_000 });
  await expect(h1(page, "Rechnungsentwurf")).toBeVisible();
  await expect(page.getByTestId("compliance").getByRole("status")).toHaveText(/Bereit zum Fertigstellen/, {
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Fertigstellen" }).click();
  const dialog = page.getByRole("dialog", { name: "Rechnung fertigstellen?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Jetzt fertigstellen" }).click();
  await expect(h1(page, /^Rechnung \S+$/)).toBeVisible({ timeout: 60_000 });
  // Step 3 of the pipeline renders the PDF/A-3b in the background; export unlocks when it is archived.
  await expect(page.getByRole("button", { name: "Exportieren" })).toBeEnabled({ timeout: 90_000 });
  return ((await h1(page, /^Rechnung /).textContent()) ?? "").replace("Rechnung ", "").trim();
}

test("SET-050 an invoice account exists for the transfer details", async ({ page }) => {
  await page.goto("/einstellungen/bank");
  await expect(h1(page, /Bank/)).toBeVisible();
  const list = page.getByText("DE89 3704 0044 0532 0130 00").or(page.getByText("DE89370400440532013000"));
  if ((await list.count()) === 0) {
    await page.getByRole("button", { name: "Konto hinzufügen" }).click();
    const dialog = page.getByRole("dialog", { name: "Rechnungskonto hinzufügen" });
    await dialog.getByLabel("Bezeichnung").fill("Revolut Business");
    await dialog.getByLabel("IBAN").fill("DE89 3704 0044 0532 0130 00");
    await dialog.getByLabel("Kontoinhaber").fill("Erika Musterfrau");
    await dialog.getByRole("button", { name: "Konto hinzufügen" }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
  }
  await expect(list.first()).toBeVisible({ timeout: 20_000 });
});

test("DOC-24 DOC-37 SND-16 MAIL-02 contact + product → draft → finalise → export → mark as sent → listed as open", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/rechnungen");
  await expect(h1(page, "Rechnungen")).toBeVisible();
  await expectNoAxeViolations();

  await page.goto("/rechnungen/neu");
  await expect(h1(page, "Neue Rechnung")).toBeVisible();
  await selectByText(customerSelect(page), "Muster Handwerk GmbH");
  await expect(page.getByTestId("buyer")).toContainText("Hauptstraße 1");
  await selectByText(page.getByLabel("Produkt hinzufügen"), "Wartung Heizung");
  await expect(page.getByLabel("Bezeichnung (Pos. 1)")).toHaveValue("Wartung Heizung", { timeout: 20_000 });
  await expect(page.getByTestId("gross")).toHaveText(/\d+,\d{2} €/, { timeout: 20_000 });
  await expectNoAxeViolations();

  const number = await saveAndFinalize(page);
  await expect(page.getByText("Festgeschrieben")).toBeVisible();
  await expect(page.getByTestId("artifacts")).toContainText("ZUGFeRD-PDF");
  await expectNoAxeViolations();

  // Export: „Alles als ZIP“ downloads the archived PDF + XML with SHA256SUMS.txt.
  await page.getByRole("button", { name: "Exportieren" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Alles als ZIP" }).click();
  expect((await download).suggestedFilename()).toBe(`${number.replaceAll("/", "-")}.zip`);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Als versendet markieren" }).click();
  const mark = page.getByRole("dialog", { name: "Als versendet markieren" });
  await expect(mark.getByLabel("Versandweg")).toHaveValue("email_manual");
  await expectNoAxeViolations();
  await mark.getByLabel("Hinweis").fill("an rechnung@muster-handwerk.de");
  await mark.getByRole("button", { name: "Markieren" }).click();
  await expect(mark).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId("send-log")).toContainText("Versendet am");

  await page.goto("/rechnungen?status=open");
  const row = page.getByRole("link", { name: number }).filter({ visible: true }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-status=open]").filter({ visible: true }).first()).toHaveText("Offen");
  await expectNoAxeViolations();
});

test("UST-14 Kleinbetragsrechnung: a small invoice with the Kleinbetrag flag is finalised", async ({ page }) => {
  await draftWithLine(page, { name: "Ersatzteil Thermostat", price: "100,00", type: "good" });
  await page.getByLabel("Kleinbetragsrechnung (bis 250 € brutto)").check();
  await expect(page.getByTestId("gross")).toHaveText("119,00 €", { timeout: 20_000 });
  await saveAndFinalize(page);
  await expect(page.getByText("Ersatzteil Thermostat")).toBeVisible();
});

test("UST-22 § 13b: construction work for a business customer shifts the VAT liability", async ({
  page,
  expectNoAxeViolations,
}) => {
  // BR-AE-02: the E-Rechnung with reverse charge needs the buyer's USt-IdNr (or register number).
  await page.goto("/kontakte");
  await page.getByRole("link", { name: "Muster Handwerk GmbH" }).filter({ visible: true }).first().click();
  await expect(h1(page, "Muster Handwerk GmbH")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("tab", { name: "Stammdaten" }).click();
  await page.getByLabel("USt-IdNr", { exact: true }).fill("DE811907980");
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert.").first()).toBeVisible({ timeout: 20_000 });

  await draftWithLine(page, { name: "Estricharbeiten Erdgeschoss", price: "1.000,00" });
  await page.getByLabel("§ 13b UStG").first().selectOption("construction");
  await page.getByLabel("Bauleistung", { exact: true }).check();
  await expect(page.getByTestId("totals")).toContainText("Steuerschuldnerschaft des Leistungsempfängers", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("gross")).toHaveText("1.000,00 €");
  await expectNoAxeViolations();
  await saveAndFinalize(page);
  await expect(page.getByText(/Steuerschuldnerschaft des Leistungsempfängers/).first()).toBeVisible();
});

test("KU-02 Kleinunternehmer: the invoice shows no VAT and the § 19 note", async ({ page }) => {
  await page.goto("/einstellungen/steuern");
  await page.getByRole("radio", { name: "Ja, Kleinunternehmer" }).check();
  await page.getByLabel(/Kleinunternehmer seit/).fill("2026-01-01");
  await page.getByLabel(/Gesamtumsatz/).fill("18.000,00");
  await page.getByRole("button", { name: "Speichern" }).first().click();
  await expect(page.getByText(/Gespeichert/).first()).toBeVisible({ timeout: 20_000 });

  await draftWithLine(page, { name: "Beratung Kleinunternehmer", price: "50,00" });
  await expect(page.getByTestId("gross")).toHaveText("50,00 €", { timeout: 20_000 });
  await saveAndFinalize(page);
  await expect(page.getByText(/§ 19/).first()).toBeVisible();
});
