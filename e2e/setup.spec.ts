import { expect, test } from "./fixtures";

/** Setup wizard (F01 §6.2) without a backend: every step renders accessibly; validation blocks "Weiter". */

const STEPS: [slug: string, heading: string][] = [
  ["inhaberkonto", "Inhaberkonto"],
  ["zugriff", "Adressen & Zugriff"],
  ["e-mail", "E-Mail-Versand"],
  ["speicher", "Speicher"],
  ["start", "Start"],
  ["unternehmen", "Unternehmen"],
  ["steuern", "Steuern"],
  ["bank", "Bank"],
  ["layout", "Layout"],
  ["nummernkreise", "Nummernkreise"],
  ["fertig", "Fertig"],
];

test("MISC-10 every wizard step renders in F01 order without axe violations", async ({
  page,
  expectNoAxeViolations,
}) => {
  for (const [i, [slug, heading]] of STEPS.entries()) {
    await page.goto(`/einrichtung?schritt=${slug}`);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByText(`Schritt ${i + 1} von 11`).first()).toBeAttached();
    await expectNoAxeViolations();
  }
});

test("SMOKE the company step blocks Weiter with German errors and continues once valid", async ({ page }) => {
  await page.goto("/einrichtung?schritt=unternehmen");
  await page.getByRole("button", { name: "Weiter" }).click();
  const name = page.getByLabel(/Firma bzw\. vollständiger Name/);
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toBeFocused();
  await expect(page.getByText("Bitte den Namen des Unternehmens angeben.")).toBeVisible();

  await name.fill("Max Mustermann");
  await page.getByLabel(/Straße und Hausnummer/).fill("Hauptstr. 1");
  await page.getByLabel(/^PLZ/).fill("10115");
  await page.getByLabel(/^Ort/).fill("Berlin");
  await page.getByLabel(/^Ansprechpartner/).fill("Max Mustermann");
  await page.getByLabel(/^Telefon/).fill("+49 30 123456");
  await page.getByLabel(/^E-Mail/).fill("info@muster.de");
  await page.getByRole("button", { name: "Weiter" }).click();
  await expect(page.getByText("Noch nicht verbunden").first()).toBeVisible();
  await expect(page).toHaveURL(/schritt=steuern$/);
  await expect(page.getByRole("heading", { level: 1, name: "Steuern" })).toBeFocused();
  await expect(page.getByRole("radio", { name: /SKR03/ })).toBeChecked();
});

test("SET-009 step 1 cannot be left without a passkey", async ({ page }) => {
  await page.goto("/einrichtung?schritt=inhaberkonto");
  await expect(page.getByRole("button", { name: "Weiter" })).toBeDisabled();
  await expect(page.getByText("Bitte zuerst einen Passkey einrichten.")).toBeVisible();
});
