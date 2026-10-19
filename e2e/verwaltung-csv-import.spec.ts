import { ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * Generic CSV import for contacts and products (F09 IMP-012, TST-IMP-12 through the UI): upload a Windows-1252 `;`
 * contacts file with one invalid row on /einstellungen/import, check the detected encoding, the automatic mapping and
 * the preview listing the invalid row, commit, then import the same file again — every row is skipped. Needs the
 * backend journey (owner with completed setup), like e2e/sevdesk-import.spec.ts; the mapping grid is a desktop flow,
 * so the commit runs on the desktop project only (phones check the card and axe).
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-generic-csv-import.json`;
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

/** Unique numbers per run: the journey backend is shared between runs. */
const RUN = Date.now().toString(36).toUpperCase();
const CONTACTS =
  "Kundennummer;Firma;Straße;PLZ;Ort;E-Mail\r\n" +
  `CSV-${RUN}-1;Bäckerei Müller ${RUN};Hauptstraße 1;10115;Berlin;mueller-${RUN}@example.test\r\n` +
  `CSV-${RUN}-2;;;;;\r\n` +
  `CSV-${RUN}-3;Schulz & Söhne ${RUN};Ring 2;20095;Hamburg;schulz-${RUN}@example.test\r\n`;
const cp1252 = (text: string) => Buffer.from([...text].map((ch) => ch.charCodeAt(0)));

test("IMP-012 the CSV import card is reachable on every device", async ({ page, expectNoAxeViolations }) => {
  await page.goto("/einstellungen/import");
  const card = page.getByTestId("generic-csv-import");
  await expect(card.getByRole("heading", { name: "CSV-Import (Kontakte/Produkte)" })).toBeVisible();
  // The first „Importieren als“ is the card's own select; an open mapping session (left by an interrupted run on
  // the shared backend) has a second one in its region.
  await expect(card.getByLabel("Importieren als").first()).toHaveValue("contacts");
  await expectNoAxeViolations();
});

test("IMP-012 TST-IMP-12 Windows-1252 contacts: preview lists the invalid row, commit creates the rest, re-import skips", async ({
  page,
  expectNoAxeViolations,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the mapping grid is a desktop flow (F09 §6)");
  test.setTimeout(180_000);
  await page.goto("/einstellungen/import");
  const card = page.getByTestId("generic-csv-import");
  await card.getByLabel("Importieren als").first().selectOption("contacts");
  await card
    .getByLabel("CSV-Datei wählen")
    .setInputFiles({ name: `kontakte-${RUN}.csv`, mimeType: "text/csv", buffer: cp1252(CONTACTS) });
  await expect(card.getByRole("heading", { name: `Spaltenzuordnung: kontakte-${RUN}.csv` })).toBeVisible({
    timeout: 30_000,
  });
  await expect(card.getByText("3 Zeilen · Kodierung windows-1252 · Trennzeichen „;“")).toBeVisible();
  await expect(card.getByLabel("Spalte in der Datei: Firma")).toHaveValue("Firma");
  await card.getByLabel("Name der Vorlage").fill(`E2E ${RUN}`);
  await card.getByLabel("Als Vorlage speichern").check();
  await card.getByRole("button", { name: "Zuordnung speichern" }).click();
  // Saving the mapping bumps the import revision and drops any preview; a preview requested before the save
  // landed is discarded again („Noch keine Vorschau“), so wait for the confirmation first.
  await expect(page.getByText("Zuordnung gespeichert").first()).toBeVisible({ timeout: 20_000 });
  await card.getByRole("button", { name: "Vorschau erstellen" }).click();
  const counts = card.getByTestId("generic-import-counts");
  await expect(counts).toContainText("Neu2", { timeout: 30_000 });
  await expect(counts).toContainText("Fehler1");
  await expect(card.getByRole("cell", { name: "3", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Fehler-CSV herunterladen" })).toBeVisible();
  await expectNoAxeViolations();

  await card.getByRole("button", { name: "2 Datensätze übernehmen" }).click();
  await expect(card.getByTestId("generic-import-done")).toContainText("2 angelegt", { timeout: 60_000 });

  // The same file again: the saved preset applies and every row is already imported.
  await card
    .getByLabel("CSV-Datei wählen")
    .setInputFiles({ name: `kontakte-${RUN}-2.csv`, mimeType: "text/csv", buffer: cp1252(CONTACTS) });
  await expect(card.getByRole("heading", { name: `Spaltenzuordnung: kontakte-${RUN}-2.csv` })).toBeVisible({
    timeout: 30_000,
  });
  await expect(card.getByLabel("Name der Vorlage")).toHaveValue(`E2E ${RUN}`);
  await card.getByRole("button", { name: "Vorschau erstellen" }).click();
  await expect(counts).toContainText("Bereits importiert2", { timeout: 30_000 });
  await expect(counts).toContainText("Neu0");
  await card.getByRole("button", { name: "Verwerfen" }).click();
});
