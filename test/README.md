# test/

| Path | Purpose (07-testing) |
|---|---|
| `fixtures/` | KoSIT test suite, FeRD samples, bank statements, receipts, sevdesk exports, inbox `.eml` (§3.3) |
| `golden/cases/<case-id>/` | golden-file suite (§4); change only with `pnpm golden:update` + written reason |
| `integration/` | Vitest project `integration` against a real self-hosted Convex backend (skips without `CONVEX_SELF_HOSTED_URL`) |
| `factories/` | `makeCompany`, `makeContact`, `makeProduct`, `makeInvoiceDraft` (shared by all layers) |
| `model/` | model-based property suite (fast-check `fc.commands`, §5a) |
| `invariants.ts` | `assertInvariants()` (RI-* checks; stub in P0) |
| `setup-invariants.ts` | `afterEach(assertInvariants)` for the `convex` and `integration` projects |
| `setup-ui.ts` | jest-dom matchers + cleanup for the `ui` project |
| `global-setup.ts` | Vitest global setup (sets `TZ=UTC`) |
