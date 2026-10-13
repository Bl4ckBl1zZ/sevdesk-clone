# 02 — Architecture

> **Status:** v1.1 · 2026-10-12 (platform update: Better Auth login, tailnet-only network, Cloudflare auth mail, R2 backups, Enable Banking bank sync) · Research: [`../research/11-tech-stack-consolidated.md`](../research/11-tech-stack-consolidated.md), [`03`](../research/03-convex-self-hosted.md), [`04`](../research/04-dokploy.md), [`05`](../research/05-nextjs-mcp-api.md), [`10`](../research/10-pdf-einvoice-libs.md), [`13`](../research/13-bank-sync-without-revolut-api.md), **[`14`](../research/14-auth-email-tailscale.md)** (authoritative for auth, e-mail and network)

## 1. System overview

There is **no public host**. Every endpoint is reachable only from inside the owner's tailnet. The owner's Dokploy fork publishes the one exposed compose service (Caddy) as a Tailscale Service; Caddy terminates TLS for all hostnames under `<BASE_DOMAIN>` (e.g. `buero.example.de`) with a wildcard certificate obtained via the Cloudflare DNS-01 challenge.

```
  Tailnet (tailb289f5.ts.net)                         Dokploy remote server "Proxmox PVE" (home, Germany)
  ───────────────────────────                         ┌─────────────────── compose "rechnungen" (one Dokploy compose) ───────────────────┐
  Owner devices (laptop, phone)  ──┐                  │                                                                                  │
  Claude Code / Claude Desktop     │  tcp:443         │  fork socat proxy ──▶ caddy (TLS *.<BASE_DOMAIN>, Cloudflare DNS-01)              │
    (mcp-remote) on a tailnet dev. ├────────────────▶ │    :443  app.        → web:3000      (UI, Server Actions, /api/auth/* → convex-site)│
  CI runner (tag:ci)               │                  │          api.        → web:3000      (/api/v1, /api/mcp, /api/docs, /api/health)     │
                                   │                  │          convex.     → backend:3210  (Convex API + WebSocket)                        │
  Website server (tag:website) ────┘  tcp:8443 only   │          convex-site.→ backend:3211  (HTTP actions: Better Auth, JWKS)               │
                                                      │          convex-dash.→ dashboard:6791 (+ Caddy basic auth + admin key)               │
  DNS (Cloudflare, "DNS only"):                       │    :8443 api.        → web:3000      (/api/v1/** only — website integration)         │
  app|api|convex|convex-site|convex-dash.<BASE_DOMAIN>│                                                                                  │
     A → TailVIP of the Caddy Tailscale Service       │  web (Next.js 16.4) ──http://backend:3210/3211──▶ backend (Convex) ──▶ postgres 17 │
                                                      │        └──http://einvoice-tools:8080──▶ einvoice-tools (KoSIT + Mustang)          │
                                                      │  (only caddy has `expose:`; all other services have no ports and stay internal) │
                                                      └──────────────────────────────────────────────────────────────────────────────────┘
  Outbound only (HTTPS from the server; nothing calls in):
    Cloudflare Email Sending REST API (auth mail + owner notifications) · Cloudflare R2 (backups, checkpoints, receipt-inbox bucket, P2)
    Bank sync: Enable Banking API (PSD2 AIS, polling every 6 h, P2) · Claude API (OCR, opt-in)
    BZSt eVatR + EU VIES (VAT-ID checks) · outbound webhooks to the owner's website · Let's Encrypt via Cloudflare DNS API (Caddy)
```

| Service (compose `rechnungen`) | Image / build | Exposure | Purpose |
|---|---|---|---|
| `caddy` | Caddy 2 built with `caddy-dns/cloudflare` (`ghcr.io/<owner>/rechnungen-caddy:<tag>`, built in CI) | **The only service with `expose: ["443", "8443"]`** → published by the fork as one Tailscale Service (`dokploy-<project>-<env>-<resource>-caddy-<8>.tailb289f5.ts.net`, plain TCP) | TLS edge: wildcard cert `*.<BASE_DOMAIN>` (DNS-01), routing by `Host`, port 8443 = API-only listener, basic auth on `convex-dash.`, security headers |
| `web` | Our `Dockerfile` (Next.js 16.4 standalone, Node 24) | none (reached via Caddy) | UI, Server Actions, REST API, MCP, `/api/auth/*` proxy to Better Auth, server-JWT issuer for API keys/MCP |
| `backend` | `ghcr.io/get-convex/convex-backend:<SHA>` | none (via Caddy as `convex.` / `convex-site.`) | Database, functions, scheduler, crons, file storage; **Better Auth runs here** as an HTTP action (port 3211) |
| `dashboard` | `ghcr.io/get-convex/convex-dashboard:<same SHA>` | none (via Caddy as `convex-dash.`) | Convex admin dashboard |
| `postgres` | `postgres:17` | none | Convex persistence (better backup tooling than SQLite); backed up by Dokploy to R2 |
| `einvoice-tools` | Our `services/einvoice-tools/Dockerfile` (Temurin 17 JRE + Node 24) | none | KoSIT validator daemon (XRechnung config bundle), Mustang CLI (ZUGFeRD/PDF-A validation, visualisation) |

Why one compose: the fork publishes **every** compose service that declares `ports:` or `expose:` as a tailnet service, and server-side calls should not hairpin through the tailnet. One compose with a single exposed edge keeps all other services on the internal compose network (`http://backend:3210`, `http://backend:3211`, `http://einvoice-tools:8080`), see [08-deployment.md §1](08-deployment.md#1-target-topology).

## 2. Technology stack (pinned 2026-10-12)

| Layer | Choice | Version |
|---|---|---|
| Runtime | Node.js | 24 LTS (`node:24-slim`) |
| Package manager | pnpm | 12.x (workspace) |
| Framework | Next.js App Router, `output: "standalone"`, `proxy.ts` | 16.4.x (**upgrade to the patch announced for 2026-10-14**) |
| UI | React 19.3, shadcn/ui CLI v4 (Base UI), Tailwind 4.3 | see [04-ui-ux.md](04-ui-ux.md) |
| Backend / DB | Convex self-hosted (`convex` npm) | 1.46.x, images pinned to one SHA |
| **Auth** | `@convex-dev/better-auth` (**Local Install** in `convex/betterAuth/`) + `better-auth` + `@better-auth/passkey`; plugins `passkey`, `emailOTP`, `twoFactor` (TOTP, optional), `convex({ authConfig, jwks })`. **Exact pins** — `better-auth` 1.7 breaks the component bundle ([issue #433](https://github.com/get-convex/better-auth/issues/433)); a Renovate rule blocks `better-auth >=1.7` until the component supports it | `@convex-dev/better-auth` **0.12.5**, `better-auth` **1.6.33**, `@better-auth/passkey` **1.6.33** |
| Validation | zod v4 (shared schemas: forms, Convex args via `zodToConvex`, REST, MCP) | 4.6.x |
| PDF | `@react-pdf/renderer` with `conformance="PDF/A-3b"`, registered TTF fonts (Inter + Inter Tight; Noto Sans fallback) | 4.9.x |
| PDF post-processing | `@cantoo/pdf-lib` (`embedFacturX`, attachments). **Not** `pdf-lib` (dead since 2021) | 2.11.x |
| E-Rechnung XML | Own EN 16931 model (`src/domain/einvoice/model.ts`) → serializer adapter. Serializer: own deterministic CII + UBL writers (`src/domain/einvoice/cii.ts`, `ubl.ts`) — the ADR-007 fallback, taken after P0 spike 5 found gaps in `@e-invoice-eu/core` (CII notes invalid against the Factur-X EN16931 XSD, runtime footprint; docs/adr/0004). The library stays pinned for the spike script and as a cross-check | own / 3.4.x |
| E-Rechnung validation | KoSIT validator 1.6.3 + `xrechnung-3.0.2-validator-configuration-2026-08-31`; Mustang CLI 2.26.0 (includes veraPDF) | sidecar |
| Inbound parsing | `@cantoo/pdf-lib` `getAttachments()` (fallback `pdfjs-dist`), `fast-xml-parser` 5.x (values kept as strings), `postal-mime` (raw `.eml` from the R2 receipt inbox, P2) | |
| MCP | `mcp-handler` 2.x + `@modelcontextprotocol/server` 2.x (spec 2026-07-28, stateless) | 2.3.x |
| REST docs | `zod-openapi` 6 (OpenAPI 3.1) + `@scalar/nextjs-api-reference` | |
| Webhooks (outbound only) | `standardwebhooks` (Standard Webhooks spec) | 1.1.x |
| Rate limiting | `@convex-dev/rate-limiter` — **per API key** and **per e-mail address** (OTP sends). Never per client IP: behind the fork's socat proxies every request has the same source address | 0.4.x |
| Email (auth only) | Cloudflare Email Sending **REST API** (public beta) called with `fetch` from a Convex action, behind a small `AuthMailSender` interface so Resend/SMTP could replace it. **The app never e-mails customers** (no SMTP, no IMAP) | REST v4 |
| Object storage | Cloudflare R2 via the S3 API (`aws4fetch` signing in Convex actions): checkpoint bucket, receipt-inbox bucket (P2), read-only backup listing | |
| QR / banking | `qrcode`, `ibantools`, own EPC payload builder; **Enable Banking** client (own, RS256 app JWT via `jose`, behind a thin `BankFeedProvider` interface so the domain consumes one normalised transaction shape); CAMT.053 (`fast-xml-parser`) and Revolut CSV statement import as the always-available fallback (MT940/PDF only if F07 keeps them) | |
| OCR / AI | `@anthropic-ai/sdk`, structured outputs (`output_config.format`), default model `claude-sonnet-5-5`, configurable; opt-in (DSGVO-04) | 0.133.x |
| Testing | Vitest **4.1.x** (pinned until convex-test supports 5), convex-test, Testing Library, Playwright 1.64 (virtual WebAuthn authenticator for passkey flows), MSW 3, fast-check, `@axe-core/playwright` | see [07-testing.md](07-testing.md) |
| Lint/format | Biome (lint + format) + `tsc --noEmit` strict, plus targeted ESLint rules for architecture boundaries (`no-restricted-imports`, banned `ctx.db.patch` outside the model layer; `convex/betterAuth/**` allowlisted) | |

## 3. Repository layout

```
/
├─ src/
│  ├─ app/                       # Next.js App Router
│  │  ├─ (auth)/anmelden/…       # sign-in (passkey, e-mail OTP, TOTP step), invite acceptance, first-run owner sign-up
│  │  ├─ (app)/…                 # signed-in UI (German routes, see 04-ui-ux §3.4); role checks per route
│  │  ├─ api/auth/[...all]/route.ts  # re-exports the Better Auth handler: proxies to http://backend:3211/api/auth/*
│  │  ├─ api/v1/…                # REST API route handlers (api. host)
│  │  └─ api/mcp/route.ts        # MCP endpoint (api. host)
│  ├─ proxy.ts                   # host allowlist + optimistic session redirect + security headers
│  ├─ domain/                    # PURE TypeScript, no I/O. The heart of compliance.
│  │  ├─ money/                  # cents arithmetic, rounding, parsing, formatting
│  │  ├─ tax/                    # VAT categories, rate tables, tax-case derivation, KU monitor
│  │  ├─ documents/              # totals, validation rules, lifecycle state machines
│  │  ├─ einvoice/               # EN 16931 model, mapping, ER-03 decision, Leitweg-ID
│  │  ├─ numbering/              # number-format templates and the normaliser
│  │  ├─ dunning/                # interest (§288), fees, schedule rules
│  │  ├─ accounting/             # SKR03/04 mapping, journal generation, EÜR, AfA
│  │  ├─ reports/                # UStVA Kennzahlen, ZM, EÜR line mapping (versioned)
│  │  ├─ datev/                  # EXTF writer
│  │  ├─ gdpdu/                  # Z3 export writer (index.xml)
│  │  ├─ banking/                # normalised bank-feed transaction mapping, CAMT/CSV/MT940 parsing, matching scorer
│  │  ├─ epc/                    # GiroCode payload
│  │  ├─ access/                 # roles, permission matrix, sign-up gate (pure: `canDo(role, action)`, `assertSignupAllowed`)
│  │  ├─ rules/                  # date-effective rule tables (JSON/TS data) + lookup helpers
│  │  └─ schemas/                # zod schemas shared by UI, Convex, REST and MCP
│  ├─ emails/                    # German auth-mail texts (OTP, invite, owner notification) as plain functions
│  ├─ pdf/                       # react-pdf document components (invoice, quote, reminder, …)
│  ├─ server/                    # server-only Next helpers: api-key auth, mcp tools
│  ├─ components/                # UI components (shadcn + app components)
│  └─ lib/                       # auth-client (passkeyClient, emailOTPClient, twoFactorClient, convexClient); server-only: auth-server
│                                #   (Better Auth Next helpers, requireSession/requireRole), server-jwt (server-JWT minting) — P0 put all auth
│                                #   helpers next to each other in src/lib (2026-10-12)
├─ convex/
│  ├─ schema.ts
│  ├─ auth.config.ts             # two customJwt providers: Better Auth (RS256, static JWKS) + server JWT (ES256) for api-key/mcp
│  ├─ auth.ts                    # createAuth / createAuthOptions (Better Auth options, sign-up gate, triggers)
│  ├─ betterAuth/                # Local Install component (schema generated by `npx auth generate`) — allowlisted in the mutation inventory
│  ├─ functions.ts               # customQuery/customMutation wrappers: identity, role, actor, audit, triggers
│  ├─ model/                     # write helpers per aggregate (the ONLY place, besides convex/betterAuth/**, that calls ctx.db.insert/patch)
│  ├─ <feature>.ts               # public queries/mutations per feature (thin)
│  ├─ actions/                   # actions: pdf render, auth mail (Cloudflare), ocr, bank-feed sync, R2, einvoice-tools calls
│  ├─ crons.ts
│  ├─ http.ts                    # HTTP actions: authComponent.registerRoutes(http, createAuth) — /api/auth/* on the site origin
│  └─ _generated/                # committed (so CI can typecheck without a backend)
├─ services/einvoice-tools/      # Dockerfile + tiny Node HTTP wrapper around KoSIT daemon + Mustang CLI
├─ e2e/                          # Playwright specs, fixtures, visual baselines
├─ test/fixtures/                # golden invoices, KoSIT test suite, FeRD samples, bank statements
├─ deploy/                       # compose, Caddyfile, Dokploy scripts (custom dokploy CLI), runbooks
├─ docs/spec/, docs/research/, docs/verfahrensdokumentation/
└─ CLAUDE.md                     # agent working rules (TDD, IDs, boundaries)
```

### Dependency rules (enforced by lint)

- `src/domain/**` imports nothing from `convex/`, `src/app/`, React or Node APIs. It is deterministic and pure. All "now" values are passed in.
- `convex/**` may import `src/domain/**` and `src/domain/schemas/**`.
- `src/app/**` and `src/components/**` may import `src/domain/**` (for client-side live totals) and `convex/_generated/api`.
- Only `convex/model/**` calls `ctx.db.insert/patch/replace/delete`. Every other module goes through model functions, which enforce lifecycle and immutability (GOBD-06). **Single exception:** `convex/betterAuth/**` (the Better Auth component adapter writes `user`, `session`, `account`, `verification`, `passkey`, `twoFactor`, `jwks`). These are auth records, not bookkeeping records; the mutation-inventory test and the lint rule allowlist exactly this folder. Our own auth-related tables (`members`, `invites`, `apiKeys`) are written only through `convex/model/**`.

## 4. Security model (login + tailnet)

**Owner decision (2026-10-12, replaces "no login + gate"):** two independent layers.
1. **Network:** tailnet only. No hostname is reachable from the internet; there are no inbound webhooks, no public portal, no public auditor route.
2. **Login:** every human signs in with **Better Auth** (passkey first, e-mail OTP fallback, no passwords; optional TOTP). Roles from our own `members` table decide what each person may do. Machines (REST API keys, MCP) authenticate with API keys.

GoBD Rz. 100–103, §146 Abs. 4 AO and Art. 32 DSGVO expect access control and attribution (research 01 §11); both layers are documented in the Verfahrensdokumentation "Zugriffskonzept" (SEC-07).

### 4.1 Hosts and listeners (all tailnet-only, TLS at Caddy)

| Host · port | Who (tailnet grant) | Upstream | Reachable routes | Protection |
|---|---|---|---|---|
| `app.<BASE_DOMAIN>` · 443 | Owner devices, members' devices (`autogroup:admin` / invited users) | `web:3000` | UI routes, Server Actions, `/api/auth/*` (proxied to Better Auth on `convex-site.`), `/api/health` | Better Auth session (cookie, `__Secure-`); role check in every page, Server Action and Convex function |
| `api.<BASE_DOMAIN>` · 443 | Owner devices, Claude Code / Claude Desktop (`mcp-remote`) on a tailnet device | `web:3000` | `/api/v1/**`, `/api/mcp`, `/api/docs`, `/api/openapi.json`, `/api/health` | API key (`Authorization: Bearer sk_live_…`), scopes, rate limit per key. `proxy.ts` returns 404 for every other path on this host |
| `api.<BASE_DOMAIN>` · **8443** | `tag:website` only (the website's server joined to the tailnet) | `web:3000` | **`/api/v1/**` only** (Caddy rejects everything else with 404) | Same API-key checks. A separate port is needed because tailnet grants are per Service + port, not per hostname, and the edge cannot tell callers apart by IP |
| `convex.<BASE_DOMAIN>` · 443 | Signed-in browsers (WebSocket), CI (`tag:ci`) for `npx convex deploy` | `backend:3210` | Convex API | Public Convex functions **always** require a valid JWT (Better Auth user or server JWT) via the wrappers |
| `convex-site.<BASE_DOMAIN>` · 443 | Browsers (indirectly; Next proxies `/api/auth/*`) | `backend:3211` | Convex HTTP actions: Better Auth `/api/auth/*`, `/api/auth/convex/jwks` | Better Auth itself; no other HTTP actions are public |
| `convex-dash.<BASE_DOMAIN>` · 443 | Owner, rarely | `dashboard:6791` | Convex dashboard | Caddy basic auth + Convex admin key |

`proxy.ts` (runs on every request to `web`):
1. Resolve the host (`APP_ORIGIN` / `API_ORIGIN`). Unknown host → 421 (DNS-rebinding protection, SEC-06).
2. On `api.`: path allowlist above; everything else → 404. No cookies are honoured on `api.` (API keys only).
3. On `app.`: if the path is not public (`/anmelden/**`, `/api/auth/**`, `/api/health`, static assets) and **no Better Auth session cookie** is present (`getSessionCookie(request)`), redirect to `/anmelden?weiter=<path>`. This is an **optimistic** check only (no round trip to Convex); the authoritative check happens in every Server Component, Server Action, route handler and Convex function.
4. Security headers: strict CSP (nonce-based), `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, HSTS, `Permissions-Policy` (camera only on `app.` for receipt capture; `publickey-credentials-get/create` on `app.` for passkeys).
5. Server Actions are POSTs to page routes, so every Server Action calls **`requireRole(action)`** (replaces the former `assertGate()`): `isAuthenticated()` + member lookup + role/permission check from `src/domain/access`. Next.js enforces same-origin for Server Actions (CSRF); `serverActions.allowedOrigins` is restricted to `app.<BASE_DOMAIN>`.

**Client IP is not available.** The fork's socat proxies terminate the tailnet connection, so `web` and Convex see the proxy container's address. Consequences: no rate limiting or allowlisting by IP (Better Auth's IP rate limit is **disabled**), audit entries carry no client IP, API keys have no IP allowlist. Rate limits are per API key and per e-mail address.

### 4.2 Login (Better Auth inside Convex)

**Packages and mode.** `@convex-dev/better-auth` 0.12.5 in **Local Install** mode (`convex/betterAuth/`, schema generated with `npx auth generate`), because the passkey plugin adds a table. `better-auth` and `@better-auth/passkey` pinned to exactly **1.6.33**.

**How it runs.**
- Better Auth runs **inside Convex** as an HTTP action on the site origin (`backend:3211`, public name `https://convex-site.<BASE_DOMAIN>`), mounted by `authComponent.registerRoutes(http, createAuth)` under `/api/auth/*`.
- `src/app/api/auth/[...all]/route.ts` re-exports the handler from `convexBetterAuthNextJs({ convexUrl: CONVEX_URL_INTERNAL, convexSiteUrl: CONVEX_SITE_URL_INTERNAL })`, which forwards to `http://backend:3211/api/auth/*`. Cookies therefore stay first-party on `app.`.
- The `convex()` plugin issues a **15-minute RS256 Convex JWT** at `/api/auth/convex/token` (`iss` = `CONVEX_SITE_URL` = `https://convex-site.<BASE_DOMAIN>`, `aud` = `"convex"`, `sub` = Better Auth user id, plus `sessionId`). `ConvexBetterAuthProvider` refreshes it automatically.
- **Static JWKS:** the key set lives in the Convex env variable **`JWKS`** (`npx convex run auth:rotateKeys | npx convex env set JWKS`) and is passed to both `getAuthConfigProvider({ jwks })` and `convex({ authConfig, jwks })`. The backend therefore never fetches its own public URL to verify tokens (the classic self-hosted failure; inside the tailnet-only setup the backend may not even resolve its own public name).

**Options (`convex/auth.ts`, abridged; research 14 §2.4):**

| Option | Value | Why |
|---|---|---|
| `baseURL` / `trustedOrigins` | `SITE_URL` = `https://app.<BASE_DOMAIN>` (static, never inferred from the request) | Proxied requests |
| `emailAndPassword` | `{ enabled: false }` | No passwords, no reset mails |
| `passkey({ rpID, rpName, origin })` | `rpID` = **`<BASE_DOMAIN>`** (`PASSKEY_RP_ID`), `origin` = `https://app.<BASE_DOMAIN>`, `rpName` = company short name | Primary login. Never use the registrable parent domain if a public website lives there. **Changing `rpID` invalidates every passkey**, so e-mail OTP stays the recovery path |
| `emailOTP({ otpLength: 6, expiresIn: 600, sendVerificationOTP })` | Code mails via Cloudflare (§9); `sendVerificationOTP` first checks the **per-address throttle** (`@convex-dev/rate-limiter`, 5 sends/hour/address, 20/day) | Fallback and recovery; codes, not links |
| `twoFactor({ issuer, allowPasswordless: true })` | Optional TOTP per user (off by default). Better Auth 1.6 gates only password sign-ins with 2FA, so **we extend the plugin's after-hook to `/sign-in/email-otp`** (`totpForEmailCodeSignIns` in convex/auth.ts): an e-mail-code sign-in of a user with TOTP enabled creates **no session and no JWT** — the response is `{ twoFactorRedirect: true }` plus the short-lived two-factor cookie, and only `twoFactor.verifyTotp` creates the session. Wrappers and `requireRole()` therefore never see a "pending" session (a caller without session is simply signed out). Passkey sign-ins are exempt (already two factors). *Changed from a `totpPending` session marker: no session at all is simpler and cannot leak a usable JWT.* | Owner wish; extra factor for the OTP fallback path |
| `databaseHooks.user.create.before` | `assertSignupAllowed(ctx, email)` — the **single sign-up gate** (§4.3) | No public sign-up |
| `session` | `expiresIn` 7 days, `updateAge` 1 day, `freshAge` 600 s; **`cookieCache` off** | #434: with cookieCache on, the token endpoint mints JWTs for deleted sessions |
| `advanced.useSecureCookies` | `true` | HTTPS everywhere via Caddy |
| `rateLimit` | `{ enabled: false }` | IP-based limiting is meaningless behind the proxy; `"database"` storage has open OCC bugs (#432) |
| Not used | magic link, admin, organization, api-key, oauth-provider (#395 breaks `convex()`), sso | Fewer moving parts; roles and API keys are ours |

**Fresh session for ⚠ actions.** Finalise, send, Storno, payment record/reverse, period lock, DATEV export with lock, purge, member/role changes and API-key creation require a session younger than `freshAge` (10 min) or a fresh passkey assertion; otherwise the UI opens the re-authentication dialog (04 §4.9).

### 4.3 Sign-up gate, members and roles

**Sign-up gate (`assertSignupAllowed`, pure rule in `src/domain/access`, called from the Better Auth hook):**
1. **Bootstrap:** while **no user exists**, only `email === OWNER_EMAIL` (case-insensitive, trimmed) may be created. The trigger then inserts `members { role: "owner" }`.
2. **Invite-only afterwards:** a user may be created only if an unexpired, unrevoked, unaccepted `invites` row matches the e-mail. The trigger inserts the member with the invite's role (and `expiresAt` / auditor scope) and marks the invite accepted.
3. Otherwise throw `APIError("FORBIDDEN")` (HTTP 403 with the German message, e.g. „Für diese E-Mail-Adresse besteht keine Einladung.", audited `security.access_denied` with a hashed address). No user, no session is created (exact abort semantics of 1.6 covered by a test). The sign-in page shows the 403 message only during first run; otherwise it gives the neutral answer of 04 §4.9.

**First-run flag.** `/anmelden` shows the first-run notice while no member exists. The web server reads it from the Better Auth endpoint `GET /api/auth/rechnungen/first-run` (a small plugin in convex/auth.ts that runs the internal query `signup.firstRun`), so no public Convex function without the wrappers and no admin key in `web` are needed; an unreachable backend counts as "not first run".

**Roles (`members.role`):**

| Role | Can | Cannot | Expiry |
|---|---|---|---|
| `owner` | Everything: all business writes, settings, members & invites, API keys/MCP/webhooks, integrations, rule overrides, purge/DSGVO execution, Verfahrensdokumentation release, restore-drill log | — | never (exactly one owner) |
| `bookkeeper` | Read everything + bookkeeping writes: drafts, finalise/send/cancel, payments, dunning runs, vouchers, inbox, bank matching/marks, cash, journal, period lock, DATEV/GDPdU exports, imports | Any `/einstellungen/**` write, members/invites, API keys/MCP/webhooks, integrations and secrets, rule overrides, purge/DSGVO execution, Verfahrensdokumentation release | optional `expiresAt` |
| `viewer` | Read-only: all lists, documents (archived originals), reports, CSV downloads | Every write | optional `expiresAt` |
| `auditor` | Read-only **Z1** access for a Betriebsprüfer, limited to the granted fiscal years (`members.auditor.fiscalYears`); read-only master data (contacts, products — `contacts.read`, `products.read`); downloads of archived originals, reports, audit log, Verfahrensdokumentation and the Z3 (GDPdU) packages the owner generated for those years; **every request is audited** (`auditor.access`) | Every write (403, route-table test), settings secrets, API keys, webhooks, DSGVO register | **mandatory** `expiresAt`, ≤ 30 days per grant, extendable (F12 AUD-022) |

- The permission matrix lives in `src/domain/access/permissions.ts` (`canDo(role, action, context)`), is shared by UI (hide/disable), Server Actions (`requireRole`), REST/MCP (not applicable: keys have scopes) and the Convex wrappers (authoritative). A table-driven test covers every (role × action) pair.
- **Expiry and disabling:** a member past `expiresAt` or with `disabledAt` set is treated as signed out on the next request; their sessions are revoked by the `members.expire` cron (§7). Removing a member revokes all sessions immediately (`auth.api.revokeUserSessions`).
- The auditor replaces the former token-protected `/pruefung/[token]` route: the owner invites the Betriebsprüfer's e-mail with role `auditor`, fiscal years and validity. The auditor signs in with e-mail OTP (and may enrol a passkey) **from a device inside the tailnet**: on-site on a device provided by the owner (default), or remotely after the owner admits the auditor's device to the tailnet with a grant limited to `app.` tcp:443 (Verfahrensdokumentation "Prüferzugang-Anleitung"; F12 AUD-022).
- Login and logout are audited from Better Auth **session triggers** (`createClient(…, { triggers: { session: { onCreate, onDelete } } })`, same transaction) through `convex/model/audit` (`auth.sign_in`, `auth.sign_out`, method passkey/otp, TOTP used).

### 4.4 Identity and attribution (actors)

Every Convex call carries a JWT from one of **two providers** registered in `convex/auth.config.ts`:

| Provider | `type` / `applicationID` | Algorithm / keys | Used for |
|---|---|---|---|
| Better Auth (`getAuthConfigProvider({ jwks: process.env.JWKS })`) | `customJwt` / `"convex"` (exactly one provider may use it) | RS256, static JWKS from the `JWKS` env | Signed-in humans (`sub` = Better Auth user id) |
| Server JWT | `customJwt` / `"rechnungen-server"`, `issuer: "https://api.<BASE_DOMAIN>"` | ES256, `JWT_PRIVATE_KEY_PEM` in `web`; public key as a `data:` URI JWKS in the Convex env `SERVER_JWKS` (no fetch); rotation via `kid` | REST (`api-key:<keyId>`) and MCP (`mcp:<keyId>`) requests, minted by `web` after verifying the API key |

**Canonical actor format** (used in audit entries, `createdBy`/`finalizedBy`, API responses and filters): the string `"<kind>:<id>"` with exactly these kinds: **`user`**, **`api-key`**, **`mcp`**, **`system`**; **`portal`** is reserved for the deferred customer portal (F10) and is never minted while the portal is deferred. No other spellings (`owner:`, `auditor:`, `apiKey`, `api_key`, `key:`) are allowed; a zod schema in `src/domain/schemas/actor.ts` enforces `^(user|api-key|mcp|portal|system):[A-Za-z0-9._\-]+$` (03 §0.1). The member's **role at the time of the action** is stored next to the actor (`auditLog.actorRole`), not inside it, so the identifier stays stable when a role changes. Display data (user e-mail/name, key name, MCP client) is stored separately.

| Actor | When | Identity source | Extra |
|---|---|---|---|
| `user:<betterAuthUserId>` | Signed-in browser on `app.` (UI, Server Actions) | Better Auth JWT `sub`; writes also call `authComponent.safeGetAuthUser(ctx)` (session row exists and is not expired — a bare JWT stays valid up to 15 min after sign-out) and load the `members` row | `actorRole` = `owner \| bookkeeper \| viewer \| auditor`, channel `ui` |
| `api-key:<keyId>` | REST request with a valid API key (`<keyId>` = the key's public ID `apiKeys.prefix`) | Server JWT `sub` | `scopes`, `chan: "api"`, `keyName` |
| `mcp:<keyId>` | MCP request with a valid API key | Server JWT `sub` | `scopes`, `chan: "mcp"`, `keyName`, `client` (from MCP client info) |
| `system:<job>` | Convex crons/scheduler (no JWT; internal functions) | job registry | Scheduled jobs: `system:cron.<job>` with the §7 job name (e.g. `system:cron.dunning.run`, `system:cron.recurring.generate`); other internal processes: `system:ku-monitor`, `system:migration.<name>`, `system:restore`, `system:auth` (member created by the sign-up trigger) (03 §0.1) |
| `portal:<tokenId>` | **Reserved** (F10 deferred) | — | — |

- Every public Convex function is built with `convex/functions.ts` wrappers (`convex-helpers` `customQuery`/`customMutation`):
  ```ts
  export const memberMutation = (action: Action) => customMutation(mutation, {
    args: {},
    input: async (ctx) => {
      const actor = await requireActor(ctx, action);   // user: session + member + role/expiry/TOTP; key: scopes
      return { ctx: { actor, db: withTriggers(ctx).db } };  // triggers = audit + immutability
    },
  });
  ```
- Scopes (keys) and roles (users) are checked in Next (fail fast) **and** in Convex (authoritative). Scope list: [05-api.md §2](05-api.md#2-api-keys-and-scopes). API keys are created only by the owner and are never tied to a user session.

### 4.5 Secrets

| Secret | Where | Notes |
|---|---|---|
| `BETTER_AUTH_SECRET` | Convex env | 32 random bytes; signs Better Auth cookies/tokens; rotation signs everyone out |
| `JWKS` | Convex env | Static Better Auth key set (`auth:rotateKeys`); rotation per `deploy/runbooks/rotate-secrets.md` |
| `JWT_PRIVATE_KEY_PEM` / `SERVER_JWKS` | `web` env / Convex env | ES256 server JWT for `api-key:`/`mcp:` actors |
| `CHECKPOINT_SIGNING_KEY_PEM` | Convex env (used only by the `integrity.checkpoint` action) | ES256 key that signs the daily audit checkpoints (JWS) written to the R2 checkpoint bucket (§4.6, SEC-04, F12 AUD-016). **Separate** from the other keys, so a leaked token key cannot forge checkpoints. The public key and its fingerprint are stored with each checkpoint (`kid`) and printed in the Verfahrensdokumentation; rotation via `kid`, old public keys kept |
| `CLOUDFLARE_EMAIL_API_TOKEN` | Convex env | Cloudflare API token with the Email Sending permission (exact label UNSURE, research 14 §3.1), scoped to the account that owns the sender domain |
| `CLOUDFLARE_DNS_API_TOKEN` | `caddy` env | Zone → DNS → Edit on the one zone of `<BASE_DOMAIN>`; used only for DNS-01 |
| `R2_CHECKPOINT_ACCESS_KEY_ID` / `_SECRET` | Convex env | R2 token limited to the checkpoint bucket (object write + read) |
| `R2_BACKUP_READONLY_ACCESS_KEY_ID` / `_SECRET` | Convex env | Read-only listing of the backup bucket for `backups.verify` |
| `R2_INBOX_ACCESS_KEY_ID` / `_SECRET` | Convex env (P2) | Read + delete on the receipt-inbox bucket only |
| `ENABLE_BANKING_APP_ID` / `ENABLE_BANKING_PRIVATE_KEY_PEM` | Convex env (P2) | Enable Banking application ID and its RS256 private key (signs the short-lived app JWT, ≤ 24 h, minted per request). The consent session ID returned after authorisation is stored encrypted with `APP_ENCRYPTION_KEY` in `bankConnections` |
| `APP_ENCRYPTION_KEY` | `web` env + Convex env | AES-256-GCM for secrets stored in Convex: the Enable Banking session ID, our outbound webhook secrets, ntfy token, Claude API key |
| `CONVEX_SELF_HOSTED_ADMIN_KEY` | CI secret + local `.env.local` only | Never in the runtime image. Never in the browser |
| `INSTANCE_SECRET` | compose env (`backend`) | Set explicitly (`openssl rand -hex 32`) |
| `CONVEX_DASH_BASIC_AUTH` | `caddy` env | bcrypt hash for the dashboard basic auth |
| API keys | Stored as SHA-256 hash only | Shown once |

Non-secret configuration that the security model depends on: `BASE_DOMAIN`, `OWNER_EMAIL`, `PASSKEY_RP_ID` (= `BASE_DOMAIN`), `SITE_URL`, `AUTH_MAIL_FROM`, `CLOUDFLARE_ACCOUNT_ID` (08 §5.2).

### 4.6 Tamper evidence (SEC-04, GOBD-06)

- The `auditLog` table is append-only and hash-chained: `hash = sha256(prevHash ‖ canonicalJson(entry))`, `seq` strictly increasing (assigned in the same transaction, so Convex's serializable transactions guarantee a total order).
- Each issued artifact (PDF, XML, validation report) stores `sha256`.
- A **nightly integrity job** (Convex cron) verifies the chain, re-hashes artifacts and checks that finalised documents still match their stored `snapshotHash`. Any failure produces a red dashboard banner, an e-mail to the owner (Cloudflare, §9) and a Dokploy notification.
- A **daily checkpoint** `{date, lastSeq, lastHash, counts}` is signed (ES256, `CHECKPOINT_SIGNING_KEY_PEM`) and written to a **dedicated Cloudflare R2 bucket** (`<prefix>-checkpoints`, key `checkpoints/YYYY/MM/DD.jws`). An **R2 bucket-lock retention rule** (10 years) on that bucket is **recommended (optional)**; without it the copy still lives off-host and the app's R2 token is scoped to this one bucket. An edit through the Convex dashboard or admin key, which bypasses app code, is detectable afterwards.

## 5. Data conventions

| Concept | Representation |
|---|---|
| Money | `int` cents (`number`, safe up to 2^53). Field suffix `Cents`. Currency ISO-4217 per document |
| Unit price | `int` in **1/10,000** of the currency unit (`unitPriceMicros`, 4 decimals) |
| Quantity | `int` in 1/1,000 (`quantityMilli`, 3 decimals) |
| Percent | `int` basis points (`1900` = 19.00 %) |
| Business date | `"YYYY-MM-DD"` string (no timezone) |
| Instant | `number` ms since epoch, UTC (Convex `_creationTime` plus our own `recordedAt`) |
| IDs | Convex `Id<"table">`. Public API exposes prefixed opaque IDs (`inv_…`, `con_…`) derived from the Convex ID |
| Snapshots | On finalisation, the full document (seller, buyer, lines, totals, texts, layout version, rule versions) is frozen into `documentSnapshots` as canonical JSON plus `snapshotHash` |
| Rule versions | Each document stores the IDs of the rule rows used (tax rates, note texts), so it can be reproduced exactly |

**Rounding (EN 16931):**
- line net = round_half_up(quantity × unit price − line discount, 2)
- VAT base per (category, rate) = Σ line nets (± document-level allowances/charges per category)
- VAT amount per group = round_half_up(base × rate, 2)
- gross = Σ bases + Σ VAT

Implemented once in `src/domain/documents/totals.ts`, property-tested with fast-check, and identical on client and server.

## 6. Document pipeline (finalise → artifacts → export → mark as sent)

```
Draft (editable, no number)
  │  user/API/MCP: finalize(docId, {invoiceDate?, reason?})
  ▼
[1] action finalizeDocument
     a. load the draft; run domain validators (blocking errors → abort with a structured error list)
     b. build a PREVIEW snapshot with the placeholder number "PREVIEW-0000"
     c. render the XML → POST einvoice-tools/validate (KoSIT). Errors → abort (nothing committed)  ← ER-12
  ▼
[2] mutation commitFinalization   (single serializable transaction)
     a. re-check that the draft is unchanged (version) and still valid
     b. assign the number from the number range (counter++), check uniqueness via index    ← UST-06
     c. freeze the snapshot (+ snapshotHash), set status "finalized", artifactStatus "pending",
        compute retentionUntil, post the journal entries (revenue/receivable), write the audit entry
  ▼
[3] action renderArtifacts (scheduled immediately; idempotent; retried with backoff)
     a. react-pdf → PDF/A-3b buffer
     b. XML (final number) → embedFacturX (ZUGFeRD) and/or a separate XRechnung XML
     c. validate: KoSIT (XML) + Mustang (hybrid PDF) → store the reports
     d. store the artifacts in Convex file storage, record sha256 → artifactStatus "ready"
     e. on unexpected validation failure: artifactStatus "blocked", sending disabled,
        alert the owner (the document stays finalized; resolution = correction/Storno)
  ▼
Export (files for the owner; audited) → owner sends with own tools → "Als versendet markieren" → sendLog (MAIL-02), status "sent" (F04 SND-16…24; the app transmits nothing)
```

**Status model (invoice family; canonical for every spec, same as 03 §4).** Three independent stored fields plus one derived flag:

| Axis | Values | Notes |
|---|---|---|
| `status` (stored, lifecycle) | `draft → finalized → sent`, `finalized\|sent → cancelled` (via Storno) | Only these transitions (F04 §4.2.5). Quotes/orders/delivery notes add their own lifecycle values (`accepted`, `invoiced`, …) |
| `artifactStatus` (stored, pipeline — **not** a document status) | `pending \| ready \| blocked` | `blocked` = finalisation committed but the artifact pipeline failed (step 3e): sending disabled, resolution via Storno/correction (EC-005/006). Shown as display status „Gesperrt (E-Rechnung)"; `status` stays `finalized` |
| `paymentStatus` (stored, receivable) | `open \| partially_paid \| paid \| credited \| written_off` (unset for drafts, Storno and cancelled documents) | Recomputed by every payment/correction mutation (F05 §4.3); `credited` = settled by Rechnungskorrektur/offset without cash (03 §4) |
| `overdue` (**derived, never stored**) | `paymentStatus ∈ {open, partially_paid}` and `dueDate < today` (Europe/Berlin) | Computed at read time by the pure `displayStatus()` (F04 §4.2.9); the `receivables.refreshOverdue` cron (§7) only emits the one-time `invoice.overdue` event and records `overdueNotifiedAt`; it never writes `status`/`paymentStatus` |

There is no stored status "open": „Offen" in the UI is the display label for a `sent` document with `paymentStatus = open`.

- Copies downloaded later are re-stamped "Kopie" (UST-34). The archived original is never modified.
- The same pipeline serves quotes and order confirmations (no E-Rechnung XML for those), delivery notes, reminders (Mahnungen), Storno and corrections.

## 7. Background work (Convex scheduler and crons)

| Job | Schedule | Notes |
|---|---|---|
| `products.applyScheduledPrices` | daily 00:05 Europe/Berlin | Pending base-price changes become the product price on their date, with audit entry (F03 PRD-031) |
| `receivables.refreshOverdue` | daily 00:15 | Finds invoices that became overdue since the last run (`paymentStatus ∈ {open, partially_paid}`, `dueDate < today`) and emits `invoice.overdue` **once** per document (records `overdueNotifiedAt`), refreshes dashboard counters. Writes **no** status: overdue is derived (§6, F05 PAY-044). If the dunning policy enables `dueSoonTodo`, creates one to-do „Bald fällig: {Nr.} am {Datum}" per open invoice due within `dueSoonDays` (default 3; no document, nothing sent, F05 DUN-053) |
| `members.expire` | hourly | Members past `expiresAt` (auditor grants, time-limited viewers/bookkeepers): revoke all their Better Auth sessions, audit `member.expired`; expired invites are marked expired (§4.3) |
| `contacts.recheckVatIds` | daily 01:30 | Re-checks VAT IDs of contacts with K/AE invoices in the last 12 months whose last valid check is > 90 days old; failures notify (F02 CON-059, MISC-04) |
| `integrity.verify` | daily 02:00 | Hash chain, artifacts, snapshots (SEC-04, F12 AUD-013) |
| `invariants.check` | daily 02:15 (also run in `afterEach` of every integration/E2E test) | Evaluates all regulatory invariants RI-01…RI-28 over the whole database ([10-edge-cases §2](10-edge-cases.md#2-regulatory-invariants-ri)); an ERROR finding blocks new finalisations until acknowledged; results in `integrityRuns` |
| `integrity.checkpoint` | daily 02:30 | Checkpoint signed with `CHECKPOINT_SIGNING_KEY_PEM` → R2 checkpoint bucket `checkpoints/YYYY/MM/DD.jws` (bucket-lock retention recommended); upload failures retried hourly, notification after 2 failures (F12 AUD-016) |
| `assets.depreciate` | monthly, 1st 05:00 (P2) | AfA run for the previous month: one journal entry per asset and period, idempotent, skipped (with finding) for locked periods (F08 AST-009, AO-03) |
| `backups.verify` | daily 05:30 | Lists the R2 backup bucket with read-only credentials: latest `postgres/`, `convex-export/`, `convex-volume/` objects, and the latest object in the checkpoint bucket (plus whether a bucket-lock rule exists); stale → notification (F12 AUD-026). Monthly restore-drill reminder, warning after 35 days without a drill (AUD-027, SEC-05) |
| `bank.sync` | **every 6 h** (05:30, 11:30, 17:30, 23:30 Europe/Berlin) (P2) | Enable Banking polling per mapped account (F07 BNK-106: `GET /transactions` from last booked date − 10 days; balances at most once a day unattended); enforces ≤ 4 unattended fetches per account and endpoint per 24 h; on `429 ASPSP_RATE_LIMIT_EXCEEDED` back off 6 h; dedupe by `entry_reference`; pending rows replaced, booked rows upserted; expired/revoked consent → connection `reauth_required` + notification, sync pauses (the next consent backfills; CAMT.053 import covers gaps). The history backfill runs inside the consent callback; „Jetzt abrufen" exists only in the UI with the owner present (F07 BNK-107). **No webhooks.** [research 13](../research/13-bank-sync-without-revolut-api.md) |
| `bank.consentExpiryReminder` | daily 08:00 (P2) | For every Enable Banking connection with a consent `validUntil` (PSD2: 180 days, Revolut EU maximum): notification 14 and 3 days before expiry and on expiry, with the re-consent link to the connection page `https://app.<BASE_DOMAIN>/einstellungen/bank/verbindung` (F07 §6.5, BNK-105); the bank redirects back to `https://app.<BASE_DOMAIN>/einstellungen/bank/callback`, which must be whitelisted in the Enable Banking application and HTTPS on `app.`; it does not have to be public (BNK-115) |
| `recurring.generate` | daily 06:00 | Creates invoices from active recurring templates; auto-finalise per template setting (F04 REC-05) |
| `recurringVouchers.generate` | daily 06:15 (P2) | Creates purchase-voucher drafts from recurring voucher templates (F06 VOU-064) |
| `dunning.run` | daily 07:00 | Evaluates dunning rules; creates reminder drafts or (if the policy enables auto-finalise) finalises them. **Never sends**: finalised reminders appear under „Zu versenden" for export and „Als versendet markieren"; invoices without a sent mark are skipped (`not_marked_sent`, F05 PAY-064). "Preview next run" is available in the UI (F05 DUN-030) |
| `bank.statementsTodo` | — (derived, no job) | **Amended 2026-10-13:** the to-do "Kontoauszug {Monat} importieren (CAMT.053 + PDF signiert)" per bank account is computed by the query `banking.todos` from accounts, statements and today (info from the 3rd, warning after the 10th, PDF missing; F07 BNK-030, EC-156, §4.10). A job is only needed once the notifications feature pushes it (F12/04 §4.7) |
| `inbox.pollR2` | every 5 min (P2) | Lists the R2 receipt-inbox bucket (`inbox/*.eml`, written by the Cloudflare Email Routing Worker `receipts-inbox`, 08 §3.4) oldest first, **at most 50 objects per run** (the rest next run). Per object independently: store the raw mail (SHA-256, the `.eml` is the original) and create the inbox item in one mutation; **delete the R2 object only after that mutation committed** — any failure leaves it for the next run, the object key is the dedupe key (`by_r2Object`). 401/403 pauses polling with a notification; an object older than 60 min raises a notification (F06 INB-049/052) |
| `webhooks.deliver` | event-driven + retry backoff | Outbox pattern (outbound only) |
| `deadlines.notify` | daily 08:00 | UStVA/ZM due dates, §14a 15th-of-month, KU thresholds and the 1-January prior-year KU test (F01 SET-E08), **quote expiry** (sets `expired` on quotes past `validUntil` and warns 3 days before, F04 QUO-04), limitation (Verjährung, F05 DUN-041), uninvoiced supplies and unbilled time (UST-01, F11 PRJ-015), period-lock suggestions (F08 ACC-018), contact tasks due (F02 CON-122), member expiry in 3 days |
| `dsgvo.deadlines` | daily 08:00 (P3) | DSGVO request register: reminders at due − 7 and due − 1 days, error notification when overdue (F12 PRV-010) |
| `notifications.digest` | daily 08:00 | Daily digest e-mail to the owner for `info`/`warning` notifications if chosen (F12 NTF-005; Cloudflare, §9) |
| `rules.freshness` | weekly | Warns if the rule tables are older than the newest known change (e.g. Basiszinssatz on 1 Jan/1 Jul not updated); flags overrides that duplicate shipped rows (F01 SET-124) |
| `retention.scan` | monthly | Builds the **purge worklist** of purge-eligible records (purge itself is always manual, GOBD-21, DSGVO-02, F12 PRV-003) |

Removed with the platform update: `revolut.expenses` (needed the Revolut Business API, which is not used), `cash.openDaysReminder` (no cash book any more, F07), `inbox.poll` (IMAP), `subscriptions.charge` (F10 deferred; returns with the portal).

Timers that run in `web` rather than as Convex crons: clock-skew check every 10 min (F12 AUD-019), checkpoint/head startup check at boot and every 6 h (AUD-014). Certificate expiry of the Caddy wildcard certificate is checked by the security page (F12 AUD-020) against `https://app.<BASE_DOMAIN>`.

Crons check `IS_TEST` and skip in E2E unless invoked explicitly.

## 8. einvoice-tools sidecar

A tiny, dependency-free Node HTTP server (`node:http`; Hono was dropped in P0 — four routes need no framework and the image needs no package install, ADR 0003) in a `eclipse-temurin:17-jre` + Node 24 image:

| Endpoint | Implementation | Response |
|---|---|---|
| `POST /validate/xml` (body: XML) | Forwards to the KoSIT daemon on `localhost:8081` (started with `-D --disable-gui`, scenarios from the pinned config bundle) | `{ acceptable: boolean, errors[], warnings[], reportXml, validatorVersion, configVersion }` |
| `POST /validate/pdf` (body: PDF) | `java -jar Mustang-CLI-2.26.0.jar --no-notices --action validate` | `{ valid, pdfaValid, xmlValid, reportXml, mustangVersion }` |
| `POST /visualize` (body: XML) | Mustang `--action visualize` → HTML | `text/html` (used only as a fallback; the main UI renders inbound XML with our own React view) |
| `GET /health` | | versions of all bundled tools |

The image tag includes the config bundle date (`einvoice-tools:2026-08-31-1`). Updating the KoSIT config is a PR that bumps the version and re-runs the golden validation suite (ER-12).

## 9. Email

**The app never e-mails customers.** There is no SMTP and no IMAP. Documents reach customers through the F04 flow: export the archived files, the owner sends them with their own mail program (or post/portal), then marks the document as sent (MAIL-02). E-mail is used only for:

| Purpose | Recipient | Trigger |
|---|---|---|
| Sign-in code (e-mail OTP) | the member signing in | Better Auth `sendVerificationOTP` |
| Invitation | the invited person | owner creates an invite (§4.3) |
| Owner notifications and digest (optional) | the owner's notification address | F12 NTF-003/005 |

- **Transport:** Cloudflare Email Sending **REST API** (public beta since 2026-04-16): `POST https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/email/sending/send` with `Authorization: Bearer {CLOUDFLARE_EMAIL_API_TOKEN}`, called with `fetch` from a Convex action (`convex/authMail.ts` for invite/test mails; the sign-in code is sent from the Better Auth `sendVerificationOTP` callback inside the HTTP action; transport in `convex/lib/authMail.ts`). Not under `convex/actions/`, because that folder is reserved for `"use node"` modules and the sender runs in the default runtime. No SDK, no Worker. The backend container needs egress to `api.cloudflare.com:443`.
- **Sender:** `AUTH_MAIL_FROM` (e.g. `noreply@mail.example.de`) on a domain that uses **Cloudflare DNS**; onboarding the domain in Email Service adds SPF/DKIM/DMARC automatically (merge an existing DMARC record instead of duplicating it).
- **Plan:** sending to arbitrary recipients probably needs **Workers Paid ($5/month, 3,000 mails included)**; sending to verified destination addresses may be free (docs contradict each other, UNSURE — test in P0).
- **Robustness:** the sender is behind the `AuthMailSender` interface (beta service; Resend or SMTP could replace it). Error codes (`10004 throttled`, `10105 not_entitled`, `10203 sending_disabled`, `10102 forbidden`) map to German messages; a failed OTP mail shows „Code konnte nicht gesendet werden — bitte später erneut versuchen" and is audited. Texts are German plain functions in `src/emails/`.
- **Incoming receipts (P2, F06):** Cloudflare Email Routing on a subdomain (e.g. `belege@in.example.de`) → an Email Worker writes the raw `.eml` to the R2 receipt-inbox bucket → the `inbox.pollR2` cron imports it. No inbound path into the tailnet is needed.

## 10. AI / OCR

- An opt-in setting with a clear DSGVO notice (the provider processes the data in the US unless an EU endpoint is configured; an AVV with Anthropic is required). The owner may disable OCR entirely; capture then works manually.
- The order is fixed: **structured E-Rechnung XML first (no AI needed)** → embedded ZUGFeRD → Claude vision with a zod JSON schema → human review queue for confidence < 0.9.
- A per-supplier learning table (`supplierProfiles`) stores the last account/category/tax rule and is used before calling the model.

## 11. Observability

- Structured JSON logs (pino) in `web` and the sidecar; Caddy access logs (JSON). Convex logs via the dashboard. Retention ≤ 90 days (DSGVO-06). Client IPs are not available behind the tailnet edge (§4.1).
- `GET /api/health` (web): checks Convex, the sidecar and Cloudflare Email reachability (cached 60 s); minimal body `{ status, version }`.
- Dokploy notifications (e-mail/ntfy) on deploy failure, container restarts and failed backups. The integrity job notifies the owner on failure.

## 12. Architecture Decision Records (summary)

Full ADRs live in `docs/adr/` (created in P0); this is the index:

| ADR | Decision | Rationale |
|---|---|---|
| 001 | Convex self-hosted with Postgres 17 (not SQLite) | Owner requirement (Convex). Postgres gives `pg_dump`-based backups through Dokploy and better durability. Single instance is enough for one business |
| 002 | ~~No in-app login; a network gate is mandatory; JWT actors~~ **Superseded by ADR-015/016** | Owner decision 2026-10-12 |
| 003 | Pure `src/domain` layer shared by UI, Convex, API and MCP | One implementation of every legal rule; testable without I/O |
| 004 | Integer money, fixed-scale quantities and prices | No float errors; EN 16931 rounding |
| 005 | Date-effective rule tables as data | Law changes = data changes; documents store the rule versions used |
| 006 | react-pdf (PDF/A-3b) + @cantoo/pdf-lib `embedFacturX` | Pure JS, no Chromium in the hot path; PDF/A support since react-pdf 4.9 |
| 007 | `@e-invoice-eu/core` behind our serializer interface; own CII builder as fallback — **fallback taken** (own CII + UBL writers, docs/adr/0004) | Mature, multi-syntax; the adapter keeps us independent. Spike 5: library merges BT-22 notes into one CII note (Factur-X XSD invalid for final invoices) and pulls `child_process` into the bundle |
| 008 | KoSIT + Mustang in a Java sidecar | Official validators; no reliable pure-JS alternative |
| 009 | No direct ELSTER (ERiC) in v1 | Closed C library, registration, redistribution limits; Kennzahlen sheet + DATEV instead |
| 010 | No POS/cash-register mode | Avoids §146a KassenSichV/TSE obligations |
| 011 | **Enable Banking (licensed PSD2 AISP) for read-only bank sync + CAMT.053/CSV statement import as fallback.** Polling every 6 h, no webhooks; consent renewal every 180 days (reminder cron); the consent redirect URL is HTTPS on `app.<BASE_DOMAIN>` (tailnet-only works because the redirect returns to the owner's browser). Rejected: open-banking.io (extra intermediary, early access); Revolut Business API (needs the Grow plan — future option only) | The owner's Revolut Business plan is below Grow; Enable Banking covers Revolut and costs nothing in restricted mode (written confirmation of the use requested, research 13 §6); a tailnet-only app cannot receive webhooks anyway; CAMT.053 + signed PDF stay the official Kontoauszug ([research 13](../research/13-bank-sync-without-revolut-api.md)) |
| 012 | MCP via `mcp-handler` 2.x, stateless, API-key bearer auth; **no OAuth** | Clients inside the tailnet (Claude Code, Claude Desktop via `mcp-remote`) send headers; claude.ai web/mobile/custom connectors connect from Anthropic's cloud and cannot reach the tailnet (06 §6) |
| 013 | Vitest 4.1 pinned | convex-test is documented with Vitest 4 only |
| 014 | ~~Two hostnames (`app.` gated, `api.` public subset)~~ **Superseded by ADR-016** | No public host any more |
| 015 | **Login with Better Auth** inside Convex (`@convex-dev/better-auth` 0.12.5, Local Install, `better-auth`/`@better-auth/passkey` pinned to 1.6.33): passkey first, e-mail OTP fallback, no passwords, optional TOTP; sign-up gate (bootstrap `OWNER_EMAIL`, then invite-only); roles in our own `members` table; static JWKS; cookie cache off; server-minted ES256 JWTs stay as the second provider for API keys and MCP | Real per-person attribution (`user:<id>` + role), time-limited auditor accounts instead of signed links, no password handling ([research 14 §1–2](../research/14-auth-email-tailscale.md)) |
| 016 | **Tailnet only, no public host**: the owner's Dokploy fork publishes the single `caddy` service as a Tailscale Service; Caddy terminates TLS with a Cloudflare DNS-01 wildcard cert for `*.<BASE_DOMAIN>`; hostnames `app.`, `api.`, `convex.`, `convex-site.`, `convex-dash.`; website access via a `tag:website` node limited to port 8443 | Nothing to attack from the internet; HTTPS needed for passkeys and secure cookies; stable names independent of the fork's naming ([research 14 §4](../research/14-auth-email-tailscale.md)) |
| 017 | **Cloudflare Email Sending REST API for auth mail only**; the app never e-mails customers; receipts arrive via Email Routing → Worker → R2 → polling (P2) | No SMTP credentials, no inbound path, domain already on Cloudflare DNS |
| 018 | **Cloudflare R2** for Dokploy backups (Postgres, Convex export, volume) and for signed checkpoints in a dedicated bucket with an optional bucket-lock retention rule | The owner already uses an R2 Dokploy destination; replaces the former "S3 with object lock" requirement |
