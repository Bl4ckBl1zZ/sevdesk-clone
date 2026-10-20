import AxeBuilder from "@axe-core/playwright";
import { test as base, expect, type Page } from "@playwright/test";

/** `next dev` (set in playwright.config.ts): routes compile on first use, so waits are longer there. */
export const devServer = process.env.E2E_DEV_SERVER === "1";

/**
 * Waits until the current document is fully loaded and hydrated (`<html data-hydrated>`, set by HydrationMarker in
 * the root layout after React committed, i.e. once keyboard shortcuts and form handlers are attached) and the
 * network is idle (Better Auth session, first Convex queries; WebSockets do not count).
 */
export async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState("load");
  await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
  await page.waitForLoadState("networkidle");
}

/**
 * `page.goto` and `page.reload` resolve only once the page is ready (`waitForApp`): typing or pressing keys before
 * hydration would be lost or submit the form natively. Applied to the `page` fixture and to pages that specs
 * create themselves.
 */
export function waitForAppOnNavigation(page: Page): Page {
  const goto = page.goto.bind(page);
  const reload = page.reload.bind(page);
  page.goto = async (...args) => {
    const res = await goto(...args);
    await waitForApp(page);
    return res;
  };
  page.reload = async (...args) => {
    const res = await reload(...args);
    await waitForApp(page);
    return res;
  };
  return page;
}

/**
 * Picks the customer in a document editor (invoice, quote, recurring template). The „Kunde“ select lists only the
 * first 20 open contacts by name (`contacts.options`); on the shared test backend the wanted contact can lie beyond
 * them, so search first — as a user would.
 */
export async function selectCustomer(page: Page, name: string): Promise<void> {
  await page.getByLabel("Kunde suchen").fill(name);
  const select = page.getByRole("combobox", { name: "Kunde", exact: true });
  const option = select.locator("option", { hasText: name }).first();
  await expect(option).toBeAttached({ timeout: 20_000 });
  await select.selectOption((await option.getAttribute("value")) ?? "");
}

/** Waits until CSS transitions/animations (dialogs, sheets) have finished, so axe sees final colours. */
async function settleAnimations(page: Page) {
  // Base UI applies the starting style first and starts the transition a frame later.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await page
    .waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), undefined, {
      timeout: 2_000,
    })
    .catch(() => {
      // Infinite animations (spinners) never settle; analyse anyway.
    });
  // Base UI popups mark their enter/exit transition; a half-faded backdrop fails color-contrast on the page behind.
  await page
    .waitForFunction(() => !document.querySelector("[data-starting-style],[data-ending-style]"), undefined, {
      timeout: 5_000,
    })
    .catch(() => {});
}

const NAVIGATED = /Execution context was destroyed|navigat|Target page, context or browser has been closed/i;

/**
 * axe WCAG 2.1 AA check of the current page (CLAUDE.md §9, MISC-10). Waits for a pending navigation, hydration,
 * network idle and finished animations first. If the page navigates while axe runs (e.g. a client redirect or a
 * dev-server reload), the check starts again on the new document; violations are never retried away.
 */
export async function expectNoAxeViolations(page: Page): Promise<void> {
  let results: Awaited<ReturnType<AxeBuilder["analyze"]>> | undefined;
  for (let attempt = 1; !results; attempt++) {
    await waitForApp(page);
    await settleAnimations(page);
    try {
      results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    } catch (error) {
      if (attempt >= 3 || !(error instanceof Error) || !NAVIGATED.test(error.message)) throw error;
    }
  }
  expect(results.violations).toEqual([]);
}

/**
 * Shared fixtures. `expectNoAxeViolations()` must be called on every page visit (CLAUDE.md §9, MISC-10).
 */
export const test = base.extend<{ expectNoAxeViolations: () => Promise<void> }>({
  page: async ({ page }, use) => {
    await use(waitForAppOnNavigation(page));
  },
  expectNoAxeViolations: async ({ page }, use) => {
    await use(() => expectNoAxeViolations(page));
  },
});

export { expect };
