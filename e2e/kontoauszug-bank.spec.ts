import { join } from "node:path";
import type { Page } from "@playwright/test";
import { ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * Bank statement import (F07 P1, T07-151 with the synthetic month until the owner's anonymised Revolut month is
 * dropped into test/fixtures/bank/revolut-statements/): create the EUR pocket account, import the CAMT.053 with the
 * signed PDF, import the Revolut CSV of the same month (all rows detected as already present), the statement is
 * reconciled, one transaction is marked „Privat“. Kasse page shows the no-POS banner. Needs the backend journey
 * (owner with completed setup), like e2e/kontakte-produkte.spec.ts.
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-bank.json`;
const FIXTURES = join(import.meta.dirname, "../test/fixtures/bank/revolut-statements/synthetic-2026-10");
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

const h1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name });

async function importStatement(page: Page, file: string, opts: { pdf?: string; expectNew: number }) {
  await page.getByRole("button", { name: "Kontoauszug importieren" }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Kontoauszug importieren" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Konto", { exact: true }).selectOption({ label: "Revolut EUR (EUR)" });
  await dialog.getByLabel("Kontoauszugsdatei").setInputFiles(join(FIXTURES, file));
  if (opts.pdf)
    await dialog.getByLabel("Signierter PDF-Kontoauszug (optional)").setInputFiles(join(FIXTURES, opts.pdf));
  await dialog.getByRole("button", { name: "Vorschau" }).click();
  await expect(dialog.getByTestId("import-counts")).toContainText(`${opts.expectNew} neu`, { timeout: 30_000 });
}

test("T07-151 BNK-030 BNK-110 import CAMT.053 + PDF and the CSV of the same month; duplicates detected; reconciled", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/bank");
  await expect(h1(page, "Bank")).toBeVisible();
  await expectNoAxeViolations();

  await page.getByRole("button", { name: "Konto anlegen" }).click();
  const accountDialog = page.getByRole("dialog").filter({ hasText: "Bankkonto anlegen" });
  await accountDialog.getByRole("textbox", { name: "Name", exact: true }).fill("Revolut EUR");
  await accountDialog.getByRole("textbox", { name: "IBAN", exact: true }).fill("LT44 3250 0100 0000 0101");
  await accountDialog.getByLabel("Kontoinhaber").fill("Max Muster");
  await expectNoAxeViolations();
  await accountDialog.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("link", { name: /Revolut EUR/ })).toBeVisible();
  await expect(accountDialog).toBeHidden();

  await importStatement(page, "eur-2026-10.camt053.xml", { pdf: "eur-2026-10.statement.pdf", expectNew: 13 });
  const dialog = page.getByRole("dialog").filter({ hasText: "Kontoauszug importieren" });
  await expect(dialog.getByText("Anfangssaldo + Umsätze = Endsaldo")).toBeVisible();
  await expectNoAxeViolations();
  await dialog.getByRole("button", { name: "13 Umsätze importieren" }).click();
  await expect(page.getByText("13 Umsätze importiert.")).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toBeHidden();

  await importStatement(page, "eur-2026-10.csv", { expectNew: 0 });
  await expect(dialog.getByTestId("import-counts")).toContainText("13 bereits vorhanden");
  await dialog.getByRole("button", { name: "Importieren", exact: true }).click();
  await expect(page.getByText("Kontoauszug archiviert, keine neuen Umsätze.")).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toBeHidden();

  await page.getByRole("link", { name: /Revolut EUR/ }).click();
  await expect(h1(page, "Revolut EUR")).toBeVisible();
  await page.getByRole("tab", { name: "Kontoauszüge" }).click();
  await expect(page.getByText("abgestimmt", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("nicht abgestimmt")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /PDF-Kontoauszug: eur-2026-10.statement.pdf/ })).toBeVisible();
  await expectNoAxeViolations();
});

test("BNK-060 T07-090 a booked transaction is marked „Privat“ with an Eigenbeleg", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/bank");
  await page.getByRole("link", { name: /Revolut EUR/ }).click();
  await expect(h1(page, "Revolut EUR")).toBeVisible();
  await page.getByRole("searchbox", { name: "Umsätze durchsuchen" }).fill("Privatentnahme");
  await expect(page).toHaveURL(/q=Privatentnahme/);
  await page
    .getByRole("button", { name: /Max Muster/ })
    .filter({ visible: true })
    .first()
    .click();
  const sheet = page.getByRole("dialog").filter({ hasText: "Max Muster" });
  await expect(sheet).toBeVisible();
  await expectNoAxeViolations();
  await sheet.getByRole("button", { name: "Privat", exact: true }).click();
  const confirm = page.getByRole("dialog").filter({ hasText: "Als privat markieren" }).last();
  await expect(confirm.getByText("Wird als Privatentnahme gebucht.", { exact: false })).toBeVisible();
  await confirm.getByRole("button", { name: "Privat buchen" }).click();
  await expect(page.getByText("Umsatz markiert.")).toBeVisible({ timeout: 30_000 });
  await expect(sheet.getByText("Privatentnahme laut Kontoauszug")).toBeVisible();
  await expect(sheet.getByRole("link", { name: /^Eigenbeleg-2026-10-15/ })).toBeVisible();
  await expectNoAxeViolations();
});

test("CSH-029 CSH-020 the Kasse page shows the balance and the no-POS banner", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/kasse");
  await expect(h1(page, "Kasse")).toBeVisible();
  await expect(page.getByRole("note")).toContainText("Kein Kassensystem (keine Registrierkasse, keine TSE)");
  await expect(page.getByTestId("cash-balance")).toBeVisible();
  await expectNoAxeViolations();
  await page.getByRole("button", { name: "Bargeld eingezahlt / entnommen" }).click();
  await expect(page.getByRole("dialog").filter({ hasText: "Bargeld eingezahlt / entnommen" })).toBeVisible();
  await expectNoAxeViolations();
});
