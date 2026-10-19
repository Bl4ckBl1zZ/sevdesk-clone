# 07 — Test Strategy (TDD)

> **Status:** v1.1 · 2026-10-12 (owner decisions applied: login instead of a gate, Enable Banking MSW mocks and real statement fixtures instead of Revolut API/webhook fixtures, no e-mail tests, sevdesk export fixtures, cash and R2 inbox tests, phase gates without a Steuerberater) · Research: [`../research/06-testing-and-libs.md`](../research/06-testing-and-libs.md)
> **Rule zero:** no production code without a failing test first. Every requirement ID (compliance `UST-06`, feature `INV-012`, …) is covered by at least one test whose name starts with the ID.

## 1. TDD workflow (mandatory for humans and agents)

1. **Pick a requirement** (feature file § 3) and its acceptance tests (§ 8).
2. **Red:** write the test(s) at the lowest layer that can prove the behaviour, named `"<REQ-ID> <behaviour>"`. Run it and watch it fail for the right reason.
3. **Green:** write the minimum code to pass.
4. **Refactor** with all tests green. Keep the domain layer pure.
5. **Climb one layer** if the behaviour crosses a boundary (domain → Convex function → API/MCP → UI E2E). Don't duplicate the same assertion at every layer; higher layers test the wiring.
6. **Commit** with the requirement IDs in the message (`feat(invoices): INV-012 atomic numbering`).
7. The CI **traceability check** fails if a MUST requirement of the current phase has no test.

Bug fixes start with a failing regression test named after the issue (`"BUG-123 …"`) and the requirement it violates.

## 2. Test pyramid and tools

| Layer | Tool | Location | What it covers | Speed budget |
|---|---|---|---|---|
| **Domain unit** | Vitest 4.1 (`node` env) + **fast-check** | `src/domain/**/*.test.ts` | Money/rounding, tax-case derivation, totals, lifecycle state machines, ER-03 decision table, numbering formats, interest, AfA, UStVA mapping, DATEV/GDPdU writers, EPC payload, parsers. **Most tests live here** | full suite < 20 s |
| **Golden files** | Vitest + snapshot fixtures + validators | `test/golden/**` | Every document type × tax case → canonical JSON snapshot, XML (UBL/CII), PDF text extraction, DATEV CSV, UStVA values | < 60 s (validators in CI job) |
| **Convex functions** | `convex-test` (edge-runtime) | `convex/**/*.test.ts` | Mutations/queries with schema, auth/actor wrappers, triggers (immutability, audit), scheduler (`finishAllScheduledFunctions` with fake timers), numbering under concurrency, retention | < 60 s |
| **Integration (real backend)** | Vitest + self-hosted Convex in Docker | `test/integration/**` | Things convex-test fakes: real OCC/serialisability (parallel finalisation), file storage, `"use node"` actions calling the einvoice-tools sidecar, JWT custom provider, rate limiter component | < 5 min |
| **API contract** | Vitest + OpenAPI validator (`openapi-response-validator` / `ajv`) | `src/app/api/**/*.test.ts` | Every endpoint: auth, scopes, idempotency, problem+json errors, schema conformance | < 60 s |
| **MCP contract** | Vitest + `@modelcontextprotocol/client` in-process | `src/server/mcp/**/*.test.ts` | Tool schemas, scope filtering, confirm tokens, structured errors | < 30 s |
| **Component** | Vitest (jsdom) + Testing Library + user-event | `src/components/**/*.test.tsx` | Editor line math, number input parsing, compliance panel, forms, responsive variants (rendering both branches) | < 60 s |
| **E2E** | Playwright 1.64 (Desktop Chrome, iPhone 15, Pixel 7) | `e2e/**` | Critical journeys against the full stack: web + Convex (Docker) + einvoice-tools + MSW-backed Enable Banking mock + local S3 (MinIO) standing in for R2 | < 15 min (sharded) |
| **Visual regression** | Playwright `toHaveScreenshot` in the official Docker image | `e2e/visual/**` | Key pages × 3 viewports × light/dark ([04-ui-ux §11](04-ui-ux.md#11-visual-regression)) | in E2E job |
| **Accessibility** | `@axe-core/playwright` | every E2E page visit | WCAG 2.1 AA (MISC-10) | in E2E job |
| **External validators** | KoSIT 1.6.3 + XRechnung config 2026-08-31, Mustang 2.26 (veraPDF) | CI job `einvoice-validate` | All golden XML/PDF artifacts, plus the PDFs E2E generated | < 5 min |
| **Security** | Playwright + Vitest | `e2e/security/**` | Passkey login with the virtual authenticator, e-mail OTP fallback, sign-up gate (invite-only; public sign-up rejected), role matrix (owner/bookkeeper/viewer/auditor × every route and Server Action), session enforcement on every route and Server Action (SEC-01), role checks incl. the read-only `auditor` role route table (SEC-03), CSRF, Host header, rate limits, no secrets in responses, no inbound bank webhook route (F07 BNK-108) | in E2E job |
| **Performance** | Playwright traces + Lighthouse CI (mobile) | `e2e/perf/**` | Budgets from [04-ui-ux §9](04-ui-ux.md#9-performance-budgets-checked-in-ci-with-playwright-traces) | nightly |
| **Mutation testing** | StrykerJS (Vitest runner) on `src/domain/**` | nightly | Mutation score ≥ 80 % for `money`, `tax`, `documents`, `einvoice`, `dunning`, `reports` | nightly |

### Coverage gates (CI)

| Scope | Lines | Branches |
|---|---|---|
| `src/domain/**` | ≥ 95 % | ≥ 90 % |
| `convex/**` | ≥ 85 % | ≥ 80 % |
| `src/app/api/**`, `src/server/**` | ≥ 85 % | ≥ 75 % |
| UI components | ≥ 70 % | — |

Coverage is a floor, not a goal. The traceability matrix and mutation score matter more.

## 3. Configuration

### 3.1 Vitest (`vitest.config.mts`)

Pinned to **Vitest 4.1.x** until `convex-test` documents Vitest 5 support (ADR-013).

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    projects: [
      { extends: true, test: { name: "domain", include: ["src/domain/**/*.test.ts", "test/golden/**/*.test.ts"], environment: "node" } },
      { extends: true, test: { name: "convex", include: ["convex/**/*.test.ts"], environment: "edge-runtime",
          server: { deps: { inline: ["convex-test"] } } } },
      { extends: true, test: { name: "server", include: ["src/app/api/**/*.test.ts", "src/server/**/*.test.ts"], environment: "node" } },
      { extends: true, test: { name: "ui", include: ["src/components/**/*.test.tsx", "src/app/**/*.test.tsx"],
          environment: "jsdom", setupFiles: ["./test/setup-ui.ts"] } },
      { extends: true, test: { name: "integration", include: ["test/integration/**/*.test.ts"], environment: "node",
          fileParallelism: false, testTimeout: 60_000 } },
    ],
    coverage: { provider: "v8", reporter: ["text", "lcov", "json-summary"] },
  },
});
```

`convex/test.setup.ts` exports `modules = import.meta.glob("./**/!(*.*.*)*.*s")`. A helper `makeT()` returns a `convexTest(schema, modules)` instance with seeded company settings and helpers `asUser({ role })` (default role `owner`, actor `user:<id>`), `asApiKey(scopes)`, `asMcp(scopes)`, `asSystem(job)` that set the identity like the real JWT.

### 3.2 Playwright (`playwright.config.ts`)

```ts
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,                 // shared backend; tests isolate data with unique prefixes
  retries: process.env.CI ? 2 : 0,
  reporter: [["html"], ["junit", { outputFile: "results/e2e.xml" }]],
  use: { baseURL: "https://app.localtest.me:3443", trace: "on-first-retry", ignoreHTTPSErrors: true,
         storageState: "e2e/.auth/owner.json" },   // signed in once in globalSetup (Playwright virtual WebAuthn authenticator; OTP codes from the in-memory auth-mail fake)
  expect: { toHaveScreenshot: { maxDiffPixels: 100, animations: "disabled", stylePath: "e2e/hide-volatile.css" } },
  globalSetup: "./e2e/global-setup.ts", // deploy Convex functions, IS_TEST=true, clearAll, seed baseline
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "iphone", use: { ...devices["iPhone 15"] } },
    { name: "pixel", use: { ...devices["Pixel 7"] } },
  ],
  webServer: { command: "pnpm build && pnpm start", url: "http://localhost:3000/api/health", timeout: 240_000,
               reuseExistingServer: !process.env.CI },
});
```

The local stack is `docker compose -f deploy/compose.dev.yml up` (hosts `*.localtest.me`, 08) with Convex backend (pinned SHA), Postgres 17, einvoice-tools, MinIO (S3-compatible stand-in for the R2 buckets: backups, checkpoints, e-mail-in) and an MSW server for the Enable Banking API; CI uses the same file with test overrides. Login mails (Cloudflare Email Sending) are replaced by an **in-memory auth-mail sender fake** that exposes the OTP to tests; there is no SMTP and no customer e-mail anywhere. Passkey login runs with Playwright's virtual WebAuthn authenticator.

### 3.3 Test data

- **Factories** (`test/factories/*.ts`): `makeCompany({ legalForm, ku, soll })`, `makeContact({ b2c, eu, publicAuthority })`, `makeProduct()`, `makeInvoiceDraft()` with builder-style overrides. The same factories are used by domain, Convex and E2E seeds.
- **Clock:** all domain functions receive `today`. Convex functions read "now" through `ctx.now()` (wrapper) so tests can freeze time. E2E sets the server clock via `TEST_NOW` (honoured only with `IS_TEST`).
- **Reset:** `clearAll` internal mutation (only with `IS_TEST=true`, refuses otherwise) deletes all tables, scheduled functions and storage. *P0 implementation:* the E2E journeys reset the test deployment with `convex import --replace-all` of an empty snapshot (e2e/backend.ts `resetBackend`, clears app and component tables incl. Better Auth; env and functions stay). A `clearAll` mutation would have to delete the append-only audit log through app code, which the guarded db forbids (CLAUDE.md rule 3).
- **P0 backend runs (no Docker):** `scripts/convex-local-backend.sh` + `pnpm test:backend` (Convex env with `IS_TEST=true`, `AUTH_MAIL_SENDER=memory`, generated test keys; pushes functions; writes `.env.test.local`, read by the integration project and Playwright). The journeys (e2e/journey.spec.ts) run on desktop + pixel (Chromium, CDP virtual authenticator) with one worker; each project starts from an empty deployment and signs the owner up with an e-mail code. Specs that need a signed-in owner (shell, setup) sign in after the journey of the same project.
- **E2E readiness:** the root layout sets `<html data-hydrated>` after hydration; `page.goto`/`reload` and the axe helper (e2e/fixtures.ts) wait for load, `data-hydrated` and network idle before typing, pressing keys or analysing, and axe restarts on the new document if the page navigates during the check. Against `next dev` (local default) `e2e/global-setup.ts` requests the routes the specs open once so they are compiled before the first test, and the timeouts are longer (test 90 s, expect 15 s, navigation 60 s); CI (`build && start`) keeps the Playwright defaults.
- **Fixtures:**
  - `test/fixtures/kosit-testsuite/` (XRechnung test suite, pinned release)
  - `test/fixtures/ferd-samples/` (ZUGFeRD 2.5 samples for all profiles incl. MINIMUM/BASIC-WL)
  - `test/fixtures/bank/enable-banking/` (MSW handlers + recorded **Enable Banking sandbox** responses: `/aspsps`, `/auth`, `/sessions`, transactions with `BOOK`/`PDNG`, missing `entry_reference`, `continuation_key` paging, `/balances`, `429 ASPSP_RATE_LIMIT_EXCEEDED`, `EXPIRED_SESSION`, re-consent with new account `uid`s)
  - `test/fixtures/bank/revolut-statements/` (the owner's real Revolut month exported as **CAMT.053, CSV, MT940 and signed PDF**, anonymised; synthetic variants for multi-currency, exchange between pockets, card FX with fee, reversal `RvslInd`, month-end UTC/Berlin boundary, overlap with feed data); `test/fixtures/bank/generic/` (camt.053 .001.02/.08, MT940, CSV with mappings for other banks)
  - `test/fixtures/receipts/` (PDFs/images for OCR, with expected JSON)
  - `test/fixtures/sevdesk-export/` (synthetic sevdesk file exports — contact/product/invoice/voucher list CSVs, DATEV file, ZIP, PDFs — replaced by anonymised owner samples once available; column names UNSURE until then)
  - `test/fixtures/inbox-r2/` (raw `.eml` objects for the e-mail-in poller: invoices with PDF/XML attachments, oversize, unparseable, non-business, duplicate Message-ID)

## 4. Golden-file suite (compliance backbone)

Directory `test/golden/cases/<case-id>/`:

```
input.json            # company + contact + draft document (+ advances, payments) + "today"
expected.snapshot.json# canonical EN 16931 model after finalisation (number fixed by the seed)
expected.cii.xml      # ZUGFeRD/Factur-X CII (profile EN16931)
expected.ubl.xml      # XRechnung UBL (where applicable)
expected.pdf.txt      # text extracted from the PDF (pdfjs), normalised
expected.datev.csv    # booking lines for this document
expected.ustva.json   # Kennzahlen contribution
```

**Minimum case list (P1):**

| Case | Covers |
|---|---|
| `de-19-standard` | UST-03..10, MISC-01 |
| `de-7-and-19-mixed` | UST-09/10, rounding |
| `de-rounding-10005` (3 × 10.005) | UST-10 golden from research |
| `de-gross-mode-b2c` | MISC-03, MAHN-01 note, gross→net conversion |
| `de-pv-zero-rate` | UST-15 (Z) |
| `de-restaurant-2025-vs-2026` | UST-15 date-effective |
| `ku-invoice` | KU-02 |
| `ku-threshold-crossing` | KU-01 |
| `eu-b2b-service-at` | UST-20 |
| `intra-community-supply-fr` | UST-21 |
| `reverse-charge-13b-construction` | UST-22 |
| `export-ch` / `not-taxable-us-service` | UST-23 |
| `kleinbetrag-250` / `kleinbetrag-250.01-rejected` | UST-14 |
| `advance-and-final` (10,000 € / 3,000 €) | UST-40/41 golden from research |
| `advance-rate-change` | UST-41 rate-change case |
| `storno-full` | UST-30 |
| `correction-partial` | UST-30/33 |
| `b2g-leitweg-xrechnung-ubl` | ER-10/20 |
| `foreign-currency-usd` | MISC-08 |
| `skonto-2-14` | UST-09 BT-20 syntax |
| `labor-cost-35a` | MISC-07 |
| `gmbh-footer` / `ek-footer` | MAIL-03 |
| `ist-2028-note` (dated 2028-01-02) vs `ist-2027` | UST-13 |
| `property-b2c-14b-note` | UST-12 |
| `recurring-monthly-period` | ER-04 |
| `cash-payment-quittung` | F07 CSH-028 (Quittung PDF text) |
| `cash-report-month` | F07 CSH-030 (cash movements with running balance) |
| `statement-camt053-revolut` | F07 BNK-033/120 (owner's anonymised month → normalised rows, balances, reconciliation) |

Rules:
- Golden files are only updated with `pnpm golden:update`, which prints a diff. The PR must explain the legal or layout reason. CODEOWNERS requires a second look for `test/golden/**`.
- CI job `einvoice-validate` runs every `expected.*.xml` through KoSIT (must be "acceptable") and every generated hybrid PDF through Mustang (valid PDF/A-3 + XML). Validator versions are part of the job name, so updates are visible.

## 5. Compliance-specific test techniques

| Technique | Used for |
|---|---|
| **Table-driven tests** | ER-03 decision matrix, tax-case derivation, UVA-01 periods, retention classes, §14a deadlines |
| **Property-based (fast-check)** | Totals: Σ lines = net; VAT per group = round(base × rate); gross = net + VAT; Storno + original = 0; payment allocations never exceed open amounts; cash balance never negative under random entry sequences (AO-05); money parse ∘ format = id |
| **Concurrency test** | 1,000 parallel `finalize` calls on the real backend → 1,000 unique, consecutive numbers (UST-06) |
| **Mutation inventory test** | Reflects over `convex/_generated/api` and, for every public mutation, attempts to modify a finalised document, line, payment, journal entry, cash transfer, booked bank transaction, `sendLog` row and audit entry. All must throw `immutable_record` (GOBD-06). Writes outside `convex/model/**` are only allowed for the Better Auth component tables under the allowlisted `convex/betterAuth/**` |
| **Tamper tests** | Write directly to the DB (bypassing the model) in an integration test → `integrity.verify` reports the exact entity and the first broken `seq` (SEC-04) |
| **Stichtag simulation** | Inject a fake future rate change → verify documents on both sides (MISC-09) |
| **Route-table security test** | Enumerate every Next route and Server Action → assert session enforcement (401/redirect without a session), role checks, 403 for the `auditor` role on writes, no unauthenticated route except login/health (SEC-01/03) |
| **Round-trip** | Our XML → parse with our inbound parser → same EN 16931 model (ER-01/02 consistency); DATEV export → re-import parser → same bookings |

## 5a. Edge cases and invariants

[10-edge-cases.md](10-edge-cases.md) is normative for tests:
- every `EC-`/`RI-` ID needs a test named with it;
- `assertInvariants()` (all `RI-*` checks) runs in `afterEach` of every Convex, integration and E2E test, and fails the test on any ERROR violation;
- the **model-based property suite** (`test/model/**`, fast-check `fc.commands`) runs 200 seeded random sequences per CI run and 10,000 nightly; failing seeds are committed as regression cases;
- failure-injection tests (sidecar down, Cloudflare Email Sending API failure for login OTPs, Enable Banking 5xx/429/`EXPIRED_SESSION`/consent expired, consent callback timeout during backfill, overlapping poll windows, R2 inbox object processed twice / crash between commit and delete, action crash) live in `test/integration/failures/**`.

## 6. Traceability

- `pnpm trace` scans the test names for requirement IDs and builds `docs/traceability.md` (a generated, committed file): requirement → tests → last CI result.
- The requirement registry is parsed from the spec tables (`docs/spec/01-compliance.md` and `docs/spec/features/*.md` § 3) by `scripts/trace/parse-spec.ts`.
- Besides requirements, the registry holds the edge-case/error rows (`10-edge-cases.md`, feature § 5: `EC-…`, `E-AUD-…`) and the feature test-case rows (`T-SET-…`, `T05-…`, `TST-AUD-…`). A test named with a test-case ID also counts for the IDs in that row's "Covers" column. EN 16931 business terms and groups (`BT-81`, `BG-16`) are annotation tokens, not IDs; `BUG-…` is allowed for regression tests.
- **The CI gate fails** if a `MUST` requirement whose phase ≤ the current release phase has zero tests, or if a test references an unknown ID (one that is in no spec table). CI runs `pnpm trace --phase P0 --gate`; later phases are report only until their gate applies.

## 7. CI pipeline (GitHub Actions)

```
on: pull_request, push to main
jobs:
  lint-typecheck      biome check, tsc --noEmit, eslint boundaries, openapi:check, trace (fast)
  unit                vitest --project domain,server,ui,convex --coverage   (Node 24, pnpm cache)
  golden              vitest --project domain -t golden; upload artifacts
  einvoice-validate   needs golden; services: einvoice-tools (built from services/, cached) → validate all artifacts
  integration         services: convex-backend:<SHA> + postgres:17 + einvoice-tools → convex deploy → vitest --project integration
  e2e (3 shards)      docker compose (compose.dev.yml + CI overrides) → playwright (desktop, iphone, pixel) incl. axe + visual (in Playwright image)
  build-image         docker build (web, einvoice-tools) → push to GHCR with the git SHA tag (main only)
  deploy              main only, after all green: npx convex deploy (self-hosted URL + admin key secrets) →
                      Dokploy API application.deploy (image tag) → smoke test /api/health through the tailnet edge
nightly: stryker mutation, lighthouse, full KoSIT test-suite inbound parse, dependency audit (pnpm audit, osv-scanner)
```

- Branch protection: all jobs green, one review (self-review allowed for a solo owner but the checklist is required), golden changes need an explicit label `golden-change`.
- Secrets: `CONVEX_SELF_HOSTED_URL`, `CONVEX_SELF_HOSTED_ADMIN_KEY`, `DOKPLOY_URL`, `DOKPLOY_API_KEY`, `CI_CONVEX_INSTANCE_SECRET`, `GHCR_TOKEN`.

## 8. Definition of Done (per requirement)

- [ ] Failing test written first; it is named with the requirement ID
- [ ] Domain logic is pure and unit-tested (incl. edge cases from feature § 5)
- [ ] Convex function test for persistence, actor/audit and immutability
- [ ] API and MCP exposure tested (if listed in feature § 7)
- [ ] UI tested at component level; E2E for critical journeys on desktop **and** mobile projects
- [ ] German user-facing texts reviewed (no English leakage; legal terms correct)
- [ ] Accessibility: no axe violations
- [ ] Golden files updated with a justification (if output changed)
- [ ] Audit-log entries asserted for state changes
- [ ] Docs updated (feature file, OpenAPI, MCP tool description, Verfahrensdokumentation if the process changed)

## 9. Phase exit criteria (quality gates)

| Phase | Gate |
|---|---|
| P0 | CI pipeline complete; login/session, role and JWT security tests green; audit chain + mutation inventory test green; deploy to Dokploy from CI works; restore drill done once |
| P1 | All P1 MUST requirements traced; golden suite complete and KoSIT/Mustang green; E2E journeys "Angebot → Rechnung → Export + Versandmarkierung → Zahlung (Kontoauszug-Import und bar)", "Abschlag + Schluss", "Storno", "Mahnung (Export + Versandmarkierung)", "Kontoauszug-Import mit Zuordnung" (T07-151, owner's anonymised Revolut month), "Website-API checkout", "MCP flow" green on 3 viewports; cash property tests (RI-11) green; sales, payment and cash journal postings (F08) golden-tested and RI-12 green; **sevdesk export import dry run with real data (preview + commit in the pilot instance) green**; MCP eval 20/20; Verfahrensdokumentation v1 reviewed; pilot running on the production stack (09 P1) |
| P2 | Inbound E-Rechnung test suite (KoSIT + FeRD) 100 % parsed; redirect URL whitelisted on the public app host (F07 BNK-115, no spike since public edge mode) and Enable Banking sandbox E2E (consent → callback backfill → poll → match → renewal, T07-150) plus all MSW fixtures green; R2 e-mail-in idempotency tests green; OCR accuracy ≥ 95 % field-level on the fixture set; UStVA/ZM golden datasets green and the Mein ELSTER guide data verified against the official forms of the year (moved from P3); E2E journeys „Beleg bar bezahlt", „Beleg privat bezahlt" and „UStVA-Ausfüllhilfe → Transferticket → Sperre" green; **go-live checklist (09 P2) completed** |
| P3 | EÜR and USt-Jahr golden datasets green; EÜR guide data verified against the official forms of the year; two real UStVA periods (after the go-live) entered without an ELSTER cross-check mismatch; GDPdU export validated against the DTD; DSGVO flows E2E |
| P4 | ERiC test submissions against the ELSTER test environment (if built); feature-specific gates per item. (Portal/online payments are deferred.) |
