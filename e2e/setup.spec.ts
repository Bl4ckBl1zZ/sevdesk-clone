import { ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * Setup wizard pages (F01 §6.2) as the signed-in owner after the journey completed the setup: every step renders
 * accessibly with the stored data and validation still blocks „Weiter“. The first-run flow itself (mandatory
 * passkey, resume, completion) is e2e/00-journey.spec.ts.
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-setup.json`;
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

const STEPS: [slug: string, heading: string][] = [
  ["inhaberkonto", "Inhaberkonto"],
  ["zugriff", "Adressen & Zugriff"],
  ["e-mail", "E-Mail-Versand"],
  ["speicher", "Speicher"],
  ["start", "Start"],
  ["unternehmen", "Unternehmen"],
  ["steuern", "Steuern"],
  ["bank", "Bank"],
  ["layout", "Layout"],
  ["nummernkreise", "Nummernkreise"],
  ["fertig", "Fertig"],
];

test("MISC-10 every wizard step renders in F01 order without axe violations", async ({
  page,
  expectNoAxeViolations,
}) => {
  for (const [i, [slug, heading]] of STEPS.entries()) {
    await page.goto(`/einrichtung?schritt=${slug}`);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(`Schritt ${i + 1} von 11`).first()).toBeAttached();
    // Wait for the stored data (e.g. the owner's passkeys enable „Weiter“) so axe sees the final state.
    if (slug === "fertig") await expect(page.getByText("Alle Pflichtangaben sind vollständig.")).toBeVisible();
    else await expect(page.getByRole("button", { name: "Weiter", exact: true })).toBeEnabled();
    await expectNoAxeViolations();
  }
});

test("SET-015 the company step blocks Weiter with linked German errors", async ({ page }) => {
  await page.goto("/einrichtung?schritt=unternehmen");
  const name = page.getByLabel(/Firma bzw\. vollständiger Name/);
  await expect(name).not.toHaveValue("", { timeout: 20_000 });
  await name.fill("");
  await page.getByRole("button", { name: "Weiter", exact: true }).click();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toBeFocused();
  await expect(page.getByText("Bitte den Namen des Unternehmens angeben.")).toBeVisible();
  await expect(page).toHaveURL(/schritt=unternehmen$/);
});
