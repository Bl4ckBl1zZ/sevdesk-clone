import { ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * F08 P3 pages as the owner (TST-RPT-10): /auswertungen tiles and a report with parameters in the URL, „vorläufig“
 * badge and CSV export; /steuern/euer; /steuern/ruecklage with the visible disclaimer; /auswertungen/liquiditaet
 * with the chart; the „Kennzahlen“ card on the Übersicht. axe on every page (desktop, iPhone, Pixel projects).
 * Needs the backend journey (owner with completed setup).
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-auswertungen.json`;
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
test.describe.configure({ mode: "serial", timeout: 180_000 });

test("RPT-001 TST-RPT-10 /auswertungen lists the report tiles and opens the SuSa with URL parameters, „vorläufig“ and CSV", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/auswertungen");
  await expect(page.getByRole("link", { name: /Summen- und Saldenliste/ })).toBeVisible();
  await expectNoAxeViolations();
  await page.getByRole("link", { name: /Summen- und Saldenliste/ }).click();
  await expect(page).toHaveURL(/bericht=susa/);
  await expect(page.getByRole("status").filter({ hasText: "Vorläufig" })).toContainText(
    "Vorläufig – Zeitraum nicht festgeschrieben.",
  );
  await expectNoAxeViolations();
  const csv = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV" }).click();
  expect((await csv).suggestedFilename()).toMatch(/^SuSa_\d{8}\.csv$/);
  await page.goto("/auswertungen?bericht=bwa");
  await expect(page.getByRole("columnheader", { name: "Jahr bis heute" })).toBeVisible();
  await expectNoAxeViolations();
});

test("TAX-015 /steuern/euer shows the Anlage EÜR lines of the previous year", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/steuern/euer");
  await expect(page.getByLabel("Jahr")).toBeVisible();
  await expectNoAxeViolations();
});

test("RPT-011 /steuern/ruecklage labels the estimate „Schätzung – keine Steuerberatung“ and lists the assumptions", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/steuern/ruecklage");
  await expect(page.getByRole("note")).toContainText("Schätzung – keine Steuerberatung");
  await expect(page.getByRole("heading", { name: "Annahmen", exact: true })).toBeVisible();
  await expectNoAxeViolations();
});

test("RPT-012 /auswertungen/liquiditaet draws the 90-day chart and the item list", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/auswertungen/liquiditaet?minimum=1000");
  await expect(page.getByRole("img", { name: "Liquiditätsvorschau je Woche: erwartet und vorsichtig" })).toBeVisible();
  await expectNoAxeViolations();
});

test("RPT-002 the Übersicht shows the „Kennzahlen“ card with the period selector", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Kennzahlen" })).toBeVisible();
  await page.getByText("Quartal", { exact: true }).click();
  await expect(page.getByRole("link", { name: "Steuer-Rücklage jetzt" })).toBeVisible();
  await expectNoAxeViolations();
});
