import type { Page } from "@playwright/test";
import { ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * Projekte und Zeiten (F11) as the signed-in owner: create a project with rate and hours budget, record a manual
 * entry, run and discard the timer, invoice the entry into a draft („Zeiten abrechnen“) and see it locked as „Im
 * Entwurf“. Needs the backend and runs after e2e/journey.spec.ts and e2e/kontakte-produkte.spec.ts in the same
 * project (single worker, files in order): owner, number ranges, setup and the customer „Muster Handwerk GmbH“.
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-projects.json`;
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
const projectName = (project: string) => `E2E Relaunch ${project}`;
const visible = (page: Page, text: string | RegExp) => page.getByText(text).filter({ visible: true }).first();

test("PRJ-001 PRJ-003 PRJ-008 a project is created with customer, hourly rate and an hours budget", async ({
  page,
  expectNoAxeViolations,
}, testInfo) => {
  await page.goto("/projekte");
  await expect(h1(page, "Projekte")).toBeVisible();
  await expectNoAxeViolations();

  await page.getByRole("button", { name: "Neues Projekt" }).filter({ visible: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Neues Projekt" });
  await dialog.getByLabel("Projektname", { exact: false }).fill(projectName(testInfo.project.name));
  await dialog.getByLabel("Kunde suchen").fill("Muster");
  const customer = dialog.getByLabel("Kunde", { exact: true });
  await expect(customer.locator("option", { hasText: "Muster Handwerk GmbH" })).toHaveCount(1);
  await customer.selectOption({
    label: (await customer.locator("option", { hasText: "Muster Handwerk GmbH" }).textContent()) ?? "",
  });
  await dialog.getByLabel("Stundensatz netto (€)").fill("100");
  await dialog.getByLabel("Budget", { exact: true }).selectOption("hours");
  await dialog.getByLabel("Budgetwert", { exact: false }).fill("2");
  await expectNoAxeViolations();
  await dialog.getByRole("button", { name: "Speichern" }).click();

  await expect(page).toHaveURL(/\/projekte\/[a-z0-9]+$/, { timeout: 20_000 });
  await expect(h1(page, projectName(testInfo.project.name))).toBeVisible();
  await expect(page.getByText(/^PRJ-\d{5} · Aktiv$/)).toBeVisible();
  await expect(page.getByTestId("project-budget")).toContainText("0:00 h von 2:00 h");
  for (const tab of ["Übersicht", "Zeiten", "Dokumente", "Belege", "Einstellungen"]) {
    await expect(page.getByRole("tab", { name: tab })).toBeVisible();
  }
  await expectNoAxeViolations();

  await page.goto("/projekte");
  await expect(
    page.getByRole("link", { name: projectName(testInfo.project.name) }).filter({ visible: true }),
  ).toBeVisible();
  await expectNoAxeViolations();
});

test("PRJ-007 PRJ-003 a manual entry „1:30“ is recorded on the project and consumes the budget", async ({
  page,
  expectNoAxeViolations,
}, testInfo) => {
  await page.goto("/projekte");
  await page
    .getByRole("link", { name: projectName(testInfo.project.name) })
    .filter({ visible: true })
    .first()
    .click();
  await expect(h1(page, projectName(testInfo.project.name))).toBeVisible();
  await page.getByRole("tab", { name: "Zeiten" }).click();
  await page.getByRole("button", { name: "Zeit erfassen" }).click();
  const dialog = page.getByRole("dialog", { name: "Zeit erfassen" });
  await expect(dialog.getByLabel("Projekt", { exact: true })).not.toHaveValue("");
  await dialog.getByLabel("Dauer", { exact: false }).fill("1:30");
  await dialog.getByLabel("Tätigkeit", { exact: false }).fill("Konzeptworkshop mit dem Kunden");
  await expectNoAxeViolations();
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(dialog).toBeHidden();

  await expect(visible(page, "Konzeptworkshop mit dem Kunden")).toBeVisible();
  await expect(visible(page, "1:30 h")).toBeVisible();
  await expect(visible(page, "Offen")).toBeVisible();
  await expectNoAxeViolations();

  await page.getByRole("tab", { name: "Übersicht" }).click();
  await expect(page.getByTestId("project-budget")).toContainText("1:30 h von 2:00 h");
  await expect(page.getByTestId("project-budget")).toBeVisible();
});

test("PRJ-005 the timer runs live and can be discarded without an entry", async ({ page, expectNoAxeViolations }) => {
  await page.goto("/zeiten");
  await expect(h1(page, "Zeiten")).toBeVisible();
  const timer = page.getByTestId("timer");
  await expect(timer).toHaveAttribute("data-running", "false");
  await timer.getByLabel("Tätigkeit").fill("Telefonat");
  await timer.getByRole("button", { name: "Zeit starten" }).click();
  await expect(timer).toHaveAttribute("data-running", "true");
  await expect(page.getByTestId("timer-elapsed")).toHaveText(/^0:00:0[1-9]$/, { timeout: 10_000 });
  await expectNoAxeViolations();

  await timer.getByRole("button", { name: "Verwerfen" }).click();
  const confirm = page.getByRole("dialog", { name: "Timer verwerfen?" });
  await confirm.getByRole("button", { name: "Verwerfen" }).click();
  await expect(timer).toHaveAttribute("data-running", "false");
  await expect(timer.getByLabel("Tätigkeit")).toHaveValue("");
  await expect(page.getByRole("cell", { name: "Telefonat" })).toHaveCount(0);
});

test("PRJ-010 PRJ-012 „Zeiten abrechnen“ creates an invoice draft and locks the entry „Im Entwurf“", async ({
  page,
  expectNoAxeViolations,
}, testInfo) => {
  await page.goto("/projekte");
  await page
    .getByRole("link", { name: projectName(testInfo.project.name) })
    .filter({ visible: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Zeiten abrechnen" }).click();
  const dialog = page.getByRole("dialog", { name: "Zeiten abrechnen" });
  const preview = dialog.getByTestId("invoice-preview");
  await expect(preview).toContainText("1:30 h");
  await expect(preview).toContainText("150,00 €");
  await expect(preview).toContainText(/Leistungsdatum \d{2}\.\d{2}\.\d{4}/);
  await expectNoAxeViolations();
  await dialog.getByRole("button", { name: "Entwurf erstellen" }).click();

  await expect(page).toHaveURL(/\/rechnungen\/[a-z0-9]+$/, { timeout: 20_000 });

  await page.goto("/zeiten?status=in_draft");
  await expect(visible(page, "Konzeptworkshop mit dem Kunden")).toBeVisible();
  await expect(visible(page, "Im Entwurf")).toBeVisible();
  await expect(page.getByRole("button", { name: "Bearbeiten" })).toHaveCount(0);
  await expectNoAxeViolations();
});
