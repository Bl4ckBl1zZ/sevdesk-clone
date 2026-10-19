import type { Page } from "@playwright/test";
import { ownerStorageState } from "./backend";
import { expect, selectCustomer, test } from "./fixtures";

/**
 * Wiederkehrende Rechnungen (F04 §3.4 REC, §6.1, §6.5) as the signed-in owner: template with customer, position,
 * schedule and finalise automation (first-activation confirmation) → „Nächste Termine“ → „Jetzt erzeugen“ creates
 * and finalises the invoice (never sent: to-do „Exportieren und versenden“) → pause → resume with „Überspringen“.
 * Needs the backend and runs after e2e/00-journey.spec.ts and e2e/kontakte-produkte.spec.ts in the same project (single
 * worker, files in order), which created the owner (setup complete) and the contact „Muster Handwerk GmbH“.
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-recurring.json`;
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
// The recurring run waits up to 90 s for the generated + finalised invoice, above the 30 s default test timeout.
test.describe.configure({ mode: "serial", timeout: 120_000 });

const h1 = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name });

/** One template name per project run, so the phone projects do not see the desktop's template. */
const templateName = (project: string) => `Wartungsvertrag ${project}`;
let templateUrl = "";

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

test("REC-01 REC-13 REC-14 REC-16 template with schedule and confirmed finalise automation; 12 next occurrences", async ({
  page,
  expectNoAxeViolations,
}, testInfo) => {
  await page.goto("/rechnungen/wiederkehrend");
  await expect(h1(page, "Wiederkehrende Rechnungen")).toBeVisible();
  await expectNoAxeViolations();

  await page.goto("/rechnungen/wiederkehrend/neu");
  await expect(h1(page, "Neue wiederkehrende Rechnung")).toBeVisible();
  await page.getByLabel("Name der Vorlage").fill(templateName(testInfo.project.name));
  await page.getByLabel("Vertragsreferenz (BT-12)").fill("V-2026-17");
  await selectCustomer(page, "Muster Handwerk GmbH");
  await page.getByLabel("Intervall").selectOption("P1M");
  await page.getByLabel("Abrechnung").selectOption("in_advance");
  await page.getByLabel("Bezeichnung (Pos. 1)").fill("Wartungspauschale");
  await page.getByLabel("Menge").first().fill("1");
  await page.getByLabel("Einzelpreis").first().fill("120,00");
  await expect(page.getByTestId("occurrences").getByRole("listitem")).toHaveCount(12, { timeout: 20_000 });
  await expect(page.getByTestId("occurrences")).toContainText("142,80 €");
  await expect(page.getByText("Versendet wird nie automatisch").first()).toBeVisible();
  await expectNoAxeViolations();

  // REC-14: the first activation of „Fertigstellen“ asks for a confirmation.
  await page.getByLabel("Fertigstellen", { exact: true }).check();
  await page.getByRole("button", { name: "Vorlage speichern" }).click();
  const confirm = page.getByRole("dialog", { name: "Automatisches Fertigstellen aktivieren?" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("Versendet wird nie automatisch");
  await expectNoAxeViolations();
  await confirm.getByRole("button", { name: "Automatik aktivieren" }).click();
  await expect(page).toHaveURL(/\/rechnungen\/wiederkehrend\/(?!neu$)[a-z0-9]+$/, { timeout: 30_000 });
  templateUrl = new URL(page.url()).pathname;
  await expect(h1(page, templateName(testInfo.project.name))).toBeVisible();
  await expect(page.getByTestId("template-state")).toHaveText("Aktiv");
  await expect(page.getByText("Fertigstellen automatisch").first()).toBeVisible();
  await expect(page.getByText("Änderungen wirken nur auf künftige Rechnungen")).toBeVisible();
  await expectNoAxeViolations();
});

test("REC-12 REC-16 MAIL-02 „Jetzt erzeugen“ finalises the next invoice; it is never sent — a to-do asks to export and send", async ({
  page,
  expectNoAxeViolations,
}) => {
  test.skip(!templateUrl, "needs the template of the previous test");
  await page.goto(templateUrl);
  await page.getByRole("button", { name: "Jetzt erzeugen" }).click();
  await expect(page.getByText(/1 Rechnung erzeugt, 1 fertiggestellt/)).toBeVisible({ timeout: 90_000 });
  const docs = page.getByTestId("generated-documents");
  await expect(docs.getByRole("listitem")).toHaveCount(1, { timeout: 20_000 });
  await expect(docs).toContainText("Nicht versendet");
  await expectNoAxeViolations();

  const number = ((await docs.getByRole("link").first().textContent()) ?? "").trim();
  expect(number).not.toBe("Entwurf");
  await page.goto("/");
  await expect(page.getByTestId("todos")).toContainText(`Exportieren und versenden: ${number}`, { timeout: 20_000 });
});

test("REC-10 pause and resume with „Überspringen“; the list shows the template under Aktiv", async ({
  page,
  expectNoAxeViolations,
}, testInfo) => {
  test.skip(!templateUrl, "needs the template of the previous tests");
  await page.goto(templateUrl);
  await page.getByRole("button", { name: "Pausieren" }).click();
  await expect(page.getByTestId("template-state")).toHaveText("Pausiert", { timeout: 20_000 });
  await page.getByRole("button", { name: "Fortsetzen" }).click();
  const dialog = page.getByRole("dialog", { name: "Vorlage fortsetzen" });
  await expect(dialog.getByLabel(/Überspringen/)).toBeChecked();
  await expectNoAxeViolations();
  await dialog.getByRole("button", { name: "Fortsetzen" }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId("template-state")).toHaveText("Aktiv");

  await page.goto("/rechnungen/wiederkehrend");
  const name = templateName(testInfo.project.name);
  await expect(page.getByRole("link", { name }).filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Monatlich").filter({ visible: true }).first()).toBeVisible();
  await expectNoAxeViolations();
});
