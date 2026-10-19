import type { Page } from "@playwright/test";
import { ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * Ausgaben/Belege (F06 P2) as the signed-in owner: upload a PDF → the draft editor → fill supplier, number, date
 * and one line → save → check panel → „Buchen“ with „Bezahlt mit: Privat“ → paid voucher with BE-number, payment
 * and Buchungen; the batch queue over two drafts (VOU-100); „Fehlende Belege“ and „Wiederkehrende Belege“ render.
 * Needs the backend journey (owner with completed setup); desktop and phone layouts (reducedMotion is on).
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-belege.json`;
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
test.describe.configure({ mode: "serial", timeout: 240_000 });

const h1 = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name });
const todayBerlin = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date());

/** A tiny synthetic PDF; `seed` keeps the SHA-256 unique per run (identical files are duplicates, VOU-050). */
const pdf = (seed: string) =>
  Buffer.from(`%PDF-1.4\n1 0 obj <</Type /Page>> endobj\n% SYNTHETIC TEST DATA ${seed}\n%%EOF\n`, "utf8");

async function uploadDraft(page: Page, seed: string): Promise<string> {
  await page.goto("/belege");
  await expect(h1(page, "Belege")).toBeVisible();
  await page.getByTestId("voucher-file-input").setInputFiles({
    name: `rechnung-${seed}.pdf`,
    mimeType: "application/pdf",
    buffer: pdf(`${seed}-${Date.now()}`),
  });
  await expect(h1(page, "Belegentwurf")).toBeVisible({ timeout: 30_000 });
  return page.url();
}

async function fillDraft(page: Page, opts: { supplier: string; number: string; amount: string }) {
  await page.getByTestId("voucher-supplier").fill(opts.supplier);
  await page.getByTestId("voucher-document-number").fill(opts.number);
  await page.getByTestId("voucher-document-date").fill(todayBerlin());
  // An expense account, not the first option: „0027 – EDV-Software“ is an asset account, which needs the
  // GWG/Anlage decision (asset_decision_required) before „Buchen“ unlocks.
  const account = page.getByTestId("line-0-account");
  const office = account.locator("option", { hasText: "Bürobedarf" }).first();
  await expect(office).toBeAttached({ timeout: 20_000 });
  await account.selectOption((await office.getAttribute("value")) ?? "");
  await page.getByTestId("line-0-amount").fill(opts.amount);
  await page.getByTestId("line-0-rate").fill("19");
  await page.getByTestId("voucher-save").click();
  await expect(page.getByText("Entwurf gespeichert")).toBeVisible({ timeout: 20_000 });
}

test("VOU-120 VOU-001 VOU-007 VOU-138 upload → draft → Buchen with „Privat bezahlt“", async ({
  page,
  expectNoAxeViolations,
}) => {
  await uploadDraft(page, "privat");
  await expect(page.getByTestId("voucher-files")).toContainText("SHA-256");
  await fillDraft(page, { supplier: "Bürobedarf Beispiel GmbH", number: `E2E-${Date.now()}`, amount: "119,00" });
  await expect(page.getByTestId("voucher-totals")).toContainText("119,00 €", { timeout: 20_000 });
  await expectNoAxeViolations();

  await page.getByTestId("voucher-book").click();
  const dialog = page.getByRole("dialog", { name: "Beleg buchen" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: "Privat bezahlt" }).check();
  await expect(dialog.getByTestId("journal-preview")).toBeVisible({ timeout: 20_000 });
  const ack = dialog.getByTestId("ack-warnings");
  if (await ack.isVisible()) await ack.check();
  await dialog.getByRole("button", { name: "Buchen – privat bezahlt" }).click();

  await expect(h1(page, /^Beleg BE-\d{4}-\d{5}$/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("voucher-payments")).toContainText("119,00 €");
  await expect(page.getByTestId("voucher-journal")).toContainText("#");
  await expectNoAxeViolations();
});

test("VOU-100 the batch queue books two drafts one after the other", async ({ page }) => {
  // Unique per run: on phones the drafts stay unbooked, and the backend is shared between runs.
  const run = Date.now().toString(36);
  for (const seed of ["queue-a", "queue-b"]) {
    await uploadDraft(page, seed);
    await fillDraft(page, { supplier: `Queue ${seed} ${run}`, number: `Q-${seed}-${run}`, amount: "23,80" });
  }
  await page.goto("/belege?status=draft");
  // Both drafts are listed (table cell on desktop, card link on phones).
  const names = new RegExp(`^Queue queue-[ab] ${run}$`);
  await expect(page.getByText(names).filter({ visible: true })).toHaveCount(2, { timeout: 20_000 });
  // Phones show cards without checkboxes (the table is display:none, so its checkboxes are not in the
  // accessibility tree); the queue is a desktop workflow (keyboard).
  const boxes = page.getByRole("checkbox", { name: new RegExp(`Queue queue-[ab] ${run}`) });
  if ((await boxes.count()) === 0) return;
  await expect(boxes).toHaveCount(2);
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await page.getByTestId("open-queue").click();
  await expect(page.getByTestId("queue-progress")).toContainText("1 von 2");
  for (let i = 0; i < 2; i++) {
    await page.getByTestId("voucher-book").click();
    const dialog = page.getByRole("dialog", { name: "Beleg buchen" });
    const ack = dialog.getByTestId("ack-warnings");
    if (await ack.isVisible()) await ack.check();
    await dialog.getByRole("button", { name: "Buchen", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });
  }
  await expect(page.getByTestId("queue-finished")).toBeVisible({ timeout: 30_000 });
});

test("VOU-110 VOU-064 Fehlende Belege and Wiederkehrende Belege", async ({ page, expectNoAxeViolations }) => {
  await page.goto("/belege/fehlend");
  await expect(h1(page, "Fehlende Belege")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Fehlende Belege" })).toBeVisible();
  await expectNoAxeViolations();

  await page.goto("/belege/wiederkehrend");
  await expect(h1(page, "Wiederkehrende Belege")).toBeVisible();
  await page.getByTestId("recurring-new").click();
  const dialog = page.getByRole("dialog", { name: "Neue Vorlage" });
  await dialog.getByLabel("Name").fill(`Miete E2E ${Date.now()}`);
  await dialog.getByLabel("Lieferant").fill("Immobilien Beispiel");
  const account = dialog.getByLabel("Konto");
  await expect(account.locator("option").nth(1)).toBeAttached({ timeout: 20_000 });
  await account.selectOption({ index: 1 });
  await dialog.getByLabel("Betrag brutto").fill("500,00");
  await dialog.getByLabel("USt %").fill("0");
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Vorlage angelegt")).toBeVisible({ timeout: 20_000 });
  await expectNoAxeViolations();
});
