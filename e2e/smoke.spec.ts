import { expect, test } from "./fixtures";

test("SEC-02 signed-out visitors land on the German sign-in page without axe violations", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/rechnungen");
  await expect(page).toHaveURL(/\/anmelden\?weiter=%2Frechnungen$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.getByRole("heading", { level: 1, name: "Anmelden" })).toBeVisible();
  await expectNoAxeViolations();
});

test("SMOKE PWA manifest is served with icons", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBe(true);
  const manifest = await res.json();
  expect(manifest).toMatchObject({ lang: "de-DE", display: "standalone", start_url: "/" });
  for (const icon of manifest.icons as { src: string }[]) {
    expect((await request.get(icon.src)).ok(), icon.src).toBe(true);
  }
});
