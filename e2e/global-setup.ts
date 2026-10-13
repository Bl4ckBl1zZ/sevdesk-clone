import type { FullConfig } from "@playwright/test";

/**
 * Playwright global setup (runs after the web server answers /api/health).
 *
 * Against `next dev` every route is compiled on its first request, which can take longer than a test step and
 * makes Next reload pages that are already open. So in dev mode (E2E_DEV_SERVER, set in playwright.config.ts) the
 * routes the specs open are requested once before the first test. Signed-in routes are requested with a dummy
 * session cookie: proxy.ts only checks that a cookie is present, the signed-in layout then rejects the session and
 * redirects, but the route has been compiled. Compiling every page of the app would take minutes and gigabytes;
 * a route missing here is only slower on its first visit. A production server (CI) needs no warm-up.
 */
export const WARM_UP_ROUTES = [
  "/api/auth/rechnungen/first-run",
  "/manifest.webmanifest",
  "/anmelden",
  "/anmelden/code",
  "/anmelden/passkey-einrichten",
  "/anmelden/zwei-faktor",
  "/einrichtung",
  "/",
  "/rechnungen",
  "/rechnungen/neu",
  "/rechnungen/e2e-warm-up",
  "/einstellungen/bank",
  "/angebote/neu",
  "/kontakte",
  "/kontakte/neu",
  "/produkte",
  "/produkte/neu",
  "/produkte/kategorien",
  "/steuern/ustva",
  "/einstellungen",
  "/einstellungen/unternehmen",
  "/einstellungen/steuern",
  "/einstellungen/nummernkreise",
  "/einstellungen/mitglieder",
  "/konto",
];

async function warmUp(baseURL: string, path: string): Promise<string> {
  const started = Date.now();
  const res = await fetch(new URL(path, baseURL), {
    redirect: "manual",
    headers: { cookie: "better-auth.session_token=e2e-warm-up", accept: "text/html" },
    signal: AbortSignal.timeout(180_000),
  });
  await res.arrayBuffer();
  return `${res.status} ${path} ${Date.now() - started} ms`;
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  if (process.env.E2E_DEV_SERVER !== "1") return;
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return;
  const started = Date.now();
  const queue = [...WARM_UP_ROUTES];
  const failures: string[] = [];
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      for (let path = queue.shift(); path; path = queue.shift()) {
        const line = await warmUp(baseURL, path);
        if (line.startsWith("5")) failures.push(line);
      }
    }),
  );
  console.log(
    `[e2e] dev server warmed up: ${WARM_UP_ROUTES.length} routes in ${Math.round((Date.now() - started) / 1000)} s`,
  );
  if (failures.length) throw new Error(`dev server warm-up failed:\n${failures.join("\n")}`);
}
