# CLAUDE.md — working rules for this repository

Self-hosted German invoicing & bookkeeping app (sevdesk clone) for one small business.
Bank: **Revolut Business**, synced read-only via **Enable Banking** (PSD2 AIS, polling) + CAMT.053/CSV statement import.
Stack: Next.js 16.4 (App Router, `proxy.ts`) · self-hosted Convex 1.46 · Better Auth (`@convex-dev/better-auth` 0.12.5, `better-auth`/`@better-auth/passkey` **pinned to 1.6.33** — 1.7 breaks the component) · shadcn/ui v4 + Tailwind 4 · Vitest 4.1 · Playwright · Dokploy fork with Tailscale Services (tailnet only, Caddy TLS edge) · Cloudflare Email Sending (auth mail only) + R2 (backups, checkpoints).

**The spec is the source of truth:** `docs/spec/` (start with `docs/spec/README.md`). Research backing it lives in `docs/research/`. If the code and the spec disagree, stop and ask, or fix the spec in the same PR with a reason.

## Non-negotiables

1. **TDD.** Write a failing test first, named with the requirement ID: `test("INV-012 assigns the number atomically", …)`. No production code without a test. See `docs/spec/07-testing.md`.
2. **German law is encoded, not improvised.** Every rule lives in `src/domain/**` (pure TS, no I/O, `today` passed in) and is referenced by its ID from `docs/spec/01-compliance.md`. Rates, thresholds, form mappings and note texts are **date-effective data** in `src/domain/rules/`; never hard-code a rate or date in logic.
3. **Immutability (GoBD).** Only `convex/model/**` may call `ctx.db.insert/patch/replace/delete` (sole allowlisted exception: the Better Auth component in `convex/betterAuth/**`, auth tables only). Finalised documents, payments, journal and cash entries, artifacts and audit entries are never updated or deleted. Corrections are new documents (Storno, Rechnungskorrektur, reversal). The mutation-inventory test must stay green.
4. **Money is integers.** `*Cents` (int), unit prices `*Micros` (1/10,000), quantities `*Milli`, rates in basis points. Never use float arithmetic on money. Rounding: EN 16931 half-up via `src/domain/money`.
5. **One implementation.** UI, Convex, REST and MCP share the zod schemas in `src/domain/schemas` and the domain functions. No business logic in route handlers, MCP tools or React components.
6. **Every write is attributed.** Public Convex functions use the wrappers in `convex/functions.ts` (actor from the JWT, role check, audit, triggers). Never create a public Convex function without them. Actors are always the string `"<kind>:<id>"` with kinds `user` (Better Auth user id; the member's role goes to `auditLog.actorRole`), `api-key`, `mcp`, `system`; `portal` is reserved and never minted while F10 is deferred (`docs/spec/02-architecture.md` §4.4, `03-data-model.md` §0.1). No other spellings (`owner:owner`, `auditor:…`, `apiKey`) — roles are not actor kinds.
7. **Login + tailnet.** Every human signs in with Better Auth (passkey first, e-mail OTP fallback, no passwords; sign-up only for `OWNER_EMAIL` while no user exists, then invite-only). Every page, route handler, Server Action (`requireRole()`) and Convex function checks the session **and** the role from `members` (`owner`, `bookkeeper`, `viewer`, `auditor`); `proxy.ts` only redirects optimistically. All hosts are tailnet-only (no public host, no inbound webhooks) — **except**: by owner decision 2026-10-18 the deployed instance runs in **public edge mode** (`EDGE_MODE=public`, `docs/spec/08-deployment.md` §12: Cloudflare → tunnel → Traefik → Caddy on the Dokploy domain); routing, login and role checks are unchanged, still no inbound webhooks; `api.` serves only `/api/v1`, `/api/mcp`, docs and health with API keys. Never rate-limit or allowlist by client IP (the proxy hides it) — rate-limit per API key / per e-mail.
8. **MCP safety.** Every legally relevant (⚠) tool — finalise, mark as sent (there is no send tool), cancel, record/reverse payments, run dunning, confirm bank matches or marks, cash transfers, book vouchers, merge contacts, DATEV export with lock, and any purge/erasure tool — needs the matching scope, `destructiveHint`, `requiresUserInteraction` and a valid `confirm_token` from a preview with the matching intent (`document_preview`, `dunning_preview` or `preview_action`; `docs/spec/06-mcp.md` §2).
9. **UI is German, responsive and accessible.** Test on the desktop, iPhone and Pixel Playwright projects. No axe violations. Use container queries in the main area.
10. **Edge cases and invariants** (`docs/spec/10-edge-cases.md`): every `EC-`/`RI-` ID has a test; `assertInvariants()` must pass after every test; a new legal bug gets an `EC-` entry before the fix.
11. **Golden files** (`test/golden/**`) change only with `pnpm golden:update` and a written legal/layout reason in the PR.

## Commands

```bash
pnpm dev            # next dev behind local caddy (https://app.localtest.me, internal CA; see docs/spec/08-deployment.md §10)
pnpm convex dev     # push Convex functions to the local self-hosted backend
pnpm test           # vitest (all projects); add -p domain|convex|server|ui|integration
pnpm golden         # golden-file suite; pnpm golden:update to rewrite (review the diff!)
pnpm e2e            # playwright (desktop, iphone, pixel)
pnpm trace          # requirement ↔ test traceability report
pnpm lint && pnpm typecheck
```

## Layout

`src/domain` (pure rules) · `convex/` (schema, `auth.ts` + `betterAuth/` component, wrappers, model, functions, actions, crons) · `src/app` (UI, `(auth)` sign-in pages, `api/auth` proxy, `api/v1`, `api/mcp`) · `src/pdf` (react-pdf documents) · `services/einvoice-tools` (KoSIT + Mustang sidecar) · `deploy/` (bootstrap via the custom Dokploy CLI, compose, Caddy edge, runbooks) · `test/` (fixtures, golden, integration) · `e2e/`.

## When unsure about a legal detail

Look the ID up in `docs/research/01-german-compliance.md`. If it is marked UNSURE or listed in "Open items" in `01-compliance.md`, implement the configurable/date-effective version, add a test for the current assumption, and leave a `// LEGAL-OPEN: <item>` comment linking the open item. Never guess silently.
