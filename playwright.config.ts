import { defineConfig, devices } from "@playwright/test";
import "./test/load-test-env";

/**
 * Playwright (07-testing §3.2):
 *  - baseURL from E2E_BASE_URL (later the Caddy dev edge https://app.localtest.me, 08 §10).
 *  - Without E2E_BASE_URL, Playwright starts the app itself: `next dev` locally, `build && start` in CI. The web
 *    server inherits the variables of `.env.test.local` (written by `pnpm test:backend`): Convex URLs, site URL.
 *  - With a backend (`E2E_BACKEND=1`) the journeys in e2e/journey.spec.ts run against it; they share one
 *    deployment and reset it per project, so a single worker runs the files one after another.
 */
const PORT = Number(process.env.E2E_PORT ?? 3000);
const withBackend = Boolean(process.env.E2E_BACKEND);
const externalBaseURL = process.env.E2E_BASE_URL;
const baseURL = externalBaseURL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false, // shared backend; tests isolate data with unique prefixes
  ...(withBackend ? { workers: 1 } : {}),
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [["html", { open: "never" }], ["junit", { outputFile: "results/e2e.xml" }], ["github"]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "on-first-retry",
    ignoreHTTPSErrors: true,
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
  },
  expect: {
    toHaveScreenshot: { maxDiffPixels: 100, animations: "disabled", stylePath: "e2e/hide-volatile.css" },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "iphone", use: { ...devices["iPhone 15"] } },
    { name: "pixel", use: { ...devices["Pixel 7"] } },
  ],
  webServer: externalBaseURL
    ? undefined
    : {
        command: process.env.CI ? `pnpm build && pnpm start -p ${PORT}` : `pnpm dev -p ${PORT}`,
        url: `http://localhost:${PORT}/api/health`,
        timeout: 240_000,
        reuseExistingServer: !process.env.CI,
      },
});
