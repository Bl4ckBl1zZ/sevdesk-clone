import type { Page } from "@playwright/test";
import { ownerStorageState } from "./backend";
import { expect, selectCustomer, test } from "./fixtures";

/**
 * Angebote, Lieferscheine und Proforma (F04 P1 QUO/DOC) as the signed-in owner: quote → accepted → converted →
 * finalised invoice; a new quote version supersedes the old one; a delivery note without prices; a proforma with its
 * note. Needs the backend and runs after e2e/00-journey.spec.ts and e2e/kontakte-produkte.spec.ts in the same project
 * (single worker, files in order), which created the owner (setup complete) and the contact „Muster Handwerk GmbH“.
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-quotes.json`;
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
// Finalising waits up to 60 s on a cold backend, above the 30 s default test timeout.
test.describe.configure({ mode: "serial", timeout: 120_000 });

const h1 = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name });

/** Opens the editor at `path`, picks „Muster Handwerk GmbH“ and fills one manual line. */
async function newDraft(page: Page, path: string, title: string, line: { name: string; price: string }) {
  await page.goto(path);
  await expect(h1(page, title)).toBeVisible();
  await selectCustomer(page, "Muster Handwerk GmbH");
  await expect(page.getByTestId("buyer")).toContainText("Muster Handwerk GmbH");
  await page.getByLabel("Bezeichnung (Pos. 1)").fill(line.name);
  await page.getByLabel("Menge").first().fill("2");
  await page.getByLabel("Einzelpreis").first().fill(line.price);
}

/** Saves the draft (if `save`) and finalises it; returns the number from the heading „<label> <number>“. */
async function finalize(page: Page, label: string, route: string, save = true): Promise<string> {
  if (save) {
    await page.getByRole("button", { name: "Entwurf speichern" }).click();
    await expect(page).toHaveURL(new RegExp(`${route}/[a-z0-9]+$`), { timeout: 30_000 });
  }
  await expect(h1(page, `${label === "Rechnung" ? "Rechnungsentwurf" : `${label} (Entwurf)`}`)).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("compliance").getByRole("status")).toHaveText(/Bereit zum Fertigstellen/, {
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Fertigstellen" }).click();
  const dialog = page.getByRole("dialog", { name: `${label} fertigstellen?` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Jetzt fertigstellen" }).click();
  // Not „Angebot (Entwurf)“: a revision opens as a draft whose heading has the same shape (QUO-06).
  const heading = h1(page, new RegExp(`^${label} [^\\s(]\\S*$`));
  await expect(heading).toBeVisible({ timeout: 60_000 });
  return ((await heading.textContent()) ?? "").replace(`${label} `, "").trim();
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

test("QUO-01 QUO-05 DOC-33 QUO-12 quote → accepted → invoice draft → finalised invoice; the chain shows 100 %", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/angebote");
  await expect(h1(page, "Angebote")).toBeVisible();
  await expectNoAxeViolations();

  await newDraft(page, "/angebote/neu", "Neues Angebot", { name: "Wartungsvertrag Angebot", price: "250,00" });
  await expect(page.getByLabel("Gültig bis")).toBeVisible();
  await expect(page.getByTestId("gross")).toHaveText("595,00 €", { timeout: 20_000 });
  await expectNoAxeViolations();
  const number = await finalize(page, "Angebot", "/angebote");
  expect(number).toMatch(/^AN-\d{4}-\d{4,}$/);
  await expect(page.getByText("Gültig bis").first()).toBeVisible();

  await page.getByRole("button", { name: "Angenommen" }).click();
  const accept = page.getByRole("dialog", { name: "Angebot als angenommen markieren" });
  await accept.getByLabel("Angenommen von").fill("Max Beispiel");
  await expectNoAxeViolations();
  await accept.getByRole("button", { name: "Speichern" }).click();
  await expect(accept).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("[data-status=accepted]").filter({ visible: true }).first()).toHaveText("Angenommen");

  await page.getByRole("button", { name: "Umwandeln" }).click();
  const convert = page.getByRole("dialog", { name: `Angebot ${number} umwandeln` });
  await convert.getByLabel("Neuer Beleg").selectOption("invoice");
  await expect(convert.getByLabel(/Wartungsvertrag Angebot/)).toHaveValue("2", { timeout: 20_000 });
  await convert.getByRole("button", { name: "Entwurf erstellen" }).click();
  await expect(page).toHaveURL(/\/rechnungen\/(?!neu$)[a-z0-9]+$/, { timeout: 30_000 });
  await expect(h1(page, "Rechnungsentwurf")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel("Bezeichnung (Pos. 1)")).toHaveValue("Wartungsvertrag Angebot");
  // A quote has no Leistungsdatum; the invoice needs one (UST-08).
  await page.getByLabel("Leistungszeitpunkt").selectOption("document_date");
  await page.getByRole("button", { name: "Entwurf speichern" }).click();
  await expect(page.getByText("Gespeichert.").first()).toBeVisible({ timeout: 20_000 });
  const invoiceNumber = await finalize(page, "Rechnung", "/rechnungen", false);
  expect(invoiceNumber).toMatch(/^RE-/);

  const chain = page.getByTestId("chain").filter({ visible: true });
  await expect(chain).toContainText(`Angebot ${number}`, { timeout: 20_000 });
  await chain.getByRole("link", { name: `Angebot ${number}` }).click();
  await expect(h1(page, `Angebot ${number}`)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("chain").filter({ visible: true })).toContainText("100 % berechnet");
  await expect(page.locator("[data-status=invoiced]").filter({ visible: true }).first()).toBeVisible();
  await expectNoAxeViolations();
});

test("QUO-06 a new quote version gets the -V2 suffix; the old quote shows „Ersetzt“", async ({ page }) => {
  await newDraft(page, "/angebote/neu", "Neues Angebot", { name: "Heizungstausch Angebot", price: "1.000,00" });
  const number = await finalize(page, "Angebot", "/angebote");
  const original = page.url();
  await page.getByRole("button", { name: "Neue Version" }).click();
  const revise = page.getByRole("dialog", { name: "Neue Version anlegen" });
  await revise.getByLabel("Grund (optional)").fill("Preis angepasst");
  await revise.getByRole("button", { name: "Version anlegen" }).click();
  await expect(page).not.toHaveURL(original, { timeout: 30_000 });
  await expect(h1(page, "Angebot (Entwurf)")).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Einzelpreis").first().fill("900,00");
  await page.getByRole("button", { name: "Entwurf speichern" }).click();
  await expect(page.getByTestId("gross")).toHaveText("2.142,00 €", { timeout: 20_000 });
  const v2 = await finalize(page, "Angebot", "/angebote", false);
  expect(v2).toBe(`${number}-V2`);
  await page.goto(original);
  await expect(h1(page, `Angebot ${number}`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-status=superseded]").filter({ visible: true }).first()).toHaveText("Ersetzt");
});

test("QUO-09 a delivery note is finalised without prices and marked as received", async ({
  page,
  expectNoAxeViolations,
}) => {
  await newDraft(page, "/lieferscheine/neu", "Neuer Lieferschein", { name: "Heizkörper Typ 22", price: "180,00" });
  await expect(page.getByLabel("Preise und Summen auf dem Lieferschein drucken")).not.toBeChecked();
  await expect(page.getByText("Der Lieferschein wird ohne Preise gedruckt").first()).toBeVisible();
  await page.getByLabel("Leistungszeitpunkt").selectOption("document_date");
  await expectNoAxeViolations();
  const number = await finalize(page, "Lieferschein", "/lieferscheine");
  expect(number).toMatch(/^LS-/);
  await page.getByRole("button", { name: "Als erhalten markieren" }).click();
  const received = page.getByRole("dialog", { name: "Lieferschein als erhalten markieren" });
  await received.getByLabel("Empfangen von").fill("Lager Muster");
  await received.getByRole("button", { name: "Speichern" }).click();
  await expect(received).toBeHidden({ timeout: 20_000 });
  await expect(page.getByText(/von Lager Muster/).first()).toBeVisible({ timeout: 20_000 });
  await expectNoAxeViolations();
});

test("DOC-25 a proforma invoice gets its own number and the note „keine Rechnung“", async ({ page }) => {
  await newDraft(page, "/rechnungen/neu?typ=proforma", "Neue Proforma-Rechnung", {
    name: "Vorauszahlung Material",
    price: "400,00",
  });
  await page.getByLabel("Leistungszeitpunkt").selectOption("document_date");
  const number = await finalize(page, "Proforma-Rechnung", "/rechnungen");
  expect(number).toMatch(/^PF-/);
  await expect(page.getByText(/Proforma-Rechnung – keine Rechnung im Sinne des § 14 UStG/).first()).toBeVisible();
  await page.goto("/rechnungen?status=proforma");
  await expect(page.getByRole("link", { name: number }).filter({ visible: true }).first()).toBeVisible({
    timeout: 20_000,
  });
});
