import AxeBuilder from "@axe-core/playwright";
import { test as base, expect } from "@playwright/test";

/**
 * Shared fixtures. `expectNoAxeViolations()` must be called on every page visit (CLAUDE.md §9, MISC-10).
 */
export const test = base.extend<{ expectNoAxeViolations: () => Promise<void> }>({
  expectNoAxeViolations: async ({ page }, use) => {
    await use(async () => {
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(results.violations).toEqual([]);
    });
  },
});

export { expect };
