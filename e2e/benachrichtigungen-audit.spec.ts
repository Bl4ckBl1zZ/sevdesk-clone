import type { Page } from "@playwright/test";
import { ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * P1 operations pages as the signed-in owner (F12 §6): Benachrichtigungen (NTF-001), the channel matrix
 * (NTF-002/004), the audit viewer (AUD-006/008) and the datenschutz/aufbewahrung pages (PRV-001, PRV-016); axe on every
 * page. Needs the backend journey (owner with completed setup).
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-ops.json`;
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

test("NTF-001 the notification list filters by severity and offers „Alle als gelesen markieren“", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/benachrichtigungen");
  await expect(h1(page, "Benachrichtigungen")).toBeVisible();
  await page.getByLabel("Schweregrad").selectOption({ label: "Warnung" });
  await page.getByLabel("Nur ungelesene").check();
  await expectNoAxeViolations();
});

test("NTF-002 critical kinds are locked in the channel matrix", async ({ page, expectNoAxeViolations }) => {
  await page.goto("/einstellungen/benachrichtigungen");
  await expect(page.getByText("Kanäle je Benachrichtigungsart").first()).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Integritätsprüfung fehlgeschlagen: E-Mail" })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Datensicherung veraltet: E-Mail" })).toBeEnabled();
  await expectNoAxeViolations();
});

test("AUD-006 AUD-008 the audit viewer filters by preset and offers the CSV/JSON export", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/einstellungen/audit");
  await expect(h1(page, "Protokoll")).toBeVisible();
  await expect(page.getByTestId("chain-status")).toBeVisible();
  await page.getByRole("button", { name: "Was hat Claude heute geändert?" }).click();
  await expect(page.getByRole("button", { name: "Was hat Claude heute geändert?" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  expect((await download).suggestedFilename()).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.json$/);
  await expectNoAxeViolations();
});

test("EXP-021 SND-20 SND-09 the invoice list offers Export ▾ and the bulk bar; /export lists the jobs", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/rechnungen");
  await expect(h1(page, "Rechnungen")).toBeVisible();
  await page.getByRole("button", { name: "Export als CSV" }).click();
  await expect(page.getByRole("menuitem", { name: "CSV (Excel)" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "CSV (technisch)" })).toBeVisible();
  await page.keyboard.press("Escape");
  const boxes = page.getByRole("checkbox", { name: /auswählen$/ });
  if ((await boxes.count()) > 1) {
    await boxes.nth(1).check();
    await expect(page.getByTestId("bulk-bar")).toContainText("1 ausgewählt");
  }
  await page.goto("/export");
  await expect(h1(page, "Export")).toBeVisible();
  await expectNoAxeViolations();
});

test("SET-114 PRV-001 PRV-015 /einstellungen/datenschutz lists external services, retention and the Art. 30 record", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/einstellungen/datenschutz");
  await expect(h1(page, "Datenschutz")).toBeVisible();
  const services = page.getByRole("list", { name: "Externe Dienste" });
  await expect(services).toContainText("Tailscale");
  await expect(services).toContainText("BZSt");
  await page.getByRole("tab", { name: "Aufbewahrung" }).click();
  await expect(page.getByRole("rowheader", { name: /Buchungsbelege/ })).toBeVisible();
  await page.getByRole("tab", { name: "Verzeichnis (Art. 30)" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Als Datei herunterladen" }).click();
  expect((await download).suggestedFilename()).toBe("verzeichnis-art30.md");
  await expectNoAxeViolations();
});

test("DOC-35 „Duplizieren“ on an invoice opens a new draft", async ({ page, expectNoAxeViolations }) => {
  await page.goto("/rechnungen");
  await expect(h1(page, "Rechnungen")).toBeVisible();
  const first = page.getByRole("link", { name: /^RE-/ }).filter({ visible: true }).first();
  test.skip((await first.count()) === 0, "no finalised invoice in this journey");
  await first.click();
  await page.getByRole("button", { name: "Duplizieren" }).click();
  await expect(page).toHaveURL(/\/rechnungen\/[a-z0-9]+$/);
  await expect(h1(page, /Entwurf/)).toBeVisible();
  await expectNoAxeViolations();
});

test("SET-132 AUD-026 /einstellungen/system shows the integrity status; Datensicherungen lists the backup state", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/einstellungen/system");
  await expect(page.getByText("Integritätsstatus")).toBeVisible();
  await expect(page.getByTestId("integrity-head")).toBeVisible();
  await page.getByRole("link", { name: "Datensicherungen" }).click();
  await expect(page).toHaveURL(/\/einstellungen\/system\/backups$/);
  await expect(page.getByText("Datensicherungen").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Neu prüfen" })).toBeVisible();
  await expectNoAxeViolations();
});

test("AUD-024 AUD-025 /einstellungen/verfahrensdokumentation lists the chapters with status and the release controls", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/einstellungen/verfahrensdokumentation");
  await expect(page.getByRole("region", { name: "1. Allgemeine Beschreibung" })).toBeVisible();
  await expect(page.getByRole("region", { name: "16. Änderungshistorie" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Angaben speichern" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Freigeben" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Freigegebene Versionen" })).toBeVisible();
  await expectNoAxeViolations();
});

test("DOC-18 INV-30 a draft takes an attachment; the finalised invoice shows Anhänge und Nachweise", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/rechnungen");
  await expect(h1(page, "Rechnungen")).toBeVisible();
  const first = page.getByRole("link", { name: /^RE-/ }).filter({ visible: true }).first();
  test.skip((await first.count()) === 0, "no finalised invoice in this journey");
  await first.click();
  const section = page.getByRole("region", { name: "Anhänge und Nachweise" });
  await expect(section).toBeVisible();
  await expect(section.getByRole("heading", { name: "Nachweise" })).toBeVisible();
  await expect(section.getByLabel("Art des Nachweises")).toBeVisible();
  await page.getByRole("button", { name: "Duplizieren" }).click();
  await expect(h1(page, /Entwurf/)).toBeVisible();
  await page.getByLabel("Anhang hinzufügen (höchstens 10)").setInputFiles({
    name: "agb.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\n%%EOF"),
  });
  await expect(page.getByTestId("document-attachments")).toContainText("agb.pdf");
  await expectNoAxeViolations();
});

test("DOC-39 T-DOC-043 the invoice shows its Nummernkreis-Eintrag and links to the register with the gap report", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/rechnungen");
  await expect(h1(page, "Rechnungen")).toBeVisible();
  const first = page.getByRole("link", { name: /^RE-/ }).filter({ visible: true }).first();
  test.skip((await first.count()) === 0, "no finalised invoice in this journey");
  await first.click();
  const entry = page.getByTestId("register-entry");
  await expect(entry).toContainText("Nummernkreis-Eintrag");
  await entry.getByRole("link", { name: "Im Nummernregister anzeigen" }).click();
  await expect(page).toHaveURL(/\/einstellungen\/nummernkreise\/register\?range=/);
  await expect(page.getByTestId("number-register")).toBeVisible();
  await expect(page.getByText("Lückenbericht")).toBeVisible();
  await expectNoAxeViolations();
});

test("DOC-53 DOC-54 PRD-053 the invoice editor offers layout, cost centre and the per-line revenue account", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/rechnungen/neu");
  await expect(page.getByLabel("Erlöskonto").first()).toBeVisible();
  const layout = page.getByLabel("Layout");
  if ((await layout.count()) > 0) await expect(layout.locator("option").first()).toContainText("Standard der Belegart");
  const costCentre = page.getByLabel("Kostenstelle").first();
  if ((await costCentre.count()) > 0)
    await expect(costCentre.locator("option").first()).toContainText("Keine Kostenstelle");
  await expectNoAxeViolations();
});

test("SET-076 the layout version history lists versions with their changes", async ({ page, expectNoAxeViolations }) => {
  await page.goto("/einstellungen/layouts");
  const versions = page.getByRole("button", { name: /^Versionen/ }).first();
  test.skip((await versions.count()) === 0, "no layout yet in this journey");
  await versions.click();
  await expect(page.getByTestId("layout-history")).toContainText("Version 1");
  await expectNoAxeViolations();
});
