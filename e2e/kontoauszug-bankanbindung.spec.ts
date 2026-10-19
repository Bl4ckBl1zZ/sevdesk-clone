import type { Page } from "@playwright/test";
import { ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * F07 P2 Bankanbindung and Bankregeln (SET-049/049a, BNK-101, BNK-050/051, BNK-065). Without an Enable Banking
 * application (the owner has none yet) the connection page shows the checklist with „Bank verbinden“ disabled; the
 * Enable Banking sandbox journey T07-150 needs real credentials and is not part of this spec. Needs the backend
 * journey (owner with completed setup), like e2e/kontoauszug-bank.spec.ts.
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-bankfeed.json`;
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

test("SET-049 BNK-101 the connection page shows the checklist; „Bank verbinden“ stays disabled without app ID and key", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/einstellungen/bank");
  await page.getByRole("link", { name: "Bankanbindung einrichten" }).click();
  await expect(h1(page, "Bankanbindung")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Einrichtung" })).toBeVisible();
  await expect(page.getByText(/\/einstellungen\/bank\/callback$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Bank verbinden" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Einrichtung speichern" })).toBeDisabled();
  await expectNoAxeViolations();
});

test("BNK-050 BNK-051 create a rule with live preview; it appears with mode badge", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/einstellungen/bank/regeln");
  await expect(h1(page, "Bankregeln")).toBeVisible();
  await expectNoAxeViolations();
  await page.getByRole("button", { name: "Neue Regel" }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Neue Regel" });
  await dialog.getByLabel("Name").fill("Kontoführung Revolut");
  await dialog.getByLabel("Verwendungszweck enthält").fill("plan fee");
  await expect(dialog.getByText(/Diese Regel würde \d+ Ums(atz|ätze) der letzten 90 Tage treffen/)).toBeVisible();
  await dialog.getByLabel("Sachkonto").fill("6855");
  // By role: getByLabel also matches the hidden native input that Base UI's checkbox renders next to it.
  await dialog.getByRole("checkbox", { name: "Kontoauszug genügt als Beleg" }).check();
  await expectNoAxeViolations();
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Regel angelegt.")).toBeVisible();
  await expect(page.getByText("Kontoführung Revolut")).toBeVisible();
  await expect(page.getByText("Vorschlag")).toBeVisible();
});

test("BNK-065 „+ Neuer Beleg“ on an open debit opens the prefilled voucher draft", async ({ page }) => {
  await page.goto("/bank");
  const account = page.getByRole("link", { name: /Revolut EUR/ });
  test.skip((await account.count()) === 0, "needs an imported bank account (kontoauszug-bank.spec.ts)");
  await account.first().click();
  const debit = page.getByRole("row").filter({ hasText: "−" }).filter({ hasText: "offen" }).first();
  test.skip((await debit.count()) === 0, "no open debit");
  await debit.click();
  await page.getByRole("button", { name: "+ Neuer Beleg" }).click();
  await expect(page).toHaveURL(/\/belege\/[a-z0-9]+/);
  await expect(page.getByText("Belegentwurf angelegt.")).toBeVisible();
});
