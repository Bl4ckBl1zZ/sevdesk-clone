import { expect, test } from "./fixtures";

test("SMOKE home page loads in German without axe violations", async ({ page, expectNoAxeViolations }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.getByRole("heading", { level: 1, name: "Rechnungen" })).toBeVisible();
  await expectNoAxeViolations();
});
