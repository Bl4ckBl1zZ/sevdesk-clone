import type { Page } from "@playwright/test";
import { ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * Posteingang (F06 P2, §6.1) as the signed-in owner: upload a PDF → item „Zu prüfen“ with a linked draft; an
 * XRechnung → readable view with the tabs Darstellung | Prüfbericht | XML | Anlagen; reject with reason; the
 * multi-page camera capture on phones (INB-003); Einstellungen › Posteingang and › Belegerkennung render with the
 * credential state and the AVV checkbox. Needs the backend journey (owner with completed setup).
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-posteingang.json`;
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
test.describe.configure({ mode: "serial", timeout: 240_000 });

const h1 = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name });

/** A tiny synthetic PDF; `seed` keeps the SHA-256 unique per run (identical files are duplicates, VOU-050). */
const pdf = (seed: string) =>
  Buffer.from(`%PDF-1.4\n1 0 obj <</Type /Page>> endobj\n% SYNTHETIC TEST DATA ${seed}\n%%EOF\n`, "utf8");

/** Minimal synthetic XRechnung (UBL); invoice number unique per run. */
const xrechnung = (no: string) =>
  Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>
  <cbc:ID>${no}</cbc:ID>
  <cbc:IssueDate>2026-10-01</cbc:IssueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>04011000-12345-34</cbc:BuyerReference>
  <cac:InvoicePeriod><cbc:StartDate>2026-09-01</cbc:StartDate><cbc:EndDate>2026-09-30</cbc:EndDate></cac:InvoicePeriod>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PostalAddress><cbc:StreetName>Musterweg 1</cbc:StreetName><cbc:CityName>Berlin</cbc:CityName><cbc:PostalZone>10115</cbc:PostalZone><cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
    <cac:PartyTaxScheme><cbc:CompanyID>DE123456789</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>E2E Lieferant GmbH</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    <cac:PostalAddress><cbc:CityName>Hamburg</cbc:CityName><cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
    <cac:PartyLegalEntity><cbc:RegistrationName>Kunde</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="EUR">19.00</cbc:TaxAmount>
    <cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">100.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">19.00</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="EUR">100.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">119.00</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">119.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
  <cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>Beratung</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">100.00</cbc:PriceAmount></cac:Price></cac:InvoiceLine>
</Invoice>`,
    "utf8",
  );

async function openInbox(page: Page) {
  await page.goto("/posteingang");
  await expect(h1(page, "Posteingang")).toBeVisible();
}

async function waitForReview(page: Page, title: string | RegExp) {
  const item = page.getByTestId("inbox-item");
  await expect(item.getByRole("heading", { level: 2, name: title })).toBeVisible({ timeout: 30_000 });
  await expect(item.locator('[data-status="needs_review"]')).toBeVisible({ timeout: 60_000 });
  return item;
}

test("INB-001 INB-020 INB-027 INB-028 upload → „Zu prüfen“ with a draft and the original's SHA-256", async ({
  page,
  expectNoAxeViolations,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "upload flow on desktop; phones use the camera capture");
  await openInbox(page);
  const seed = `${Date.now()}`;
  await page.getByTestId("inbox-file-input").setInputFiles({
    name: `beleg-${seed}.pdf`,
    mimeType: "application/pdf",
    buffer: pdf(seed),
  });
  await expect(page.getByText("1 Beleg hochgeladen")).toBeVisible({ timeout: 30_000 });
  const item = await waitForReview(page, `beleg-${seed}.pdf`);
  await expect(item.getByTestId("inbox-files")).toContainText("Original · SHA-256");
  await expectNoAxeViolations();
  await item.getByTestId("open-draft").click();
  await expect(h1(page, "Belegentwurf")).toBeVisible({ timeout: 30_000 });
});

test("INB-001 EC-INB-01 a non-accepted file is listed in the summary toast and not uploaded", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop only");
  await openInbox(page);
  await page.getByTestId("inbox-file-input").setInputFiles({
    name: "tool.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("MZ\u0090\u0000 not a pdf"),
  });
  await expect(page.getByText("1 Datei nicht übernommen")).toBeVisible({ timeout: 20_000 });
});

test("INB-021 INB-040 INB-024 an XRechnung shows Darstellung | Prüfbericht | XML | Anlagen", async ({
  page,
  expectNoAxeViolations,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop only");
  await openInbox(page);
  const no = `E2E-XR-${Date.now()}`;
  await page.getByTestId("inbox-file-input").setInputFiles({
    name: `${no}.xml`,
    mimeType: "application/xml",
    buffer: xrechnung(no),
  });
  // Validation needs the einvoice-tools sidecar; without it the item stays „In Verarbeitung“ (EC-INB-13).
  const item = page.getByTestId("inbox-item");
  await expect(item).toBeVisible({ timeout: 30_000 });
  const tabs = item.getByRole("tab");
  await expect(tabs.first()).toBeVisible({ timeout: 90_000 });
  for (const name of ["Darstellung", "Prüfbericht", "XML", "Anlagen"]) {
    await expect(item.getByRole("tab", { name })).toBeVisible();
  }
  await expect(item.getByRole("heading", { level: 2, name: `Rechnung ${no}` })).toBeVisible();
  await item.getByRole("tab", { name: "Prüfbericht" }).click();
  await expect(item.getByTestId("validation-report")).toBeVisible();
  await expectNoAxeViolations();
});

test("INB-010 EC-INB-12 reject with reason „Kein Geschäftsbeleg“", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop only");
  await openInbox(page);
  const seed = `reject-${Date.now()}`;
  await page.getByTestId("inbox-file-input").setInputFiles({
    name: `${seed}.pdf`,
    mimeType: "application/pdf",
    buffer: pdf(seed),
  });
  const item = await waitForReview(page, `${seed}.pdf`);
  await item.getByRole("button", { name: "Ablehnen" }).click();
  const dialog = page.getByRole("dialog", { name: "Beleg ablehnen" });
  await expect(dialog.getByText("Wird 90 Tage aufbewahrt")).toBeVisible();
  await dialog.getByRole("button", { name: "Ablehnen" }).click();
  await expect(page.getByText("Beleg abgelehnt")).toBeVisible({ timeout: 20_000 });
  await expect(item.locator('[data-status="rejected"]')).toBeVisible();
});

test("INB-003 phone: „Beleg“ in the tab bar opens the multi-page capture; two pages become one item", async ({
  page,
  expectNoAxeViolations,
}, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "phones only");
  await page.goto("/");
  await page.getByRole("link", { name: "Beleg fotografieren oder hochladen" }).click();
  const dialog = page.getByRole("dialog", { name: "Beleg fotografieren" });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  const seed = `${Date.now()}`;
  await dialog.getByTestId("camera-input").setInputFiles([
    { name: "seite-1.pdf", mimeType: "application/pdf", buffer: pdf(`${seed}-1`) },
    { name: "seite-2.pdf", mimeType: "application/pdf", buffer: pdf(`${seed}-2`) },
  ]);
  await expect(dialog.getByText("Seite 2")).toBeVisible();
  await dialog.getByRole("button", { name: "Seite 2 nach oben" }).click();
  await expectNoAxeViolations();
  await dialog.getByRole("button", { name: "Hochladen (2 Seiten)" }).click();
  await expect(page.getByText("Beleg mit 2 Seiten hochgeladen")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("inbox-files")).toContainText("seite-2.pdf", { timeout: 30_000 });
});

test("SET-110 SET-111 settings pages show credentials state, AVV and the OCR default „aus“", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/einstellungen/posteingang");
  await expect(h1(page, "Posteingang")).toBeVisible();
  await expect(page.getByTestId("inbox-health")).toContainText(/konfiguriert|fehlt/);
  await expect(
    page.getByRole("checkbox", { name: /Auftragsverarbeitungsvertrag \(AVV\) mit Cloudflare/ }),
  ).toBeVisible();
  await expectNoAxeViolations();
  await page.goto("/einstellungen/belegerkennung");
  await expect(h1(page, "Belegerkennung")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Belegerkennung aktiv" })).not.toBeChecked();
  await expect(page.getByLabel("Modell")).toHaveValue(/claude-/);
  await expectNoAxeViolations();
});
