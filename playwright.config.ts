import { defineConfig, devices } from "@playwright/test";
import "./test/load-test-env";

/**
 * Playwright (07-testing §3.2):
 *  - baseURL from E2E_BASE_URL (later the Caddy dev edge https://app.localtest.me, 08 §10).
 *  - Without E2E_BASE_URL, Playwright starts the app itself: `next dev` locally, `build && start` in CI. The web
 *    server inherits the variables of `.env.test.local` (written by `pnpm test:backend`): Convex URLs, site URL.
 *  - With a backend (`E2E_BACKEND=1`) the journeys in e2e/journey.spec.ts run against it; they share one
 *    deployment and reset it per project, so a single worker runs the files one after another.
 *  - Dev mode (`next dev`, i.e. locally without E2E_BASE_URL, or E2E_DEV_SERVER=1 for an external dev server):
 *    e2e/global-setup.ts compiles every route before the first test and the timeouts are longer, because the
 *    first request of a route compiles it. CI runs a production build with the Playwright defaults.
 */
const PORT = Number(process.env.E2E_PORT ?? 3000);
const withBackend = Boolean(process.env.E2E_BACKEND);
const externalBaseURL = process.env.E2E_BASE_URL;
const baseURL = externalBaseURL ?? `http://localhost:${PORT}`;
const devServer = process.env.E2E_DEV_SERVER === "1" || (!process.env.CI && !externalBaseURL);
// Read by e2e/global-setup.ts and e2e/fixtures.ts (workers load this config too).
process.env.E2E_DEV_SERVER = devServer ? "1" : "0";

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  ...(devServer ? { timeout: 90_000 } : {}),
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
    ...(devServer ? { navigationTimeout: 60_000, actionTimeout: 20_000 } : {}),
  },
  expect: {
    ...(devServer ? { timeout: 15_000 } : {}),
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
