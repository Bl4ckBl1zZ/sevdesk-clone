import type { Locator, Page } from "@playwright/test";
import { backdateTestInvoice, ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * Mahnwesen (F05 T05-161, DUN-031, DUN-058, MISC-10) as the signed-in owner: the cockpit and its Vorschau, „Ausgewählte
 * jetzt ausführen“ (drafts), the reminder draft → Fertigstellen → PDF export → „Als versendet markieren“ from „Zu
 * versenden“, the invoice tab „Mahnungen“ and Einstellungen › Mahnwesen; axe on every page. Needs the backend journey
 * and runs after e2e/rechnungen.spec.ts (contact „Muster Handwerk GmbH“). The run path additionally needs the IS_TEST
 * fixture `testFixtures.backdateInvoice` and is skipped without it.
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-dunning.json`;
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
test.describe.configure({ mode: "serial", timeout: 300_000 });

const h1 = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name });

async function selectByText(select: Locator, text: string): Promise<void> {
  const option = select.locator("option", { hasText: text }).first();
  await expect(option).toBeAttached({ timeout: 20_000 });
  await select.selectOption((await option.getAttribute("value")) ?? "");
}

/** A finalised 119,00 € invoice for „Muster Handwerk GmbH“; returns its number and detail URL. */
async function finalisedInvoice(page: Page) {
  await page.goto("/rechnungen/neu");
  await expect(h1(page, "Neue Rechnung")).toBeVisible();
  await selectByText(page.getByRole("combobox", { name: "Kunde", exact: true }), "Muster Handwerk GmbH");
  await expect(page.getByTestId("buyer")).toContainText("Muster Handwerk GmbH");
  await page.getByLabel("Bezeichnung (Pos. 1)").fill("Beratung Mahnwesen");
  await page.getByLabel("Menge").first().fill("1");
  await page.getByLabel("Einzelpreis").first().fill("100");
  await expect(page.getByTestId("gross")).toHaveText("119,00 €", { timeout: 20_000 });
  await page.getByRole("button", { name: "Entwurf speichern" }).click();
  await expect(page).toHaveURL(/\/rechnungen\/[a-z0-9]+$/, { timeout: 30_000 });
  await expect(page.getByTestId("compliance").getByRole("status")).toHaveText(/Bereit zum Fertigstellen/, {
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Fertigstellen" }).click();
  const dialog = page.getByRole("dialog", { name: "Rechnung fertigstellen?" });
  await dialog.getByRole("button", { name: "Jetzt fertigstellen" }).click();
  await expect(h1(page, /^Rechnung \S+$/)).toBeVisible({ timeout: 60_000 });
  const number = ((await h1(page, /^Rechnung /).textContent()) ?? "").replace("Rechnung ", "").trim();
  return { number, url: page.url() };
}

/** „Als versendet markieren“ on the invoice (PAY-064: without a Zugang the invoice is never dunned). */
async function markInvoiceSent(page: Page) {
  await expect(page.getByRole("button", { name: "Exportieren" })).toBeEnabled({ timeout: 90_000 });
  await page.getByRole("button", { name: "Als versendet markieren" }).click();
  const mark = page.getByRole("dialog", { name: "Als versendet markieren" });
  await mark.getByRole("button", { name: "Markieren" }).click();
  await expect(mark).toBeHidden({ timeout: 20_000 });
}

/** Confirms the ⚑ warning dialog (WARNINGS_UNACKNOWLEDGED) if the backend asked for it. */
async function acknowledgeIfAsked(page: Page, confirmLabel: string) {
  const warning = page.getByRole("dialog", { name: "Hinweis bestätigen" });
  // The ⚑ dialog appears only after the mutation round-trip (`isVisible` would not wait).
  const appeared = await warning.waitFor({ state: "visible", timeout: 5_000 }).then(
    () => true,
    () => false,
  );
  if (appeared) {
    await expect(warning.getByTestId("dunning-warning")).toBeVisible();
    await warning.getByRole("button", { name: confirmLabel }).click();
    await expect(warning).toBeHidden({ timeout: 20_000 });
  }
}

/** Fertigstellen on the reminder draft; returns the reminder number. */
async function finaliseReminder(page: Page, expectNoAxeViolations: () => Promise<void>) {
  await expect(h1(page, /^Mahnentwurf Stufe \d+$/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("reminder-editor")).toBeVisible();
  await expect(page.getByTestId("reminder-compliance")).toBeVisible();
  await expectNoAxeViolations();
  await page.getByRole("button", { name: "Fertigstellen" }).click();
  const confirm = page.getByRole("dialog", { name: "Mahnung fertigstellen?" });
  await expect(confirm).toContainText("Die App verschickt nichts");
  await confirm.getByRole("button", { name: "Jetzt fertigstellen" }).click();
  await acknowledgeIfAsked(page, "Trotzdem fertigstellen");
  await expect(h1(page, /^Mahnung \S+$/)).toBeVisible({ timeout: 60_000 });
  return ((await h1(page, /^Mahnung /).textContent()) ?? "").replace("Mahnung ", "").trim();
}

/** PDF export of the finalised reminder (archived bytes, DUN-004). */
async function exportReminderPdf(page: Page) {
  const exportButton = page.getByTestId("reminder-export").filter({ visible: true }).first();
  await expect(exportButton).toBeEnabled({ timeout: 90_000 });
  await exportButton.click();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "PDF" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
  await page.keyboard.press("Escape");
}

/** „Als versendet markieren“ from the cockpit tab „Zu versenden“ (DUN-058); the reminder moves to „Versendet“. */
async function markFromToSend(page: Page, reminderNumber: string, expectNoAxeViolations: () => Promise<void>) {
  await page.goto("/mahnungen?tab=zu-versenden");
  await expect(page.getByRole("tab", { name: /Zu versenden/, selected: true })).toBeVisible({ timeout: 20_000 });
  const row = page
    .getByTestId("reminders-toSend")
    .locator("[data-row]")
    .filter({ hasText: reminderNumber })
    .filter({ visible: true })
    .first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expectNoAxeViolations();
  await expect(row.getByTestId("reminder-mark-sent")).toBeEnabled({ timeout: 90_000 });
  await row.getByTestId("reminder-mark-sent").click();
  const mark = page.getByRole("dialog", { name: `Mahnung ${reminderNumber} als versendet markieren` });
  await expect(mark.getByLabel("Kanal")).toHaveValue("email_manual");
  // Marked on its document date: no DUN-056 late-mark warning.
  await expect(mark.getByTestId("late-mark-warning")).toHaveCount(0);
  await expectNoAxeViolations();
  await mark.getByRole("button", { name: "Als versendet markieren" }).click();
  await expect(mark).toBeHidden({ timeout: 20_000 });

  await page.goto("/mahnungen?tab=versendet");
  await expect(
    page
      .getByTestId("reminders-sent")
      .locator("[data-row]")
      .filter({ hasText: reminderNumber })
      .filter({ visible: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expectNoAxeViolations();
}

test("DUN-008 DUN-010 DUN-004 DUN-058 manual reminder: create, finalise, export the PDF, mark sent from „Zu versenden“", async ({
  page,
  expectNoAxeViolations,
}) => {
  const { url } = await finalisedInvoice(page);
  await markInvoiceSent(page);

  // DUN-010: the invoice tab „Mahnungen“ (case, default start, reminders, next action).
  const section = page.getByTestId("invoice-dunning");
  await expect(section).toBeVisible({ timeout: 20_000 });
  await expect(section).toContainText("Noch keine Mahnungen zu dieser Rechnung.");
  await expectNoAxeViolations();
  await section.getByTestId("create-reminder").click();
  await acknowledgeIfAsked(page, "Trotzdem erstellen");
  await expect(page).toHaveURL(/\/mahnungen\/[a-z0-9]+$/, { timeout: 30_000 });

  const reminderNumber = await finaliseReminder(page, expectNoAxeViolations);
  await expect(page.getByText("Unveränderbar")).toBeVisible();
  await expectNoAxeViolations();
  await exportReminderPdf(page);

  await markFromToSend(page, reminderNumber, expectNoAxeViolations);

  // Back on the invoice: the chain lists the reminder with its dispatch status.
  await page.goto(url);
  await expect(page.getByTestId("invoice-reminders")).toContainText(reminderNumber, { timeout: 20_000 });
  await expect(page.getByTestId("invoice-reminders")).toContainText("versendet am");
  await expect(page.getByTestId("invoice-dunning")).toContainText("Mahnverfahren aktiv");
  await expectNoAxeViolations();
});

test("DUN-031 DUN-030 Vorschau → „Ausgewählte jetzt ausführen“ creates the draft, which is finalised and marked sent", async ({
  page,
  expectNoAxeViolations,
}) => {
  const { number } = await finalisedInvoice(page);
  await markInvoiceSent(page);
  // Due 10 days ago, sent before: level 1 (7 days after due) is planned by the run.
  test.skip(!(await backdateTestInvoice(number, 10)), "needs the IS_TEST fixture testFixtures.backdateInvoice");

  await page.goto("/mahnungen");
  await expect(h1(page, "Mahnungen")).toBeVisible();
  await expect(page.getByRole("tab", { name: /Vorschau/, selected: true })).toBeVisible();
  const preview = page.getByTestId("dunning-preview");
  await expect(preview).toBeVisible({ timeout: 30_000 });
  await expectNoAxeViolations();

  // Select only our invoice (other journeys may have planned actions too).
  const boxes = preview.getByRole("checkbox");
  await expect(preview.getByRole("checkbox", { name: `${number} auswählen` })).toBeVisible({ timeout: 30_000 });
  for (const box of await boxes.all()) {
    const label = (await box.getAttribute("aria-label")) ?? "";
    if (label !== `${number} auswählen` && (await box.isChecked())) await box.uncheck();
  }
  await expect(preview.getByRole("checkbox", { name: `${number} auswählen` })).toBeChecked();
  await expect(preview.getByText("1 Rechnung ausgewählt")).toBeVisible();

  await page.getByTestId("run-selected").click();
  const dialog = page.getByRole("dialog", { name: "Ausgewählte jetzt ausführen?" });
  await expect(dialog.getByTestId("run-summary")).toContainText("1 Mahnentwurf wird erstellt", { timeout: 20_000 });
  await expect(dialog).not.toContainText(/\bsenden\b/);
  const draftsOnly = dialog.getByRole("radio", { name: "Nur Entwürfe erstellen" });
  if (await draftsOnly.count()) await draftsOnly.check();
  await expectNoAxeViolations();
  await dialog.getByRole("button", { name: "Jetzt ausführen" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(page.getByText(/1 Entwurf erstellt/)).toBeVisible({ timeout: 20_000 });

  await page.goto("/mahnungen?tab=entwuerfe");
  const draftRow = page
    .getByTestId("reminders-drafts")
    .locator("[data-row]")
    .filter({ hasText: number })
    .filter({ visible: true })
    .first();
  await expect(draftRow).toBeVisible({ timeout: 30_000 });
  await expect(draftRow).toContainText("Mahnlauf");
  await expectNoAxeViolations();
  await draftRow.getByRole("link", { name: /^Entwurf Stufe/ }).click();

  const reminderNumber = await finaliseReminder(page, expectNoAxeViolations);
  await exportReminderPdf(page);
  await markFromToSend(page, reminderNumber, expectNoAxeViolations);

  await page.goto("/mahnungen?tab=laeufe");
  await expect(page.getByTestId("runs").locator("[data-row]").filter({ visible: true }).first()).toContainText(
    "Manuell",
    { timeout: 20_000 },
  );
  await expectNoAxeViolations();
});

test("DUN-022 the Verzugszinsrechner shows the segments", async ({ page, expectNoAxeViolations }) => {
  await page.goto("/mahnungen");
  await expect(h1(page, "Mahnungen")).toBeVisible();
  await page.getByRole("button", { name: "Verzugszinsrechner" }).click();
  const sheet = page.getByRole("dialog", { name: "Verzugszinsrechner" });
  await sheet.getByLabel("Betrag (€)").fill("1.000,00");
  await sheet.getByLabel("Zinsbeginn").fill("2026-01-01");
  await sheet.getByLabel("Zinsende").fill("2026-03-31");
  await expect(sheet.getByTestId("interest-total")).toContainText("Verzugszinsen:", { timeout: 20_000 });
  await expect(sheet.getByTestId("interest-segments")).toBeVisible();
  await expectNoAxeViolations();
});

test("DUN-001 Einstellungen › Mahnwesen lists the policies and the global switches", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/einstellungen/mahnwesen");
  await expect(h1(page, "Mahnwesen")).toBeVisible();
  const policies = page.getByTestId("dunning-policies");
  await expect(policies).toBeVisible({ timeout: 20_000 });
  await expect(policies).toContainText("Standard B2B");
  await expect(policies).toContainText("Standard B2C");
  await expect(page.getByTestId("dunning-global")).toContainText("Mahnungen automatisch fertigstellen (versendet nie)");
  await expect(page.getByLabel("Zugangsfiktion Post (Tage)")).toBeVisible();
  await expectNoAxeViolations();

  await page.goto("/mahnungen");
  await page.getByRole("main").getByRole("link", { name: "Einstellungen", exact: true }).click();
  await expect(page).toHaveURL(/\/einstellungen\/mahnwesen$/);
});
