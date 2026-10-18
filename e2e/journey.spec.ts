import type { BrowserContext, Page } from "@playwright/test";
import {
  addVirtualAuthenticator,
  backendEnabled,
  hasMailFor,
  OWNER_EMAIL,
  resetBackend,
  signInWithCode,
} from "./backend";
import { devServer, expect, expectNoAxeViolations as noAxeViolations, test, waitForAppOnNavigation } from "./fixtures";

/**
 * P0 gate journey against the real self-hosted backend (07-testing §3.2): owner bootstrap with an e-mail code,
 * passkey enrolment (CDP virtual authenticator), the complete setup wizard, persistence after reload, the shell,
 * members + invite, sign-out and passkey sign-in, an uninvited address, the invited bookkeeper.
 *
 * Runs on the Chromium projects (desktop, pixel); each project starts from an empty deployment (`resetBackend`).
 * Skipped without a backend (see e2e/backend.ts).
 */
test.skip(!backendEnabled, "needs the local test backend (pnpm test:backend)");
test.skip(({ browserName }) => browserName !== "chromium", "virtual WebAuthn authenticator needs Chromium (CDP)");
test.describe.configure({ mode: "serial", timeout: devServer ? 240_000 : 120_000 });

let context: BrowserContext;
let page: Page;

const weiter = (p: Page) => p.getByRole("button", { name: "Weiter", exact: true });

async function expectStep(p: Page, heading: string) {
  await expect(p.getByRole("heading", { level: 1, name: heading })).toBeVisible({ timeout: 20_000 });
}

test.beforeAll(async ({ browser }, testInfo) => {
  resetBackend();
  context = await browser.newContext({ ...testInfo.project.use, baseURL: testInfo.project.use.baseURL });
  page = waitForAppOnNavigation(await context.newPage());
  await addVirtualAuthenticator(context, page);
});

test.afterAll(async () => {
  await context?.close();
});

test("SEC-01 SET-001 SET-009 the owner signs up with an e-mail code and must enrol a passkey", async () => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/anmelden$/);
  await expect(
    page.getByText("Ersteinrichtung — Anmeldung nur mit der hinterlegten Inhaber-E-Mail-Adresse."),
  ).toBeVisible();
  await noAxeViolations(page);

  await signInWithCode(page, OWNER_EMAIL);
  await expect(page).toHaveURL(/\/anmelden\/passkey-einrichten/, { timeout: 20_000 });
  await expect(page.getByText("Für das Inhaberkonto ist ein Passkey Pflicht.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Später" })).toHaveCount(0);
  await noAxeViolations(page);

  await page.getByRole("button", { name: "Passkey einrichten" }).click();
  // SET-001: until the setup is complete every signed-in route leads to the wizard.
  await expect(page).toHaveURL(/\/einrichtung/, { timeout: 20_000 });
});

test("SET-002 SET-003 SET-004 the wizard saves every step on the server and completes the setup", async () => {
  // Step 1 is done (passkey), step 3 too (the bootstrap code was delivered): the wizard resumes at step 2.
  await expectStep(page, "Adressen & Zugriff");
  await noAxeViolations(page);
  await page.getByLabel("Die Anwendung ist nur im Tailnet erreichbar").check();
  await weiter(page).click();

  await expectStep(page, "E-Mail-Versand");
  await expect(page.getByLabel(/Adresse für Benachrichtigungen/)).toHaveValue(OWNER_EMAIL);
  await noAxeViolations(page);
  await weiter(page).click();

  await expectStep(page, "Speicher");
  await page.getByRole("button", { name: "Speicher prüfen" }).click();
  await expect(page.getByText(/Schreiben, Lesen und Löschen erfolgreich/)).toBeVisible({ timeout: 20_000 });
  await noAxeViolations(page);
  await weiter(page).click();

  await expectStep(page, "Start");
  await weiter(page).click();

  await expectStep(page, "Unternehmen");
  await weiter(page).click();
  // Invalid data blocks „Weiter“ with linked German errors (F01 §5.1).
  const name = page.getByLabel(/Firma bzw\. vollständiger Name/);
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Bitte den Namen des Unternehmens angeben.")).toBeVisible();
  await name.fill("Erika Musterfrau");
  await page.getByLabel(/Straße und Hausnummer/).fill("Hauptstraße 1");
  await page.getByLabel(/^PLZ/).fill("10115");
  await page.getByLabel(/^Ort/).fill("Berlin");
  await page.getByLabel(/^Ansprechpartner/).fill("Erika Musterfrau");
  await page.getByLabel(/^Telefon/).fill("+49 30 123456");
  await page.getByLabel(/^E-Mail/).fill("info@musterfrau.de");
  await noAxeViolations(page);
  await weiter(page).click();

  await expectStep(page, "Steuern");
  await expect(page.getByRole("radio", { name: /SKR03/ })).toBeChecked();
  await page.getByLabel(/^Bundesland/).selectOption("BE");
  await page.getByRole("textbox", { name: "Steuernummer" }).fill("27/815/08155");
  await noAxeViolations(page);
  await weiter(page).click();

  await expectStep(page, "Bank");
  await page.getByRole("button", { name: "Später" }).click();
  await expectStep(page, "Layout");
  await page.getByRole("button", { name: "Später" }).click();

  await expectStep(page, "Nummernkreise");
  await noAxeViolations(page);
  await weiter(page).click();

  await expectStep(page, "Fertig");
  await expect(page.getByText("Alle Pflichtangaben sind vollständig.")).toBeVisible({ timeout: 20_000 });
  await noAxeViolations(page);
  await page.getByRole("button", { name: "Einrichtung abschließen" }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1, name: /^Herzlich Willkommen/ })).toBeVisible();
});

test("SET-003 SET-008 after a reload the data is persisted and the wizard is no longer forced", async () => {
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: /^Herzlich Willkommen/ })).toBeVisible();
  await page.goto("/einstellungen/unternehmen");
  await expect(page.getByLabel(/Firma bzw\. vollständiger Name/)).toHaveValue("Erika Musterfrau", { timeout: 20_000 });
  await expect(page.getByLabel(/^Ort/)).toHaveValue("Berlin");
  await noAxeViolations(page);
  await page.goto("/einstellungen/steuern");
  await expect(page.getByRole("textbox", { name: "Steuernummer" })).toHaveValue("27/815/08155", { timeout: 20_000 });
});

test("MISC-10 the shell navigation works for the owner without axe violations", async ({ isMobile }) => {
  await page.goto("/rechnungen");
  await expect(page.getByRole("heading", { level: 1, name: "Rechnungen" })).toBeVisible();
  await noAxeViolations(page);
  if (isMobile) {
    const tabs = page.getByRole("navigation", { name: "Schnellzugriff" });
    await expect(tabs).toBeVisible();
  } else {
    const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
    await nav.getByRole("link", { name: "Kontakte" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Kontakte" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Kontakte" })).toHaveAttribute("aria-current", "page");
  }
});

test("ACC-013 ACC-001 ACC-003 ACC-008 the owner posts the opening cash balance and reads it in the journal", async () => {
  await page.goto("/buchhaltung/eroeffnung");
  await expect(page.getByRole("heading", { level: 1, name: "Eröffnungsbilanz" })).toBeVisible();
  const cash = page.getByLabel("Anfangsbestand Kasse");
  await expect(cash).toBeVisible({ timeout: 20_000 });
  await noAxeViolations(page);
  await cash.fill("250,00");
  await page.getByRole("button", { name: "Anfangsbestand Kasse buchen" }).click();
  await expect(page.getByText(/Gebucht \(Nr\. 1, 250,00/)).toBeVisible({ timeout: 20_000 });

  await page.goto("/buchhaltung/journal");
  await expect(page.getByRole("heading", { level: 1, name: "Journal" })).toBeVisible();
  await page.getByRole("button", { name: "Buchung 1 öffnen" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: "Warum dieses Konto?" })).toBeVisible();
  await expect(sheet.getByText("1000", { exact: true })).toBeVisible();
  await noAxeViolations(page);
  await page.keyboard.press("Escape");

  await page.goto("/buchhaltung/konten");
  await page.getByRole("tab", { name: /Rollen & Standardkonten/ }).click();
  await expect(page.getByText("nicht zugeordnet").first()).toBeVisible({ timeout: 20_000 });
  await noAxeViolations(page);
});

test("SEC-01 04 §4.10 the owner invites a bookkeeper from /einstellungen/mitglieder", async () => {
  await page.goto("/einstellungen/mitglieder");
  await expect(page.getByText(OWNER_EMAIL).filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
  await noAxeViolations(page);
  await page.getByRole("button", { name: "Person einladen" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/E-Mail-Adresse/).fill("buchhaltung@example.test");
  await dialog.getByLabel(/^Rolle/).selectOption("bookkeeper");
  await noAxeViolations(page);
  await dialog.getByRole("button", { name: "Einladung senden" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Einladung an buchhaltung@example.test erstellt.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Zurückziehen (buchhaltung@example.test)" })).toBeVisible();
});

test("SEC-01 the owner signs out and back in with the passkey", async () => {
  await page.goto("/");
  await page.getByRole("button", { name: "Kontomenü" }).click();
  await page.getByRole("menuitem", { name: "Abmelden" }).click();
  await expect(page).toHaveURL(/\/anmelden$/, { timeout: 20_000 });
  await expect(page.getByText(/Ersteinrichtung/)).toHaveCount(0);
  await page.getByRole("button", { name: "Mit Passkey anmelden" }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1, name: /^Herzlich Willkommen/ })).toBeVisible();
});

test("SEC-01 an uninvited address gets the neutral answer and no code (E-AUD-26)", async ({ browser }, testInfo) => {
  const other = await browser.newContext({ ...testInfo.project.use });
  const p = waitForAppOnNavigation(await other.newPage());
  await p.goto("/anmelden");
  await p.getByLabel("E-Mail-Adresse").fill("fremd@example.test");
  await p.getByRole("button", { name: "Code per E-Mail senden" }).click();
  await expect(p.getByRole("heading", { level: 1, name: "Code eingeben" })).toBeVisible();
  expect(await hasMailFor("fremd@example.test")).toBe(false);
  await other.close();
});

test("SEC-01 the invited bookkeeper signs in with a code and has no access to the owner setup", async ({
  browser,
}, testInfo) => {
  const other = await browser.newContext({ ...testInfo.project.use });
  const p = waitForAppOnNavigation(await other.newPage());
  await signInWithCode(p, "buchhaltung@example.test");
  await expect(p).toHaveURL(/\/anmelden\/passkey-einrichten/, { timeout: 20_000 });
  await p.getByRole("link", { name: "Später" }).click();
  await expect(p.getByRole("heading", { level: 1, name: /^Herzlich Willkommen/ })).toBeVisible({ timeout: 20_000 });
  await p.goto("/einrichtung");
  await expect(p.getByText("Ihre Rolle (Buchhaltung) erlaubt diese Aktion nicht.")).toBeVisible();
  await p.goto("/einstellungen/mitglieder");
  await expect(p.getByText("Ihre Rolle (Buchhaltung) erlaubt diese Aktion nicht.")).toBeVisible();
  await other.close();
});
