import AxeBuilder from "@axe-core/playwright";
import { test as base, expect, type Page } from "@playwright/test";

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
}

/**
 * Shared fixtures. `expectNoAxeViolations()` must be called on every page visit (CLAUDE.md §9, MISC-10).
 */
export const test = base.extend<{ expectNoAxeViolations: () => Promise<void> }>({
  expectNoAxeViolations: async ({ page }, use) => {
    await use(async () => {
      await settleAnimations(page);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(results.violations).toEqual([]);
    });
  },
});

export { expect };
