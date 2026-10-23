import { ownerStorageState } from "./backend";
import { expect, test } from "./fixtures";

/**
 * App shell navigation (04-ui-ux §3) as the signed-in owner. Needs the backend and runs after e2e/00-journey.spec.ts
 * in the same project (single worker, files in order), which created the owner and completed the setup.
 */
const STATE = (project: string) => `test-results/.auth/owner-${project}-shell.json`;
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

test.describe("desktop shell", () => {
  test.skip(({ isMobile }) => isMobile, "desktop layout only");

  test("MISC-10 sidebar navigation reaches the list pages without axe violations", async ({
    page,
    expectNoAxeViolations,
  }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
    await expect(nav).toBeVisible();
    await expectNoAxeViolations();

    await nav.getByRole("link", { name: "Rechnungen" }).click();
    await expect(page).toHaveURL(/\/rechnungen$/);
    await expect(page.getByRole("heading", { level: 1, name: "Rechnungen" })).toBeFocused();
    await expect(nav.getByRole("link", { name: "Rechnungen" })).toHaveAttribute("aria-current", "page");
    // e2e/rechnungen.spec.ts runs before this file, so the list may already hold invoices (no empty state).
    await expect(page.getByRole("link", { name: "Neue Rechnung" })).toBeVisible();
    await expectNoAxeViolations();

    // NAV-002: an area opens its first page and only then shows its sub-items.
    await expect(nav.getByRole("link", { name: "UStVA" })).toHaveCount(0);
    await nav.getByRole("link", { name: "Steuern" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Umsatzsteuer-Voranmeldung" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "UStVA" })).toHaveAttribute("aria-current", "page");
    await expectNoAxeViolations();
  });

  test("SMOKE skip link moves focus to the main content", async ({ page }) => {
    await page.goto("/kontakte");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Zum Inhalt springen" });
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main$/);
  });

  test("SMOKE Ctrl+K opens the command palette and navigates", async ({ page, expectNoAxeViolations }) => {
    await page.goto("/");
    await page.keyboard.press("Control+k");
    const input = page.getByPlaceholder("Seite oder Aktion suchen …");
    await expect(input).toBeVisible();
    await expectNoAxeViolations();
    await input.fill("Kontakte");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/kontakte$/);
  });

  test("SMOKE shortcut n then r opens a new invoice; ? shows the shortcut help", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("heading", { level: 1, name: /^Herzlich Willkommen/ }).waitFor();
    await page.keyboard.press("n");
    await page.keyboard.press("r");
    await expect(page).toHaveURL(/\/rechnungen\/neu$/);
    await page.keyboard.press("Shift+?");
    await expect(page.getByRole("dialog", { name: "Tastenkürzel" })).toBeVisible();
  });

  test("SMOKE the sidebar collapses to icons with ⌘B / Ctrl+B", async ({ page }) => {
    await page.goto("/");
    const sidebar = page.locator("[data-slot=sidebar][data-state]");
    await expect(sidebar).toHaveAttribute("data-state", "expanded");
    await page.keyboard.press("Control+b");
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  });

  test("MISC-10 settings pages have no axe violations", async ({ page, expectNoAxeViolations }) => {
    for (const path of [
      "/einstellungen",
      "/einstellungen/unternehmen",
      "/einstellungen/steuern",
      "/einstellungen/nummernkreise",
      "/einstellungen/api",
      "/einstellungen/webhooks",
      "/einstellungen/mcp",
      "/konto",
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoAxeViolations();
    }
  });
});

test.describe("mobile shell", () => {
  test.skip(({ isMobile }) => !isMobile, "phone layout only");

  test("MISC-10 bottom tab bar, Mehr sheet and Neu drawer work without axe violations", async ({
    page,
    expectNoAxeViolations,
  }) => {
    await page.goto("/");
    const tabs = page.getByRole("navigation", { name: "Schnellzugriff" });
    await expect(tabs).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Hauptnavigation" })).toBeHidden();
    await expectNoAxeViolations();

    await tabs.getByRole("link", { name: "Rechnungen" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Rechnungen" })).toBeVisible();

    await tabs.getByRole("button", { name: "Mehr" }).click();
    const sheet = page.getByRole("dialog", { name: "Navigation" });
    await expect(sheet).toBeVisible();
    await expectNoAxeViolations();
    await sheet.getByRole("link", { name: "Kontakte" }).click();
    await expect(page).toHaveURL(/\/kontakte$/);
    await expect(sheet).toBeHidden();

    await tabs.getByRole("button", { name: "Neu erstellen" }).click();
    const drawer = page.getByRole("dialog", { name: "Neu erstellen" });
    await expect(drawer).toBeVisible();
    await expectNoAxeViolations();
    await drawer.getByRole("link", { name: "Angebot" }).click();
    await expect(page).toHaveURL(/\/angebote\/neu$/);
  });

  test("MISC-10 settings list and a settings form on the phone", async ({ page, expectNoAxeViolations }) => {
    await page.goto("/einstellungen");
    await page.getByRole("link", { name: /^Unternehmen/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Unternehmen" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Einstellungen" }).first()).toBeVisible();
    await expectNoAxeViolations();
  });
});
