import { backendEnabled } from "./backend";
import { expect, test } from "./fixtures";

/**
 * Sign-in pages (04-ui-ux §4.9): rendering, flow to the code step and accessibility. The full passkey + e-mail
 * code journeys against the backend are e2e/00-journey.spec.ts.
 */

test("MISC-10 /anmelden offers passkey first and the e-mail code as fallback", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/anmelden");
  await expect(page.getByRole("heading", { level: 1, name: "Anmelden" })).toBeVisible();
  const email = page.getByLabel("E-Mail-Adresse");
  await expect(email).toHaveAttribute("autocomplete", "username webauthn");
  await expect(page.locator("input[type=password]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Mit Passkey anmelden" })).toBeVisible();
  await expectNoAxeViolations();

  await page.getByRole("button", { name: "Code per E-Mail senden" }).click();
  await expect(page.getByText("Bitte eine gültige E-Mail-Adresse eingeben.")).toBeVisible();
  await expect(email).toHaveAttribute("aria-invalid", "true");
});

test("MISC-10 requesting a code leads to the six-digit code step", async ({ page, expectNoAxeViolations }) => {
  // With a backend the answer depends on its state (first run shows the gate message); the journey covers it.
  test.skip(backendEnabled, "covered by e2e/00-journey.spec.ts against the backend");
  await page.goto("/anmelden?weiter=/rechnungen");
  await page.getByLabel("E-Mail-Adresse").fill("inhaber@firma.de");
  await page.getByRole("button", { name: "Code per E-Mail senden" }).click();
  await expect(page).toHaveURL(/\/anmelden\/code\?weiter=%2Frechnungen$/);
  await expect(page.getByRole("heading", { level: 1, name: "Code eingeben" })).toBeVisible();
  await expect(page.getByText("inhaber@firma.de")).toBeVisible();
  const digits = page.getByRole("group", { name: "Anmeldecode" }).getByRole("textbox");
  await expect(digits).toHaveCount(6);
  await expect(page.getByRole("button", { name: /Neuen Code senden/ })).toBeDisabled();
  await expectNoAxeViolations();
});

test("MISC-10 the two-factor page renders; passkey enrolment needs a session", async ({
  page,
  expectNoAxeViolations,
}) => {
  await page.goto("/anmelden/passkey-einrichten");
  await expect(page).toHaveURL(/\/anmelden\?weiter=%2Fanmelden%2Fpasskey-einrichten$/);

  await page.goto("/anmelden/zwei-faktor");
  await expect(page.getByRole("heading", { level: 1, name: "Zwei-Faktor-Bestätigung" })).toBeVisible();
  await expectNoAxeViolations();
});
