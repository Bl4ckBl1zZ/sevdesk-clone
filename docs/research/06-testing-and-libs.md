# Research report: testing stack and supporting libraries for a self-hosted German invoicing app (Next.js + Convex)

As of 2026-10-12. Versions were read from registry.npmjs.org `latest` dist-tags today. **[UNCERTAIN]** marks anything I could not confirm from a primary source.

**Main findings**
- Vitest is now at **5.0.4**, and MSW is at **3.0.3** (released 2026-09-28). Both majors have breaking changes, listed below.
- The Convex docs still describe convex-test with Vitest 4. Nothing I found confirms it works with Vitest 5.
- GoCardless Bank Account Data has accepted no new signups since July 2025.
- The BZSt XML-RPC interface for VAT-ID checks was shut down on 30.11.2025. Use the new REST API at `https://api.evatr.vies.bzst.de/app`.
- `fints` (Prior99) is dead, last published 2020. `lib-fints` is the maintained Node library.
- React Email 6 deprecated `@react-email/components`.

---

## A) Testing for TDD

### A1. Package versions (npm `latest`, 2026-10-12)

| Package | Version | Notes |
|---|---|---|
| `vitest` | **5.0.4** | `V4` dist-tag = 4.1.11. Needs Node `^22.12 \|\| ^24 \|\| >=26` and Vite `^6.4 \|\| ^7 \|\| ^8`. `vite` is now a peer dependency. |
| `@vitest/browser-playwright` | 5.0.4 | peer: `vitest@5.0.4` and `playwright` |
| `vitest-browser-react` | 2.3.0 | peer: vitest ^4 \|\| ^5, React 18/19 |
| `convex-test` | **0.0.61** | peer `convex ^1.43.0`. Its own dev setup pins vitest 1.6.1 and `@edge-runtime/vm` 5.0.0. |
| `@edge-runtime/vm` | 5.0.0 | needed for `environment: "edge-runtime"` |
| `convex` | 1.46.0 | |
| `@testing-library/react` | **16.3.3** | peer React `^18 \|\| ^19`, requires `@testing-library/dom ^10` as a separate install |
| `@testing-library/user-event` | 14.6.7 | |
| `@testing-library/jest-dom` | 7.0.1 | |
| `jsdom` | 30.1.2 | engines: Node `^22.22.2 \|\| ^24.15.0 \|\| >=26` |
| `happy-dom` | 21.0.1 | |
| `@playwright/test` | **1.64.0** | Docker image `mcr.microsoft.com/playwright:v1.64.0-noble` |
| `msw` | **3.0.3** | ESM only, Node >= 22, TypeScript >= 5.9 |

### A2. Vitest 5 breaking changes that matter here
Source: vitest.dev/guide/migration.
- **`clearMocks` now defaults to `true`.** Call history recorded in setup files or `beforeAll` is cleared before each test. Set `clearMocks: false` to get the old behaviour.
- **Inline `projects` now inherit from the root config by default** (`extends: true`). Arrays are appended, not replaced. `sharedViteServer` is on by default. Config lookup no longer searches parent directories.
- **Assertion changes:**
  - An async assertion you forget to `await` now fails the test.
  - `expect.poll` rejects on timeout.
  - `toThrow("")` matches any error.
- **Removed and renamed APIs:**
  - `test.sequential` and `describe.sequential` are gone. Use `concurrent: false`.
  - `vitest/reporters` and `vitest/coverage` entry points are removed.
  - Reporter output now goes under `.vitest/`, so CI artifact paths need updating.
- **Browser mode:**
  - Locators match exactly by default.
  - `toHaveTextContent` is now strict. Use `toMatchTextContent` for partial or regex matches.
  - `browser.api` moved to the top-level `api` option.
- **Fake timers also mock `Temporal`** when it exists globally. Opt out with `toNotFake: ['Temporal']`.

**Recommendation:** the Convex docs and convex-test only document Vitest 4. Pin `vitest@^4.1` (4.1.11) until you have confirmed convex-test runs under Vitest 5. **[UNCERTAIN: Vitest 5 compatibility not verified.]** The config below works on both 4 and 5.

### A3. Vitest config: Convex (edge-runtime), components (jsdom), optional browser mode
The Convex docs give the `projects` split with `edge-runtime` for `convex/**` and `jsdom` for everything else.

```ts
// vitest.config.mts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "convex",
          include: ["convex/**/*.test.ts"],
          environment: "edge-runtime",
          // Recommended by older convex-test READMEs; add it if import.meta.glob/ESM errors appear [UNCERTAIN whether still needed]
          server: { deps: { inline: ["convex-test"] } },
        },
      },
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.{ts,tsx}", "lib/**/*.test.ts"],
          exclude: ["convex/**", "**/*.browser.test.tsx", "e2e/**"],
          environment: "jsdom", // or "happy-dom" (faster, fewer APIs)
          setupFiles: ["./vitest.setup.ts"], // import "@testing-library/jest-dom/vitest"; MSW server.listen()
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["**/*.browser.test.tsx"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
```

- You can override the environment per file with a `// @vitest-environment jsdom` comment.
- Install for browser mode: `pnpm add -D vitest @vitest/browser-playwright vitest-browser-react playwright`.
- Next.js note: async Server Components cannot be unit-tested with RTL or Vitest. Cover them with Playwright E2E.

### A4. convex-test usage
Source: docs.convex.dev/testing/convex-test.

Install:
```bash
pnpm add -D convex-test vitest @edge-runtime/vm
```

Shared module glob:
```ts
// convex/test.setup.ts
/// <reference types="vite/client" />
export const modules = import.meta.glob("./**/!(*.*.*)*.*s");
```

Example test:
```ts
// convex/invoices.test.ts
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

test("finalize invoice assigns number", async () => {
  const t = convexTest(schema, modules);

  // Seed data directly in the database
  const customerId = await t.run(async (ctx) =>
    ctx.db.insert("customers", { name: "ACME GmbH" }));

  // Calls as an authenticated user. issuer/subject/tokenIdentifier are auto-generated if omitted
  const asUser = t.withIdentity({ name: "Sarah", subject: "user_1" });
  const id = await asUser.mutation(api.invoices.create, { customerId });
  await asUser.mutation(api.invoices.finalize, { id });
  const inv = await asUser.query(api.invoices.get, { id });
  expect(inv?.number).toMatch(/^RE-\d{4}-\d+$/);

  // Internal functions work too
  await t.action(internal.invoices.sendEmail, { id });
});

test("scheduled dunning", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  await t.mutation(api.dunning.schedule, { delayMs: 10_000 });

  // Run every scheduled function, including ones scheduled recursively
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  // For a single function instead:
  //   vi.advanceTimersByTime(11_000);
  //   await t.finishInProgressScheduledFunctions();
  vi.useRealTimers();
});
```

Other APIs:
- **HTTP actions:** `await t.fetch("/webhook", { method: "POST" })`. Mocking global `fetch` does not affect `t.fetch`.
- **Inline function contexts (since 0.0.42):** `t.query`, `t.mutation` and `t.action` also accept an inline function that receives a typed ctx.
- **0.0.58:** queries and mutations now throw if they call `fetch` or timer APIs. `withIdentity` calls can be chained.
- **0.0.59:** `t.withRequestMetadata` was added.
- **0.0.61:** `defineTestApp` was added, which supports component registration.

Limitations:
- Size and time limits are not enforced.
- ID formats and error messages differ from the real backend.
- Text search is prefix-only.
- **Cron jobs do not run.** Call the cron's target functions directly in tests.

### A5. Playwright E2E: mobile, visual regression, local Convex backend

**Mobile devices.** `devices['iPhone 15']` and `devices['Pixel 7']` are confirmed descriptors (Apple devices default to WebKit, Android to Chromium). Run `Object.keys(devices)` to list what your installed version has.

**Visual regression.**
- Assert with `await expect(page).toHaveScreenshot('invoice-list.png', { maxDiffPixels: 100, stylePath: 'e2e/hide-volatile.css' })`. The default `threshold` is 0.2.
- Set defaults in config under `expect.toHaveScreenshot`, and control file locations with `snapshotPathTemplate`.
- Update baselines with `npx playwright test --update-snapshots`.
- Snapshot file names include browser/project and platform (e.g. `-chromium-linux`). For stable results, generate and compare baselines in the same Docker image:
  ```bash
  docker run --rm --init --ipc=host -v $PWD:/work -w /work \
    mcr.microsoft.com/playwright:v1.64.0-noble npx playwright test --update-snapshots
  ```

```ts
// playwright.config.ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false, // shared backend; or isolate data per test via tenant IDs
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: "http://localhost:3000", trace: "on-first-retry" },
  expect: { toHaveScreenshot: { maxDiffPixels: 100, animations: "disabled" } },
  globalSetup: "./e2e/global-setup.ts", // deploy Convex functions + seed (see below)
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "iphone", use: { ...devices["iPhone 15"] } },
    { name: "pixel", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      name: "next",
      command: "pnpm build && pnpm start",
      url: "http://localhost:3000",
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: "pipe",
      env: { NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3210" },
    },
  ],
});
```

- `webServer` also supports `wait: { stdout: /regex/ }` and `gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 }`.
- The `animations` option in the config above is standard Playwright, but the snapshot docs page I fetched did not cover it. **[UNCERTAIN]**

**Ways to run E2E against Convex:**
1. **Self-hosted Docker (recommended, since production is self-hosted).**
   - Images: `ghcr.io/get-convex/convex-backend:latest`, plus optionally `ghcr.io/get-convex/convex-dashboard:latest` on port 6791.
   - Ports: 3210 (API) and 3211 (HTTP actions). Health check: `/version`.
   - Generate an admin key with `docker compose exec backend ./generate_admin_key.sh`.
   - Set `CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210` and `CONVEX_SELF_HOSTED_ADMIN_KEY=...`.
   - Push functions with `npx convex deploy`. The docs say these two variables replace `CONVEX_DEPLOY_KEY`. **[`deploy` flags such as `--yes` UNCERTAIN]**
2. **Anonymous local deployment.** `CONVEX_AGENT_MODE=anonymous npx convex dev` runs a local backend as a subprocess of the CLI. `npx convex dev --once` pushes code and exits, so the backend does not stay up for E2E. That makes it useful for codegen and typecheck, but not as a long-running E2E server. To use this route, add `npx convex dev` as a second `webServer` entry. **[The `--local` flag is not in the official docs I found; check `npx convex dev --help`.]**

**Resetting data between tests.** Use a guarded `clearAll` mutation:
- Wrap it with `customMutation` from convex-helpers so it throws unless `process.env.IS_TEST` is set.
- Enable it with `npx convex env set IS_TEST true`.
- The mutation deletes every table's documents, cancels `_scheduled_functions`, and deletes `_storage` files.
- Call it from tests with `ConvexTestingHelper` from `convex-helpers/testing`, or with `npx convex run`.
- Source: stack.convex.dev/testing-with-local-oss-backend.

### A6. MSW 3 (changes from v2)

```ts
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw/http"; // v3: moved off the root "msw" import

export const server = setupServer(
  http.post("https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number",
    () => HttpResponse.json({ valid: true, name: "ACME", requestIdentifier: "WAPIAAAA..." })),
);

// vitest.setup.ts
beforeAll(() => server.listen({ onUnhandledFrame: "error" })); // renamed from onUnhandledRequest
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

Other v3 changes:
- **Moved imports:** `delay` → `msw/utils/delay`, `bypass` → `msw/utils/bypass`, `passthrough` → `msw/utils/passthrough`.
- **GraphQL:** now link-first via `msw/graphql`.
- **Promise-returning stop:** `worker.stop()` returns a Promise.
- **Removed:** `handleRequest()` → `getResponse()`; `msw/native` → `@msw/react-native`.
- **Timers and cookies:** MSW no longer patches `setTimeout` for fake timers. Node no longer manages cookies.
- **New:** a Vite plugin at `msw/vite`.

### A7. GitHub Actions workflow (pnpm, caching, Convex as a service)

```yaml
name: CI
on: [push, pull_request]
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec convex codegen   # [UNCERTAIN] may need a deployment; alternatively commit convex/_generated
      - run: pnpm vitest run --project convex --project unit

  e2e:
    runs-on: ubuntu-latest
    services:
      convex:
        image: ghcr.io/get-convex/convex-backend:latest
        ports: ["3210:3210", "3211:3211"]
        options: >-
          --health-cmd "curl -f http://localhost:3210/version"
          --health-interval 5s --health-retries 20
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - name: Cache Playwright browsers
        uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: pw-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
      - run: pnpm exec playwright install --with-deps
      - name: Admin key + deploy Convex functions
        run: |
          KEY=$(docker exec ${{ job.services.convex.id }} ./generate_admin_key.sh | tail -n1)
          echo "CONVEX_SELF_HOSTED_ADMIN_KEY=$KEY" >> $GITHUB_ENV
          CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 CONVEX_SELF_HOSTED_ADMIN_KEY=$KEY npx convex env set IS_TEST true
          CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 CONVEX_SELF_HOSTED_ADMIN_KEY=$KEY npx convex deploy
      - run: pnpm exec playwright test
        env: { CONVEX_SELF_HOSTED_URL: http://127.0.0.1:3210 }
      - uses: actions/upload-artifact@v4
        if: ${{ !cancelled() }}
        with: { name: playwright-report, path: playwright-report/, retention-days: 30 }
```

- The health check assumes `curl` exists in the image. The `tail -n1` parsing of the key script's output is also unverified. **[UNCERTAIN]**
- For screenshot tests, run that job in `container: mcr.microsoft.com/playwright:v1.64.0-noble` so it matches your local baselines.
- Playwright's own CI example uses `actions/checkout@v6`, `actions/setup-node@v6` and `npx playwright install --with-deps`.

---

## B) Other libraries

### B1. EPC / GiroCode QR (EPC069-12)
Current guideline: EPC069-12 v3.0, effective 13 Sept 2022. Fields go one per line, separated by LF (or CRLF). Field lengths below are confirmed by several secondary implementations; I could not read the EPC PDF table myself, so double-check if exact limits matter.

| Line | Field | Rule |
|---|---|---|
| 1 | Service tag | `BCD` |
| 2 | Version | `002` (version `001` requires a BIC; in `002` the BIC is optional within the EEA) |
| 3 | Character set | `1`=UTF-8, `2`=ISO 8859-1, `3`=8859-2, `4`=8859-4, `5`=8859-5, `6`=8859-7, `7`=8859-10, `8`=8859-15 |
| 4 | Identification | `SCT` |
| 5 | BIC | 8 or 11 chars, may be empty in v002 |
| 6 | Beneficiary name | max 70, mandatory |
| 7 | IBAN | max 34, mandatory |
| 8 | Amount | `EUR` + amount with a dot decimal, 0.01–999999999.99 (e.g. `EUR123.45`), optional |
| 9 | Purpose | 4-char ISO 20022 purpose code, optional |
| 10 | Structured remittance | max 35, ISO 11649 RF reference. Use this **or** line 11. |
| 11 | Unstructured remittance | max 140 |
| 12 | Beneficiary-to-originator info | max 70, optional |

- Total payload is at most **331 bytes**. Error correction level **M**. QR version at most 13.
- Do not add a trailing newline after the last populated field. **[per spec as I know it; examples vary]**

Packages:
- **`sepa-payment-qr-code` 2.0.2** (2023-11): returns only the payload string. Usage: `generateQrCode({ name, iban, amount, unstructuredReference, information })`.
- `sepa-payment-code` is archived.
- No `epc-qr` package showed up in my searches.
- Render the QR with **`qrcode` 1.5.4**.

Building the payload yourself is simple:

```ts
import QRCode from "qrcode";
import { electronicFormatIBAN, isValidIBAN } from "ibantools";

export function buildEpcPayload(p: {
  name: string; iban: string; bic?: string; amountCents?: number;
  purpose?: string; rfReference?: string; text?: string; info?: string;
}) {
  const iban = electronicFormatIBAN(p.iban)!;
  if (!isValidIBAN(iban)) throw new Error("invalid IBAN");
  if (p.rfReference && p.text) throw new Error("use either RF reference or text");
  const amount = p.amountCents != null ? `EUR${(p.amountCents / 100).toFixed(2)}` : "";
  const lines = [
    "BCD", "002", "1", "SCT",
    p.bic ?? "",
    p.name.slice(0, 70),
    iban,
    amount,
    (p.purpose ?? "").slice(0, 4),
    (p.rfReference ?? "").slice(0, 35),
    (p.text ?? "").slice(0, 140),
    (p.info ?? "").slice(0, 70),
  ];
  while (lines.length > 8 && lines[lines.length - 1] === "") lines.pop(); // drop trailing empty optionals
  const payload = lines.join("\n");
  if (new TextEncoder().encode(payload).length > 331) throw new Error("EPC payload > 331 bytes");
  return payload;
}

export const epcSvg = (payload: string) =>
  QRCode.toString(payload, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
```

Use `toFixed(2)` on integer cents to avoid floating-point drift. Some banking apps prefer `EUR123.4` over `EUR123.40`; both are valid.

### B2. IBAN validation and BIC lookup
**`ibantools` 4.5.4:**
- `electronicFormatIBAN('DE89 3704 ...')`, `isValidIBAN(iban)`, `validateIBAN(iban)` → `{ valid, errorCodes: [ValidationErrorsIBAN.WrongIBANChecksum, ...] }`
- `isValidBIC(bic)`, `friendlyFormatIBAN(iban)`
- `extractIBAN(iban)` returns `{ bban, countryCode, valid, ... }`. **[`bankIdentifier` field UNCERTAIN]**
- For German IBANs the BLZ is simply `iban.slice(4, 12)`.

**BIC lookup.** Use the Bundesbank Bankleitzahlendatei:
- Download page: https://www.bundesbank.de/de/aufgaben/unbarer-zahlungsverkehr/serviceangebot/bankleitzahlen/download-bankleitzahlen-602592
- Formats: TXT (fixed-width), **CSV**, XML (each also as ZIP). No XLSX.
- Current file is valid 07.09.2026–06.12.2026; the next one is due 07.12.2026. Updates are quarterly.
- Important fields: field 2 is "Merkmal": `1` means the BLZ belongs to a payment service provider, so use only those rows. Field 11 is the change flag (`D` = deleted). Field 13 is the successor BLZ.
- The public copy is "unverbindlich" (non-binding). Usage notes are in the Impressum.
- Approach: import the CSV into a Convex table with a cron or a manual refresh each quarter.

### B3. VAT-ID checks: VIES REST and BZSt eVatR
**VIES REST** (official swagger: https://ec.europa.eu/assets/taxud/vow-information/swagger_publicVAT.yaml).
- Base URL: `https://ec.europa.eu/taxation_customs/vies/rest-api`
- `POST /check-vat-number`. Request (all strings): `countryCode`, `vatNumber`, `requesterMemberStateCode`, `requesterNumber`, `traderName`, `traderStreet`, `traderPostalCode`, `traderCity`, `traderCompanyType`.
- Response: `countryCode`, `vatNumber`, `requestDate`, `valid` (boolean), **`requestIdentifier`** (returned only if both requester fields are sent; this is your consultation number), `name`, `address`, `trader*`, and `trader*Match` (`VALID | INVALID | NOT_PROCESSED`).
- `POST /check-vat-test-service` is a test endpoint. `GET /check-status` returns `{ vow: { available }, countries: [{ countryCode, availability }] }`.
- Errors come back as `{ actionSucceed, errorWrappers: [{ error, message }] }`.
- **`GET /ms/{cc}/vat/{num}`** is not in the swagger but works. I tested it live: `/ms/IE/vat/6388047V` returned `{ isValid, requestDate, userError: "VALID", name, address, requestIdentifier: "", originalVatNumber, vatNumber, viesApproximate: { name, street, postalCode, city, companyType, matchName..matchCompanyType } }`.
- Possible `userError` values include `MS_UNAVAILABLE`, `TIMEOUT`, `MS_MAX_CONCURRENT_REQ`, `INVALID_INPUT`. **[UNCERTAIN, inferred from SOAP fault codes]**
- Germany does not return name or address through VIES. **[from experience; not verified this session]**

**BZSt eVatR (needed for a German "qualifizierte Bestätigung").**
- The **XML-RPC interface (`evatr.bff-online.de`) has been obsolete since 30.11.2025.** The REST API has been available since 01.07.2025.
- OpenAPI: https://api.evatr.vies.bzst.de/api-docs. Base URL: `https://api.evatr.vies.bzst.de/app`. The spec defines no authentication.
- `POST /v1/abfrage` body: `{ anfragendeUstid (your DE-USt-IdNr, required), angefragteUstid (required), firmenname?, strasse?, plz?, ort? }`. Sending firmenname and ort (plus optional plz and strasse) makes it a qualified check.
- Response: `{ id, anfrageZeitpunkt, status, gueltigAb?, gueltigBis?, ergFirmenname?, ergStrasse?, ergPlz?, ergOrt? }`. The `erg*` fields are `A` (matches), `B` (does not match), `C` (not requested) or `D` (not provided by the member state). `status: "evatr-0000"` means OK.
- `GET /v1/info/statusmeldungen` returns the status-code texts. `GET /v1/info/eu_mitgliedstaaten` returns `{ alpha2, name, verfuegbar }`.
- Only foreign USt-IdNrs can be checked. Store `id` and the full response as proof.
- Wrappers: npm `evatr-api` (rechtlogisch/evatr-js; version not checked) and Go `hostwithquantum/go-evatr`.

### B4. Bank sync
**FinTS in Node:**
- **`lib-fints` 1.5.2** (robocode13, LGPL-2.1-or-later). Actively maintained: releases in Feb, Jun, Aug and Sep 2026.
  - Supports PIN/TAN, PSD2 and **decoupled TAN**: call the `...WithTan()` method without a TAN and poll until `requiresTan=false`.
  - Fetches statements as MT940 or **CAMT (built-in parser)**, balances, credit-card statements and PDF e-statements.
  - No payments or transfers yet. FinTS 3.0 only. Tested with comdirect, DKB, ING and Renault Bank.
  - Basic flow:
    ```ts
    const config = FinTSConfig.forFirstTimeUse(productId, productVersion, bankUrl, bankId, userId, pin);
    const client = new FinTSClient(config);
    await client.synchronize();
    let r = await client.getAccountStatements(account);
    if (r.requiresTan) r = await client.getAccountStatementsWithTan(r.tanReference!, tan);
    ```
  - Reuse the session with `FinTSConfig.fromBankingInformation()`.
- **`fints` (Prior99) 0.5.0** was last published 2020-11 and is **unmaintained**. Avoid it. I found no `fints-psd2-lib` package.
- Python alternative for a sidecar: `fints` (python-fints) 5.0.1, released 2026-10-09.
- **Product registration is required.** Since 01.08.2019, banks only allow registered products.
  - Send the original form to registrierung@hbci-zka.de; it is free according to library READMEs.
  - The number arrives in about 10–15 working days and goes into "Produktbezeichnung" at every dialog init.
  - Banks can take 0–8+ weeks to whitelist it.
  - Page: https://www.fints.org/de/hersteller/produktregistrierung
  - For an OSS self-hosted app, either register the product yourself or let each self-hoster enter their own ID.

**PSD2 aggregators:**
- **GoCardless Bank Account Data (formerly Nordigen):** "New signups … are currently disabled" (official page). Actual Budget's docs date this to **July 2025**. Existing accounts keep working. No official wind-down date was found.
- **Enable Banking:** free "restricted production mode" for accounts you link yourself in their portal. That fits single-tenant self-hosting, and Actual and Firefly III both use it. Full production needs a contract and KYB. **[current limits UNCERTAIN]**
- **Tink, Yapily, Salt Edge, TrueLayer, finAPI:** enterprise or contract pricing. Some reportedly require an eIDAS certificate or KYB. Not practical for self-hosters. **[pricing not verified]**

**Statement file import:**
- **`camt-parser` 2.1.0** (2025-05): CAMT.053 `.001.02`, `.001.08` and `.001.13`, with XSD validation. Needs `libxmljs2`, a native dependency. Its README repository link is a placeholder, so treat it with caution.
- Alternative: parse CAMT yourself with `fast-xml-parser`, which is what lib-fints does.
- **`mt940js` 1.3.5** (2020-05): old but usable. MT940 is being phased out in favour of CAMT.
- I could not confirm `@gitlab-org/mt940` exists.

### B5. OCR for receipts
**Claude API**, current model IDs (platform.claude.com):

| Model | ID | Price (input / output per MTok) |
|---|---|---|
| Claude Fable 5.1 | `claude-fable-5-1` | $10 / $50 |
| Claude Opus 5.5 | `claude-opus-5-5` | $4 / $20 |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | $2 / $10 |
| Claude Haiku 5.5 | `claude-haiku-5-5` | from $0.10 / $0.50 |

- All have 1M context and 128K max output. Batch API is 50% off.
- SDK: `@anthropic-ai/sdk` 0.133.0.
- **PDF input:** a content block `{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }`, or `source: { type: "url" }`, or `{ type: "file", file_id }` via the Files API. Limits: 32 MB per request; 600 pages (100 if the context window is under 1M).
- **Structured outputs:** use `output_config.format` (`type: "json_schema"`), which needs no beta header. The old `output_format` parameter is deprecated. Alternatively, put `strict: true` on a tool (max 20 strict tools).

```ts
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const Receipt = z.object({
  vendor: z.string(), date: z.string(), currency: z.string(),
  totalGross: z.number(), vatLines: z.array(z.object({ rate: z.number(), net: z.number(), vat: z.number() })),
  invoiceNumber: z.string().nullable(), vendorVatId: z.string().nullable(),
});

const res = await new Anthropic().messages.parse({
  model: "claude-sonnet-5-5", max_tokens: 2048,
  messages: [{ role: "user", content: [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfB64 } },
    { type: "text", text: "Extrahiere die Belegdaten." },
  ]}],
  output_config: { format: zodOutputFormat(Receipt) },
});
res.parsed_output; // typed + validated
```

Run this in a Convex action (`"use node"`), with the file read from `ctx.storage`.

**Local OCR:**
- **`tesseract.js` 7.0.0**: drops Node 14 and is about 15–35% faster than v6. v6 already removed `loadLanguage`/`initialize`, so use `createWorker('deu')`.
- Self-hosted alternatives: PaddleOCR or docTR (Python sidecars).
- Cloud alternatives: Google Document AI, Azure Document Intelligence, AWS Textract, Mistral OCR. **[not researched this session]**

### B6. Email
- **`nodemailer` 10.1.0.**
  - v8: the `NoAuth` error code became `ENOAUTH`.
  - v9: remote attachment URLs, OAuth2 endpoints and proxies now validate TLS certificates.
  - v10 (2026-09-03): requires Node >= 20.
  - Attachments are unchanged:
    ```ts
    attachments: [
      { filename: "RE-2026-001.pdf", content: pdfBuffer, contentType: "application/pdf" },
      { filename: "xrechnung.xml", content: xml, contentType: "application/xml" },
    ]
    ```
- **`resend` 6.32.1.**
  - Send attachments with `attachments: [{ filename, content: base64String }]` or `{ path: url }`. Inline images use `contentId`.
  - Max 40 MB after base64 encoding. Attachments are not allowed on the batch endpoint.
  - For self-hosting, SMTP through nodemailer avoids a vendor dependency.
- **React Email 6 (`react-email` 6.11.1).**
  - All components and `render` are now imported from `react-email`.
  - **`@react-email/components` (1.0.12) is deprecated.** `@react-email/render` 2.1.0 is still published.
  - The preview server was renamed to `@react-email/ui`.

### B7. ELSTER / ERiC (UStVA)
- **ERiC** is a closed-source C library, distributed as compiled libraries only.
  - Register at https://www.elster.de/eportal/infoseite/entwickler. The Bayerisches Landesamt für Steuern checks the request; access to the developer area arrives by email within a few days.
  - The **Hersteller-ID** is requested separately. Forum reports say this can take weeks.
  - You cannot redistribute ERiC in a public repository.
- **Integration options:**
  1. A Node FFI binding with `koffi` against `libericapi.so`. I found no existing project. **[feasible but unverified effort]**
  2. A Python sidecar based on Steuerlotse's `pyeric` (ctypes). **digitalservicebund/erica**, a REST wrapper around ERiC, was **archived 2025-07-23** but is MIT-licensed and usable as reference code.
  3. Java wrappers. **[not researched]**
  4. `geierlein` (pure JavaScript) is dead; its backend was switched off in 2019.
- **Recommendation for an MVP:** skip ERiC. Compute the UStVA field values (Kz 81, 86, 66, 83, …) and show them for manual entry in "Mein ELSTER". Then add a **DATEV export** for the Steuerberater.

**DATEV Buchungsstapel (EXTF):**
- **Line 1 (header):** `"EXTF";700;21;"Buchungsstapel";13;<YYYYMMDDHHMMSSfff>;;"<Herkunft>";"<Exportiert von>";;<Beraternr>;<Mandantennr>;<WJ-Beginn YYYYMMDD>;<Sachkontenlänge>;<Datum vom>;<Datum bis>;"<Bezeichnung>";;1;0;"EUR"`
  - Fields in order: format 700, category 21, format version 13, Beraternummer, Mandantennummer, start of fiscal year, Sachkontenlänge (account number length, e.g. 4), date range, Buchungstyp 1 (Fibu), Festschreibung 0.
  - The header has many more trailing fields. Check the official field list at developer.datev.de/datev/platform/en/dtvf/formate/header; the page did not render for me.
- **Line 2:** column names: `Umsatz (ohne Soll/Haben-Kz);Soll/Haben-Kennzeichen;WKZ Umsatz;Kurs;Basis-Umsatz;WKZ Basis-Umsatz;Konto;Gegenkonto (ohne BU-Schlüssel);BU-Schlüssel;Belegdatum;Belegfeld 1;Belegfeld 2;Skonto;Buchungstext;…` (about 120 columns in full).
- **Line 3 onward:** one booking per line, e.g. `1234,56;S;;;;;8400;1000;3;0103;RE-2026-001;;;"Rechnung ACME"`.
  - Semicolon-separated, text fields in quotes, decimal comma.
  - `Belegdatum` is `TTMM` (day and month; the year comes from the header).
  - SKR03 example: revenue account 8400, BU-Schlüssel 3 for 19% (2 = 7%).
- **[UNCERTAIN]** Encoding: traditionally ANSI/Windows-1252. One third-party tool uses UTF-8. Also unverified: whether `Umsatz` may contain a thousands separator. Use none.

---

## Sources
- Vitest 5 migration: https://vitest.dev/guide/migration · browser mode: https://vitest.dev/guide/browser/ · environments: https://vitest.dev/guide/environment · https://blog.openreplay.com/vitest-5-changes/
- convex-test: https://docs.convex.dev/testing/convex-test · changelog: https://raw.githubusercontent.com/get-convex/convex-test/main/CHANGELOG.md
- Local backend testing: https://stack.convex.dev/testing-with-local-oss-backend · https://docs.convex.dev/testing/ci · https://docs.convex.dev/cli/agent-mode
- Convex self-hosting: https://raw.githubusercontent.com/get-convex/convex-backend/main/self-hosted/README.md · compose file: …/self-hosted/docker/docker-compose.yml
- Playwright: https://playwright.dev/docs/docker · https://playwright.dev/docs/test-snapshots · https://playwright.dev/docs/ci-intro · https://playwright.dev/docs/test-webserver
- MSW 3: https://github.com/mswjs/msw/releases/tag/v3.0.0 · https://mswjs.io/docs/migrations/2.x-to-3.x
- EPC QR: https://europeanpaymentscouncil.eu/sites/default/files/kb/file/2022-09/EPC069-12%20v3.0%20Quick%20Response%20Code%20-%20Guidelines%20to%20Enable%20the%20Data%20Capture%20for%20the%20Initiation%20of%20an%20SCT_0.pdf · https://segno.readthedocs.io/en/1.3.3/epc-qrcodes.html · https://en.wikipedia.org/wiki/EPC_QR_code · https://cdn.jsdelivr.net/npm/sepa-payment-qr-code@2.0.2/readme.md
- ibantools: https://github.com/Simplify/ibantools · Bundesbank BLZ: https://www.bundesbank.de/de/aufgaben/unbarer-zahlungsverkehr/serviceangebot/bankleitzahlen/download-bankleitzahlen-602592
- VIES: https://ec.europa.eu/assets/taxud/vow-information/swagger_publicVAT.yaml
- eVatR: https://www.bzst.de/DE/Unternehmen/Identifikationsnummern/Umsatzsteuer-Identifikationsnummer/eVatR/eVatR_Info_Schnittstelle/eVatR_info_schnittstelle.html · https://api.evatr.vies.bzst.de/api-docs · https://www.bzst.de/SharedDocs/Newsletter/UStKV/20251030_newsletter_02_2025.html · https://github.com/rechtlogisch/evatr-js · https://pkg.go.dev/github.com/hostwithquantum/go-evatr · https://www.tso.de/en/news/news/change-to-vat-id-verification-bzst-switches-to-new-rest-api/
- FinTS: https://github.com/robocode13/lib-fints · https://www.fints.org/de/hersteller/produktregistrierung · https://registry.npmjs.org/fints · https://pypi.org/project/fints
- GoCardless: https://bankaccountdata.gocardless.com/new-signups-disabled · https://actualbudget.org/docs/advanced/bank-sync/gocardless · https://github.com/invoiceninja/invoiceninja/discussions/11305
- Enable Banking: https://actualbudget.org/docs/advanced/bank-sync/enable-banking · https://docs.firefly-iii.org/tutorials/data-importer/eb/ · https://dev.to/johnfrandsen/gocardless-bank-account-data-alternatives-what-to-use-when-signups-are-disabled-326d
- CAMT / MT940: https://cdn.jsdelivr.net/npm/camt-parser@2.1.0/README.md · https://registry.npmjs.org/mt940js
- Claude: https://platform.claude.com/docs/en/about-claude/models/overview · https://platform.claude.com/docs/en/build-with-claude/structured-outputs · https://platform.claude.com/docs/en/build-with-claude/pdf-support
- Tesseract.js: https://github.com/naptha/tesseract.js/releases · nodemailer: https://raw.githubusercontent.com/nodemailer/nodemailer/master/CHANGELOG.md
- Resend: https://resend.com/docs/dashboard/emails/attachments · React Email 6: https://resend.com/blog/react-email-6
- ELSTER: https://www.elster.de/eportal/infoseite/entwickler · https://github.com/digitalservicebund/erica · https://github.com/tech4germany/steuerlotse · https://github.com/stesie/geierlein
- DATEV: https://developer.datev.de/datev/platform/en/dtvf/formate/header · https://doku-next.dikas.de/en/benutzerhandbuch/buchhaltung/datev/ · https://support.perk.com/hc/en-us/articles/22004122556572-DATEV-integration-for-expenses
- Version numbers: https://registry.npmjs.org/<package>/latest (fetched 2026-10-12)
