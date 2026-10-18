import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * sevdesk file-export import (F09 P1, TST-IMP-16 through the UI): upload the synthetic export set
 * (test/fixtures/sevdesk-export), check the detected kinds, build the preview, resolve the ambiguous PDF (E-IMP-22),
 * confirm the missing-PDF reason (E-IMP-07) and the number-range continuation, commit as owner. Needs the backend
 * journey (owner with completed setup), like e2e/kontoauszug-bank.spec.ts. The wizard targets the desktop; phones
 * show the read-only hint (F09 §6), so the commit flow runs on the desktop project only.
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-sevdesk-import.json`;
const FIXTURES = join(import.meta.dirname, "../test/fixtures/sevdesk-export");
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
  await page.goto("/einstellungen/import");
  await page.getByRole("button", { name: "sevdesk-Exporte importieren" }).click();
  await expect(page.getByRole("heading", { name: "1. Dateien hochladen" })).toBeVisible();

  const pdfs = readdirSync(join(FIXTURES, "pdf")).map((n) => join(FIXTURES, "pdf", n));
  await page
    .getByLabel("Dateien auswählen")
    .setInputFiles([
      join(FIXTURES, "kontakte.csv"),
      join(FIXTURES, "artikel.csv"),
      join(FIXTURES, "rechnungen.csv"),
      ...pdfs,
    ]);
  await expect(page.getByLabel("Dateiart: rechnungen.csv")).toHaveValue("invoices", { timeout: 30_000 });
  await expect(page.getByLabel("Dateiart: kontakte.csv")).toHaveValue("contacts");
  await expect(page.getByRole("heading", { name: "2. Spaltenzuordnung: rechnungen.csv" })).toBeVisible();
  await expectNoAxeViolations();

  await page.getByRole("button", { name: "Vorschau erstellen" }).click();
  const counts = page.getByTestId("preview-counts");
  await expect(counts).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Import übernehmen" })).toBeDisabled();

  // E-IMP-22: one PDF names two invoices — assign it to the first, exclude the second row.
  const ambiguous = page.getByRole("row").filter({ hasText: "E-IMP-22" });
  await ambiguous.first().getByRole("combobox").selectOption({ label: "RE-1005_RE-1006.pdf" });
  await page.getByRole("button", { name: "Vorschau erstellen" }).click();
  await expect(counts).toBeVisible({ timeout: 30_000 });
  for (const row of await page.getByRole("row").filter({ hasText: "E-IMP-22" }).all()) {
    await row.getByRole("button", { name: "Zeile ausschließen" }).click();
  }
  await page.getByRole("button", { name: "Vorschau erstellen" }).click();
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
  await expect(page.getByRole("link", { name: /RE-1001/ }).first()).toBeVisible();
});
