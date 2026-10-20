import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * sevdesk file-export import (F09 P1, TST-IMP-16 through the UI): upload a synthetic export set in the layout of real
 * sevdesk exports (test/fixtures/sevdesk-export-verified: double-BOM contacts, the invoice list without type/status/tax
 * columns, the part list, PDFs named like sevdesk's ZIP), check the detected kinds, build the preview, exclude blocked
 * rows, confirm the number-range continuation, commit as owner. Needs the backend journey (owner with completed setup),
 * like e2e/kontoauszug-bank.spec.ts. The wizard targets the desktop; phones show the read-only hint (F09 §6), so the
 * commit flow runs on the desktop project only. The open fixture invoice would become an F08 opening receivable
 * (IMP-007), which needs a Buchungsbeginn; the journey has none (and can no longer set one), so it is excluded; 0 %
 * articles are ambiguous unless the company is Kleinunternehmer today (EC-202) and are excluded too. IMP-007 and
 * EC-202 are covered in convex/imports.test.ts.
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-sevdesk-import.json`;
const FIXTURES = join(import.meta.dirname, "../test/fixtures/sevdesk-export-verified");
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
/**
 * The sevdesk wizard's „Vorschau erstellen“. The generic CSV card below it on /einstellungen/import has its own
 * button of the same name while a CSV session is shown (verwaltung-csv-import.spec.ts, shared backend); the sevdesk card
 * comes first in the page.
 */
const sevdeskPreview = (page: Page) => page.getByRole("button", { name: "Vorschau erstellen" }).first();

test("IMP-016 IMP-023 the import page explains the steps; phones get the desktop hint", async ({
  page,
  expectNoAxeViolations,
}, testInfo) => {
  await page.goto("/einstellungen/import");
  await expect(h1(page, "Import")).toBeVisible();
  await expect(page.getByRole("heading", { name: "So gehen Sie vor" })).toBeVisible();
  const hint = page.getByTestId("desktop-hint");
  if (testInfo.project.name === "desktop") await expect(hint).toBeHidden();
  else await expect(hint).toBeVisible();
  await expectNoAxeViolations();
});

test("TST-IMP-16 IMP-009 IMP-019 upload, preview with per-row errors, resolve, commit", async ({
  page,
  expectNoAxeViolations,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the import wizard is a desktop flow (F09 §6)");
  test.setTimeout(240_000); // upload, then one preview per resolved row
  await page.goto("/einstellungen/import");
  // Until `create` resolves, an earlier unfinished project (previous runs on the same backend) is still open: wait
  // until the new project (newest first) is listed and opened before uploading.
  const projects = page.getByRole("region", { name: "Importe" }).getByRole("listitem");
  await expect(page.getByRole("region", { name: "Importe" }).locator("[aria-busy]")).toHaveCount(0);
  const before = await projects.count();
  await page.getByRole("button", { name: "sevdesk-Exporte importieren" }).click();
  await expect(projects).toHaveCount(before + 1, { timeout: 30_000 });
  await expect(projects.first().getByRole("button", { name: "Öffnen" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "1. Dateien hochladen" })).toBeVisible();
  await expect(page.getByText("Noch keine Dateien hochgeladen.")).toBeVisible();

  const pdfs = readdirSync(join(FIXTURES, "pdf")).map((n) => join(FIXTURES, "pdf", n));
  await page
    .getByLabel("Dateien auswählen")
    .setInputFiles([
      join(FIXTURES, "contacts.csv"),
      join(FIXTURES, "18-10-2026_part.csv"),
      join(FIXTURES, "invoices.csv"),
      ...pdfs,
    ]);
  await expect(page.getByLabel("Dateiart: invoices.csv")).toHaveValue("invoices", { timeout: 30_000 });
  await expect(page.getByLabel("Dateiart: contacts.csv")).toHaveValue("contacts");
  await expect(page.getByLabel("Dateiart: 18-10-2026_part.csv")).toHaveValue("products");
  await expect(page.getByRole("heading", { name: "2. Spaltenzuordnung: invoices.csv" })).toBeVisible();
  await expectNoAxeViolations();

  await sevdeskPreview(page).click();
  const counts = page.getByTestId("preview-counts");
  await expect(counts).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Import übernehmen" })).toBeDisabled();

  // Excluding a row invalidates the preview (F09 §5), so every exclusion is followed by a new preview.
  const stale = page.getByText("Dateien oder Zuordnung wurden geändert – bitte die Vorschau neu erstellen.");
  const excludeAndPreview = async (row: ReturnType<Page["getByRole"]>) => {
    await row.getByRole("button", { name: "Zeile ausschließen" }).click();
    await expect(stale).toBeVisible({ timeout: 30_000 });
    await sevdeskPreview(page).click();
    await expect(stale).toBeHidden({ timeout: 30_000 });
    await expect(counts).toBeVisible({ timeout: 30_000 });
  };

  // The journey posts the opening cash balance without a Buchungsbeginn, which freezes it (E-ACC-14). The open fixture
  // invoice is therefore blocked as an opening item (E-IMP-34, or E-IMP-10/35 on other accounts); 0 % articles are
  // ambiguous outside the Kleinunternehmer regime (E-IMP-16): exclude them.
  // The error filter is active: every row with an exclude button is an error row. Cell texts run together („E-IMP-16“
  // + „18-10-2026_part.csv:2“), so the code is checked without a digit look-ahead.
  const blocked = page
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: "Zeile ausschließen" }) })
    .filter({ hasText: /E-IMP-(10|16|34|35)/ });
  const errors = page.getByRole("button", { name: /^Fehler \(\d+\)/ });
  await expect(errors).toBeVisible({ timeout: 30_000 });
  for (let n = Number(/\((\d+)\)/.exec(await errors.innerText())?.[1]); n > 0; n--) {
    await expect(blocked.first()).toBeVisible({ timeout: 30_000 });
    await excludeAndPreview(blocked.first());
    await expect(errors).toHaveText(new RegExp(`^Fehler \\(${n - 1}\\)`), { timeout: 30_000 });
  }

  await expect(page.getByRole("button", { name: /^Fehler \(0\)/ })).toBeVisible({ timeout: 30_000 });
  await expectNoAxeViolations();

  const missing = page.getByLabel("Ohne Original-PDF übernehmen");
  if (await missing.isVisible()) {
    await missing.check();
    await page.getByLabel("Begründung").fill("PDF in sevdesk nicht mehr vorhanden");
  }
  await expect(page.getByLabel("Nummernkreis Rechnungen fortsetzen")).toBeChecked();
  await page.getByRole("button", { name: "Import übernehmen" }).click();
  await expect(page.getByText(/^Import übernommen:/).first()).toBeVisible({ timeout: 60_000 });

  await page.goto("/rechnungen");
  await expect(page.getByRole("link", { name: /RE-5000/ }).first()).toBeVisible();
});
