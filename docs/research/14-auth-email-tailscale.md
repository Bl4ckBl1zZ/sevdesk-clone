# Login (Better Auth + Convex), auth email (Cloudflare) and a Tailscale-only deployment (research as of 12 Oct 2026)

## How I verified this

- npm registry (`npm view`, `npm pack`) for every version and peer range quoted here. I read the published source of `@convex-dev/better-auth@0.12.5`, `@better-auth/api-key@1.6.33` and `cloudflare@7.3.0`.
- GitHub issues of `get-convex/better-auth`, `Dokploy/dokploy` and the source of `tailscale/tailscale` (via `gh`).
- Official docs: labs.convex.dev/better-auth, better-auth.com, developers.cloudflare.com, tailscale.com, doc.traefik.io, support.claude.com.
- **The owner's Dokploy fork** (`github.com/Bl4ckBl1zZ/dokploy`, server v0.41.1, released 2026-07-31, source at `/tmp/dokploy-fork/src`). I read its Tailscale integration (`packages/server/src/services/tailscale/*`, `packages/server/src/setup/tailscale-setup.ts`). I called nothing; this was read-only.

Labels used below:
- **UNSURE**: not confirmed by an official source or by code.
- **INFERENCE**: my own conclusion from code or docs.

---

## 0. Bottom line

| Topic | Decision / finding |
|---|---|
| Auth | `@convex-dev/better-auth` **0.12.5** with **`better-auth` pinned to `~1.6.33`**. Better Auth 1.7.x **breaks** the component (issue #433, open). Self-hosted Convex is supported. We need a **Local Install**, because passkeys (and API key / admin, if used) are not in the bundled schema. |
| Sign-in methods | **Passkey** (primary) plus **email OTP** (fallback and recovery). No passwords, so no TOTP is needed. Public sign-up is blocked by a `databaseHooks.user.create.before` gate (owner e-mail or a valid invite). Roles live in our own `members` table, not in the admin plugin. |
| API keys | **Keep our own `apiKeys` table** (scopes from `src/domain/schemas`, SHA-256, prefix, expiry, revocation instead of deletion). The Better Auth API key plugin works, but it writes on every verify and **defaults to 10 requests/day**. Its permission model and delete semantics fit GoBD-style auditing badly. |
| Auth email | **Cloudflare Email Service, REST API**, called with `fetch` from a Convex action. It is still **public beta** (since 2026-04-16). Arbitrary recipients need **Workers Paid** ($5/month, 3,000 mails included). Sending to *verified destination addresses* is free. The domain must use Cloudflare DNS. |
| Receipt inbox by e-mail | Cloudflare **Email Routing → Email Worker → R2**. The app **polls R2** from a Convex cron. This needs no inbound path into the tailnet. |
| Network | **Use the fork's Tailscale Services.** It publishes compose ports as plain **TCP** Tailscale Services (`svc:dokploy-…`, no TLS, no Traefik). Passkeys and secure cookies need HTTPS. So put **one TLS edge proxy (Caddy) in the app compose**: only its ports are exposed, it gets a wildcard cert via Cloudflare DNS-01 for e.g. `*.buero.example.de`, and the DNS names point at the Service's TailVIP. |
| Claude | Claude Code on a tailnet device can use the MCP server. Claude Desktop can too, but only through a **local** `mcp-remote` bridge. **claude.ai web/mobile and Desktop "custom connectors" cannot**: they connect from Anthropic's cloud. |
| Public website → REST API | The website's server joins the tailnet as `tag:website`. A grant allows only the edge's **API port** (a separate port, e.g. 8443). Tailscale Funnel is not recommended. |
| Retag (fork) | `confirmRetag` turns the deploy servers' user-owned Tailscale identity into `tag:dokploy`. That is required for Tailscale Services hosts, but it **can cut off Tailscale SSH** (and Dokploy's SSH, if it goes over the tailnet). Fix the policy first (see §4.1.5). |

---

## 1. Better Auth + Convex (`@convex-dev/better-auth`)

### 1.1 Versions (npm, 12 Oct 2026)

| Package | Latest | Notes |
|---|---|---|
| `@convex-dev/better-auth` | **0.12.5** (published 2026-06-27) | peer `better-auth >=1.6.11 <1.7.0`, `convex ^1.25.0`, `react ^18.3.1 \|\| ^19`. Deps: `jose ^6.1`, `zod ^4`, `convex-helpers`. It was built and tested against `better-auth 1.6.15`, `next 16.2.6` and `convex 1.41.0`. |
| `better-auth` | 1.7.7 (`latest`), **1.6.33** (`release-1.6`, 2026-09-14) | **Use 1.6.33.** 1.7.0 (2026-08-18) removed `better-auth/plugins/oidc-provider`, which the component imports. The result is a bundle failure: `Could not resolve "better-auth/plugins/oidc-provider"`. See [issue #433](https://github.com/get-convex/better-auth/issues/433) (open, with an unmerged PR #430). The docs say "pin `~1.6.15`". |
| `@better-auth/passkey`, `@better-auth/api-key` | 1.7.7 / **1.6.33** | Pin to the same 1.6.x as `better-auth`. Their peer ranges follow the core version. |
| `convex` | 1.46.0 | Matches our stack. |

**Action:** pin exact versions in `package.json` (`"better-auth": "1.6.33"`, `"@better-auth/passkey": "1.6.33"`). Add a Renovate rule that blocks `better-auth >=1.7` until the component release supports it. Issue #252 also says that internal dependency ranges drift.

### 1.2 How it works (from the source of 0.12.5)

- **Better Auth runs inside Convex.** It runs as an HTTP action on the **site origin (port 3211)**, mounted by `authComponent.registerRoutes(http, createAuth)` under `/api/auth/*`.
- **Next.js only proxies.** `app/api/auth/[...all]/route.ts` re-exports `handler` from `convexBetterAuthNextJs()`. That handler forwards the request to `${convexSiteUrl}/api/auth/...` with the cookies, and sets `x-better-auth-forwarded-host/proto`. The cookies therefore stay first-party on the app's host.
- **The `convex()` plugin adds three Better Auth plugins:** `jwt`, `bearer` and the (deprecated) `oidcProvider`.
- **Token endpoint.** The plugin exposes `/api/auth/convex/token`. It mints an **RS256** JWT with:
  - `iss = process.env.CONVEX_SITE_URL`
  - `aud = "convex"`
  - a default lifetime of **15 min** (`jwt.expirationSeconds`)
  - payload: the user fields minus `id` and `image`, plus `sessionId` and `iat`
  - `sub` = the Better Auth user `_id`

  JWKS is served at `/api/auth/convex/jwks`.
- **`convex/auth.config.ts`** uses `getAuthConfigProvider()`, which yields:
  ```ts
  { type: "customJwt", issuer: CONVEX_SITE_URL, applicationID: "convex", algorithm: "RS256",
    jwks: `${CONVEX_SITE_URL}/api/auth/convex/jwks` /* or a data: URI when a static JWKS is given */ }
  ```
  Exactly **one** provider with `applicationID: "convex"` is allowed. Other providers may coexist, so our existing **ES256 server JWT** for REST/MCP actors can stay as a second `customJwt` provider with its own issuer and `applicationID`.
- **Static JWKS (recommended for self-hosted and Tailscale):**
  ```bash
  npx convex run auth:rotateKeys | npx convex env set JWKS
  ```
  Then pass `getAuthConfigProvider({ jwks: process.env.JWKS })` and `convex({ authConfig, jwks: process.env.JWKS })`.

  This removes the backend's HTTP fetch of its *own* public site URL to verify tokens. That self-fetch is the classic self-hosted failure ("could not verify token", see 03-convex-self-hosted.md). In a tailnet-only setup the backend container may not be able to reach its own tailnet hostname at all. **INFERENCE.**

### 1.3 Self-hosted Convex

- **Officially supported.** The maintainer says "Self hosted is fully supported" ([#82](https://github.com/get-convex/better-auth/issues/82)). The repo's `examples/next` ships a self-hosted `docker-compose.yml` and a `.env.example` with:
  - `CONVEX_SELF_HOSTED_URL`
  - `NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210`
  - `NEXT_PUBLIC_CONVEX_SITE_URL=http://127.0.0.1:3211`
- **Requirements:**
  - `CONVEX_SITE_ORIGIN` on the backend must be the real HTTP-actions URL (port 3211 or its proxy). Inside Convex it becomes `process.env.CONVEX_SITE_URL`, which is used as the JWT issuer.
  - The Next.js side needs `NEXT_PUBLIC_CONVEX_SITE_URL`, or a server-only variable for the handler.
  - The usual failure mode is a wrong site URL or port ([#52](https://github.com/get-convex/better-auth/issues/52)).
- **Server-side URLs can be internal (INFERENCE from the source).** `convexBetterAuthNextJs({ convexUrl, convexSiteUrl })` only rejects `*.convex.cloud` as a site URL. The Next.js server can therefore use internal Docker URLs (`http://backend:3210`, `http://backend:3211`) for `fetchAuthQuery` and the auth proxy. Meanwhile the browser uses the TLS URLs. This avoids hairpinning through the tailnet from inside containers. The JWT `iss` does not depend on the URL Next.js uses; it is always the backend's `CONVEX_SITE_ORIGIN`.
- **Open proxy bugs (Convex Cloud).**
  - [#422](https://github.com/get-convex/better-auth/issues/422) and #424/#426: the handler forwards `x-forwarded-host` = app host, and Convex **Cloud's** edge router ("usher") 404s every `/api/auth/*` call. The same happens in SSR `getToken`.
  - A self-hosted backend has no usher and Traefik/Caddy route by `Host`, so self-hosted is **probably unaffected** (UNSURE).
  - Watch PR #423 anyway.
- **Other open issues to know:**

  | Issue | Problem |
  |---|---|
  | [#434](https://github.com/get-convex/better-auth/issues/434) | The token endpoint mints JWTs for *deleted* sessions when `session.cookieCache` is on. **Do not enable cookieCache.** |
  | [#398](https://github.com/get-convex/better-auth/issues/398) | Transient `clearAuth()` on page load. |
  | [#377](https://github.com/get-convex/better-auth/issues/377) | Duplicate token requests. |
  | [#395](https://github.com/get-convex/better-auth/issues/395) | `@better-auth/oauth-provider` breaks `convex()`. **Don't add an OAuth/MCP-provider plugin.** |

### 1.4 Next.js 16 App Router setup (abridged; follow labs.convex.dev/better-auth/framework-guides/next)

The guide's steps are: install, register the component, add `auth.config.ts`, set env vars, write `convex/auth.ts`, `lib/auth-client.ts`, `lib/auth-server.ts`, `convex/http.ts`, the catch-all route, and `ConvexBetterAuthProvider`.

```ts
// src/lib/auth-server.ts  (server-only)
import { convexBetterAuthNextJs } from "@convex-dev/better-auth/nextjs";
export const { handler, isAuthenticated, getToken, preloadAuthQuery,
  fetchAuthQuery, fetchAuthMutation, fetchAuthAction } = convexBetterAuthNextJs({
  convexUrl: process.env.CONVEX_URL_INTERNAL!,          // http://backend:3210 (same Docker network)
  convexSiteUrl: process.env.CONVEX_SITE_URL_INTERNAL!, // http://backend:3211
  jwtCache: { enabled: true, isAuthError },             // experimental; optional
});
// app/api/auth/[...all]/route.ts
export { GET, POST } from "@/lib/auth-server"; // = handler.GET / handler.POST
```

- **Client:**
  - `createAuthClient({ baseURL: NEXT_PUBLIC_SITE_URL, plugins: [convexClient(), passkeyClient(), emailOTPClient()] })`
  - `<ConvexBetterAuthProvider client={convex} authClient={authClient} initialToken={await getToken()}>` replaces `ConvexProvider`. `convex` here is a `ConvexReactClient` built with the browser URL `NEXT_PUBLIC_CONVEX_URL`.
- **SSR:** `preloadAuthQuery(api.x.y)` goes in Server Components, and `usePreloadedAuthQuery` (from `@convex-dev/better-auth/nextjs/client`) in Client Components. In Server Actions, call `fetchAuthMutation(...)`, and inside the mutation call `authComponent.getAuth(createAuth, ctx)` for `auth.api.*`.
- **`proxy.ts`:** the official example (`examples/next/proxy.ts`) uses only `getSessionCookie(request)` from `better-auth/cookies` for an **optimistic redirect** ("THIS IS NOT SECURE!"). The real check happens in every page, route and Convex function. For us, `proxy.ts` keeps the host allowlist and adds the optimistic redirect. `assertGate()` in Server Actions becomes "`isAuthenticated()` + role check". Calling `isAuthenticated()` in `proxy.ts` would cost a round trip to Convex on every request.

### 1.5 Where users and sessions live; identity inside Convex functions

- **Tables.** With the bundled component, the tables live in the component namespace: `user, session, account, verification, twoFactor, jwks, rateLimit` plus three OIDC tables. With **Local Install** (`convex/betterAuth/` with `defineComponent("betterAuth")`, schema generated by `npx auth generate`), we own the schema. Plugins add tables to it (`passkey`, `apikey`, …), and custom indexes can be added. They are still **component tables**: the app writes them only through Better Auth or component functions.

  **Spec impact:** the mutation-inventory test must allow-list `convex/betterAuth/**` (Better Auth's adapter `create/update/delete`). Auth records are not bookkeeping records, so GoBD immutability does not apply to sessions. Write login and logout **audit entries** from **triggers** (`createClient(..., { triggers: { session: { onCreate } } })`, same transaction) through `convex/model/audit`.
- **Identity in functions (`convex/functions.ts` wrappers):**
  ```ts
  const identity = await ctx.auth.getUserIdentity();      // subject = Better Auth user _id, plus sessionId, email, name…
  const user = await authComponent.safeGetAuthUser(ctx);   // also checks the session row exists and is not expired
  const member = await getMemberByAuthUserId(ctx, identity.subject); // our table: role owner|auditor
  const actor = `${member.role}:${identity.subject}`;      // "owner:<id>" / "auditor:<id>"  (02-architecture §4.3)
  ```
  Use `safeGetAuthUser` (or a session check) for **writes**. A bare JWT stays valid for up to 15 min after sign-out or revocation. API-key and MCP requests keep coming in with our own server JWT (`sub = "api-key:<id>"` / `"mcp:<id>"`) under the second provider.

---

## 2. Plugins for a single-owner app

### 2.1 What the Convex component supports (labs.convex.dev/better-auth/supported-plugins)

| Category | Plugins |
|---|---|
| **Supported out of the box** (no schema change) | Anonymous, **Email OTP**, Generic OAuth, JWT, **Magic Link**, One Tap, Phone Number, **Two Factor**, Username |
| **Need Local Install** | Every plugin that adds tables or fields: **Passkey** (`passkey` table), **API Key** (`apikey`), **Admin** (`user.role`, `banned`, …, `session.impersonatedBy`), **Organization**, Stripe, SCIM … |
| **Incompatible even with Local Install** | **SSO** (`@better-auth/sso`, "direct dependencies on Node.js") |
| **Practically broken today** | `@better-auth/oauth-provider` together with `convex()` (#395). Any Better Auth **1.7-only** plugin (#433). |

Known plugin issues:
- **Organization:** #407 (`invite-member` 500), #157 (missing index), #222 (typing).
- **API key:** #160 (`listApiKeys` deletes expired keys as a side effect, so it fails in a query), #242 (fixed).

### 2.2 Recommendations per feature

| Feature | Plugin / option (Better Auth 1.6) | Recommendation |
|---|---|---|
| **Passkeys** | `passkey({ rpID, rpName, origin })` from `@better-auth/passkey` (SimpleWebAuthn). Conditional UI: `autocomplete="username webauthn"` plus `signIn.passkey({ autoFill: true })`. Pre-auth registration is off by default (`registration.requireSession: true`). | **Primary login.** Register the first passkey right after the first e-mail-OTP sign-in. `rpID` must be a stable host suffix you control (see §4.4). WebAuthn needs **HTTPS**, i.e. a secure context. |
| **Email OTP** | `emailOTP({ sendVerificationOTP, otpLength, expiresIn, disableSignUp })` | **Fallback and recovery** (new device, lost passkey). Codes work better than links in a tailnet: a link only opens on a tailnet device anyway. |
| Magic link | `magicLink({ sendMagicLink, disableSignUp })` | Not needed; email OTP covers it. |
| **TOTP 2FA** | `twoFactor({ issuer })`: TOTP, e-mail OTP, backup codes, `trustDevice` (30 days). It gates only `/sign-in/email`, `/sign-in/username` and `/sign-in/phone-number`. **Passkey sign-in is not gated by 2FA.** Enabling it needs a password unless `allowPasswordless`. | Only if passwords are enabled. With passkey + email OTP, the tailnet membership already acts as a device factor. Skip it, or add TOTP as an optional second factor for the bookkeeper. |
| Email/password | `emailAndPassword: { enabled, disableSignUp, requireEmailVerification, minPasswordLength: 8, sendResetPassword, revokeSessionsOnPasswordReset }` | **Off** (`enabled: false`). Fewer flows and no reset mail. Turn it on later only if the Steuerberater needs it, with `requireEmailVerification: true` and `revokeSessionsOnPasswordReset: true`. |
| Email verification | `emailVerification: { sendVerificationEmail, sendOnSignUp, expiresIn: 3600 }` | Email OTP sign-in verifies the address implicitly. Only needed with passwords. |
| **No public sign-up** | `emailAndPassword.disableSignUp`, `emailOTP({ disableSignUp })`, `magicLink({ disableSignUp })`, plus a `databaseHooks.user.create.before` gate. | Gate **all** user creation in one place. Allow it only if (a) no user exists and `email === OWNER_EMAIL` (bootstrap), or (b) an unexpired row in our `invites` table matches the e-mail. Otherwise throw `APIError("FORBIDDEN")`. Throwing aborts the creation (UNSURE about the exact semantics in 1.6; cover with a test). |
| **Roles** (owner, read-only bookkeeper later) | `admin()` (needs a Local Install schema, `createAccessControl`, ban, impersonate) or `organization()` (invitations; buggy on Convex, #407). | **Neither.** Use our own `members` table `{ authUserId, role: "owner" \| "auditor", invitedBy, … }` in `convex/model`. Wrappers derive the actor kind from it. Fewer moving parts, and the role check lives in our domain code (non-negotiable 5). |
| **Rate limiting** | `rateLimit: { enabled (prod default), window: 10, max: 100, storage: "memory" \| "database" \| "secondary-storage", customRules }` | `"memory"` is useless in Convex (no persistent isolate memory). `"database"` has open bugs: [#432](https://github.com/get-convex/better-auth/issues/432) (OCC exhaustion → 500), #446 (missing index), #312 (duplicate-key race). On top of that, behind the fork's socat proxies every request has the **same source IP** (§4.1.2). **Disable Better Auth's IP rate limit.** Instead throttle OTP sends **per e-mail address** with `@convex-dev/rate-limiter` inside `sendVerificationOTP` (e.g. 5/hour). The tailnet is the outer gate. |
| **Session lifetime** | `session: { expiresIn: 604800 (7 d), updateAge: 86400 (1 d), freshAge, cookieCache }`; Convex JWT 15 min. | Keep 7 d and 1 d. Require a **fresh session** (e.g. `freshAge: 600`) or a passkey re-assertion for ⚠ actions (finalise, DATEV lock, purge). **Keep `cookieCache` off** (#434). Set `advanced.useSecureCookies: true`. |
| **API keys** | `@better-auth/api-key` (see §2.3) | **Keep the custom table.** |

### 2.3 API key plugin vs custom `apiKeys` table

What the plugin does (source of `@better-auth/api-key@1.6.33`):

- **Hashing:** SHA-256 → base64url (`disableKeyHashing: false` by default). Custom hasher and validator are possible.
- **Key shape:** `prefix` per key (1–32 chars) or `defaultPrefix`. `defaultKeyLength: 64` (letters only). `startingCharactersConfig` stores the first 6 chars for display.
- **Header:** `apiKeyHeaders: "x-api-key"` (string or array), or `customAPIKeyGetter` (e.g. `Authorization: Bearer`).
- **Expiry:** `expiresIn`; `keyExpiration.minExpiresIn: 1` / `maxExpiresIn: 365` days.
- **Quotas:** `remaining` plus `refillAmount` / `refillInterval`.
- **Rate limit per key:** `rateLimitEnabled` / `rateLimitTimeWindow` / `rateLimitMax`. **The default is enabled, with 10 requests per 24 h.** You must override it.
- **Permissions:** `Record<string, string[]>` (e.g. `{ invoices: ["read","write"] }`). `verifyApiKey({ key, permissions })` checks them. `permissions.defaultPermissions`.
- **Other:** `metadata` (`enableMetadata`), several `configId`s, `references: "user" | "organization"`, `enableSessionForAPIKeys` (mock session), `storage: "database" | "secondary-storage"`, `deferUpdates`.
- **Verify writes:** verifying updates `lastRequest` / `requestCount` / `remaining`. That is a **write per request**, so it must run in a mutation or action, not a query.

| | Plugin | Custom table (current spec) |
|---|---|---|
| Effort | Free generation, hashing and verification. Client SDK methods for a "Keys" UI. | About 150 LOC in `convex/model/apiKeys.ts` plus zod schemas. |
| Scopes | Must be mapped onto `Record<resource, actions[]>`. Our MCP ⚠ scopes (06-mcp.md) are an enum; they fit, but the shape is foreign. | Scopes are the same zod enum used by REST, MCP and the UI (non-negotiable 5). |
| Convex fit | Needs Local Install (we need it anyway for passkeys). A write per verify means OCC contention on hot keys. `listApiKeys` breaks in queries (#160). Upgrades are tied to the component (stuck on 1.6). | A plain table. `lastUsedAt` is throttled (e.g. at most one write per minute). Rate limit via `@convex-dev/rate-limiter`. |
| Audit / GoBD | Delete is a hard delete. Expired keys are auto-deleted. Not attributed through our wrappers. | `revokedAt` instead of delete. Every create and revoke is an audit entry with an actor. The key id goes into `api-key:<id>`. |
| Verification path | REST route → Convex action → `auth.api.verifyApiKey` → then mint our server JWT. | REST route → Convex action `apiKeys.verify` (hash lookup by index) → mint our server JWT. Same number of hops. |

**Recommendation: keep the custom table.** Copy the plugin's good defaults:
- SHA-256 of a ≥32-byte random secret
- a visible prefix such as `sk_live_` and stored `start`
- optional expiry
- per-key rate limit (via the rate limiter component)
- constant-time comparison is not needed, because we look up by hash

If the owner prefers less code, the plugin is viable after setting `rateLimit.enabled: false` (or sane limits) and `deferUpdates: true`. Expect upgrade friction.

### 2.4 Sketch: `convex/auth.ts` (Local Install)

```ts
export const createAuthOptions = (ctx: GenericCtx<DataModel>) => ({
  baseURL: process.env.SITE_URL,                       // https://app.buero.example.de
  trustedOrigins: [process.env.SITE_URL!],
  database: authComponent.adapter(ctx),
  emailAndPassword: { enabled: false },
  rateLimit: { enabled: false },                       // see §2.2; own per-e-mail limiter instead
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, freshAge: 600 },
  advanced: { useSecureCookies: true },
  databaseHooks: { user: { create: { before: async (user) => { await assertSignupAllowed(ctx, user.email); return { data: user }; } } } },
  plugins: [
    passkey({ rpID: process.env.PASSKEY_RP_ID!, rpName: "Buchhaltung", origin: process.env.SITE_URL! }),
    emailOTP({ otpLength: 6, expiresIn: 600, sendVerificationOTP: ({ email, otp, type }) =>
      sendAuthMail(requireActionCtx(ctx), { to: email, kind: type, code: otp }) }),
    convex({ authConfig, jwks: process.env.JWKS }),
  ],
}) satisfies BetterAuthOptions;
```

`requireActionCtx(ctx)` works because Better Auth requests run in an HTTP action. The official example sends its mail exactly this way, with the Resend component.

---

## 3. Cloudflare for e-mail

### 3.1 Email Sending (outbound auth mail)

| Item | Finding | Source |
|---|---|---|
| Status | **Public beta** since **2026-04-16**, as part of "Cloudflare Email Service" (Sending + Routing). No GA announcement found as of 2026-10-12. SMTP submission has been beta since 2026-06-08 (third-party note). | [changelog](https://developers.cloudflare.com/changelog/post/2026-04-16-email-sending-public-beta/), [blog](https://blog.cloudflare.com/email-for-agents/), [overview](https://developers.cloudflare.com/email-service/) |
| Interfaces | Workers binding `send_email` (`env.EMAIL.send({...})`); **REST** `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send` with `Authorization: Bearer <token>`; SMTP `smtp.mx.cloudflare.net:465` (user `api_token`, password = token). Node SDK `cloudflare@7.3.0` → `client.emailSending.send({ account_id, from, to, subject, html, text, cc, bcc, reply_to, headers, attachments })` and `sendRaw`. | [REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/), SDK source |
| **Callable from a non-Worker server?** | **Yes.** The REST API and SMTP work from anywhere. **No Worker proxy is needed.** | same |
| Token | Custom API token with the **Email Sending** permission (official SMTP page: "Email Sending: Edit"; a third-party guide says "Email Sending — Send"). Check the exact label in the dashboard (**UNSURE**). The domain must be onboarded on the account that owns the token. | [SMTP](https://developers.cloudflare.com/email-service/api/send-emails/smtp/) |
| Pricing | Workers **Free: no outbound sending** to arbitrary recipients. **Workers Paid ($5/month): 3,000 mails/month included**, then $0.35 per 1,000. Sending to **verified destination addresses** is free on all plans and does not count against the quota. | [pricing](https://developers.cloudflare.com/email-service/platform/pricing/) |
| Limits | 5 MiB per message (25 MiB to verified destinations), 50 recipients, 998-character subject, 16 KB custom headers. New accounts have a "conservative daily quota" that grows over time. Before a sending domain is onboarded you can send only to verified destinations. | [limits](https://developers.cloudflare.com/email-service/platform/limits/) |
| Domain / DNS | **"You must be using Cloudflare DNS to use Email Service."** Onboarding (Compute → Email Service → Email Sending → Onboard Domain) adds: MX + SPF TXT on `cf-bounce.<domain>`, a DKIM TXT, and a DMARC TXT at `_dmarc.<domain>`. Propagation is typically 5–15 min. | [get started](https://developers.cloudflare.com/email-service/get-started/send-emails/) |
| Errors | e.g. `10105 not_entitled` (plan), `10203 sending_disabled`, `10004 throttled` (429), `10102 forbidden` (token scope) | REST page |

**Fit for us.** Only the owner and maybe one Steuerberater receive auth mail (OTP codes and invites).

- **Option A, cheapest (UNSURE):** add both addresses as *verified destination addresses* in Email Routing and stay on the free plan. The docs contradict themselves here: "Free: outbound sending isn't available" versus "sending to verified destination addresses is free on all plans". Test it.
- **Option B, robust:** Workers Paid at $5/month. This is also needed for the receipt Worker if volume grows, and for R2 beyond the free tier.
- **Pre-existing mailboxes:** if the root domain already has MX records for a mailbox provider, Email Sending's records live on `cf-bounce.` and `_dmarc`. **Check an existing DMARC record before onboarding** (merge it, don't duplicate).
- **Sender:** use a subdomain such as `noreply@mail.example.de`, or the root domain.

**Code: Convex action (V8 runtime, no SDK needed):**

```ts
// convex/model/authMail.ts  (called via requireActionCtx from Better Auth callbacks)
export async function sendAuthMail(ctx: ActionCtx, m: { to: string; kind: string; code: string }) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/email/sending/send`,
    { method: "POST",
      headers: { Authorization: `Bearer ${process.env.CF_EMAIL_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: { address: "noreply@mail.example.de", name: "Buchhaltung" },
        to: m.to,
        subject: `Ihr Anmeldecode: ${m.code}`,
        text: `Ihr Code lautet ${m.code}. Er ist 10 Minuten gültig.`,
        html: renderOtpHtml(m.code),
      }) });
  const body = await res.json();
  if (!res.ok || !body.success) throw new Error(`CF email failed: ${JSON.stringify(body.errors)}`);
  // body.result = { delivered: [...], permanent_bounces: [...], queued: [...] }
}
```

The server's **outbound** internet access is unaffected by "Tailscale-only", which restricts only inbound. The Convex backend container needs egress to `api.cloudflare.com:443`.

Mail texts are German. Keep them in `src/domain` or `src/emails` as plain functions. React Email is optional.

### 3.2 Email Routing → app receipt inbox (incoming receipts and e-invoices)

**Problem:** an Email Worker runs in Cloudflare and cannot reach a tailnet-only app.

| Option | How | Verdict |
|---|---|---|
| **R2 drop + app polls** | Email Worker writes the raw `.eml` (`message.raw`, up to ~25 MiB) to an R2 bucket `inbox/<ts>-<id>.eml`, with sender, subject and Message-ID as custom metadata. A Convex cron (every 5 min) lists the bucket via the **R2 S3 API** (access key scoped to that one bucket), imports each mail into the receipt inbox (artifact plus SHA-256, GoBD: the raw mail is the original), then deletes it or moves it to `processed/`. | **Recommended.** Outbound only, no exposure, idempotent (the object key is the dedupe key). Free tier: R2 10 GB, 1M Class A / 10M Class B ops per month. Polling is ~9k list ops per month. |
| Cloudflare Queue + HTTP pull consumer | Worker → Queue; app pulls via the Queues HTTP pull API. | Also outbound-only. More pieces, 128 KB message limit, so it still needs R2 for the body. |
| Workers VPC binding (via `cloudflared`) | A Worker calls the private app through a Cloudflare Tunnel without a public hostname. **VPC Networks have been beta since 2026-04-14.** | Elegant, but beta, and adds a second overlay network (`cloudflared`) next to Tailscale. Later, maybe. |
| Cloudflare Tunnel public hostname + Access service token | Worker POSTs to `https://inbox.example.de` → tunnel → app. | Creates a public host, which contradicts "no public hosts". |
| Tailscale Funnel for one path | §4.5 | Public, ts.net only. No. |

Notes:
- Email Routing needs Cloudflare MX on the receiving (sub)domain. Use a **subdomain** such as `belege@in.example.de` if the root domain's mailbox stays elsewhere.
- `message.forward()` only goes to verified addresses.
- `message.setReject()` can bounce non-whitelisted senders.
- Parse with `postal-mime` on the **app side**. The Worker stays dumb.

```ts
// worker: receipts-inbox (wrangler: [[r2_buckets]] binding = "INBOX")
export default {
  async email(message, env) {
    if (message.rawSize > 25 * 1024 * 1024) return message.setReject("Message too large");
    const id = `${Date.now()}-${crypto.randomUUID()}`;
    await env.INBOX.put(`inbox/${id}.eml`, message.raw, {
      customMetadata: { from: message.from, to: message.to,
        subject: message.headers.get("subject") ?? "", messageId: message.headers.get("message-id") ?? "" },
    });
  },
};
```

---

## 4. Tailscale-only deployment

### 4.1 The owner's Dokploy fork: what it actually does (code-verified)

#### 4.1.1 Configuration and model

- **Org-level config.** The org has a `tailscale_config`: tailnet `bl4ckbl1zz.github`, DNS suffix `tailb289f5.ts.net`, device tag `tag:dokploy`, translated CIDR `10.248.33.0/24`. It uses an API credential that can create auth keys, Services and device tags.
- **Gateways.** Each server (panel, deploy, build) gets a **gateway** row (`tailscale_gateway`). Its ownership is one of:
  - `managed`: the fork installed or enrolled tailscaled with a tagged, pre-authorised, non-reusable 10-minute auth key
  - `adopted`: an existing client that already has `tag:dokploy`
  - `parallel`: an isolated tailscaled in its own netns, used when the host client is on a *different* tailnet, and for the panel
  - `pending_retag`
- **Minimum Tailscale version:** 1.86.0. The fork auto-upgrades apt/rpm/pacman/apk installs.
- **Endpoints.** Every resource becomes `tailscale_endpoint` rows (`desired-state.ts`):
  - **Compose:** one endpoint **per compose service that has ports**. Ports come from `ports:` *and* `expose:` (target side; ranges up to 100; UDP is skipped with a warning). Dokploy **domains** that point at a `serviceName` + `port` add or upgrade that port with scheme `http`.
  - **Application:** declared ports plus domain ports.
  - **Databases:** fixed ports (postgres 5432, …), flagged `secret`.
  - **Previews:** the domain or preview port.
  - **No ports → status `pending`** and nothing is published.
- **Naming (`naming.ts`):**
  - The Service name is `svc:dokploy-<project>-<environment>-<resource>[-<composeService>][-preview]-<suffix>`.
  - Labels are normalised to `[a-z0-9-]`. The total is ≤ 63 chars, with the longest segments truncated first. `<suffix>` is the last 8 chars of the resource id (12, 16 or a hash on collision).
  - **FQDN = `<label without "svc:">.tailb289f5.ts.net`**, e.g. `dokploy-buchhaltung-production-convex-backend-k3j9x2ab.tailb289f5.ts.net`. It is **not** just `<serviceName>.tailb289f5.ts.net`.
  - The name is persisted per `ownerKey` (`type:resourceId:composeService`), so it stays **stable across redeploys**. It changes only if the resource is recreated.
- **Env references (`environment-template.ts`):**
  - `${{private.<referenceKey>.host}}` and `${{private.<referenceKey>.url.<port>}}`, where `referenceKey` = `appName` or `appName--<composeService>`.
  - URLs are `<scheme>://<fqdn>:<port>`. The scheme is `tcp` for plain `expose` ports and `http` for domain ports, so use `.host` and build `https://…` yourself.
  - The variables are resolved at deploy time, within one project.
- **Translated CIDR `10.248.33.0/24`.** One stable IP per endpoint is allocated from it and stored (`translatedIp`). In this version I found no data-path use beyond bookkeeping (INFERENCE).

#### 4.1.2 Data path (`data-plane.ts`, `orchestrator.ts`)

- **Inbound, tailnet → workload.**
  - For each endpoint port the fork starts an `alpine/socat` container `dokploy-ts-proxy-<id>-<port>` on the workload's network (`<appName>_default` / `<appName>` for compose, `dokploy-network` otherwise). It runs `TCP-LISTEN:<port> → <targetHost>:<port>`.
  - It writes the gateway's serve config (`tailscale serve set-config --all`) with
    ```json
    { "version": "0.0.1", "services": { "svc:dokploy-…": { "endpoints": { "tcp:3210": "tcp://<socatIp>:3210" } } } }
    ```
  - It upserts the Service via the API with `ports: ["tcp:<port>"]`.
  - **So it is plain L4 TCP on the original port numbers. Tailscale does not terminate TLS, and no ts.net certificate is involved. Traefik is not in the path.** Dokploy domains only influence port discovery; their HTTPS flag is read but unused.
- **Outbound, workload → other Services ("source proxies").**
  - Workloads are attached to an org network `dokploy-ts-<org>`. Compose networks get a socat "source proxy" container whose **Docker network alias is the Service FQDN**. It forwards to the Service's TailVIP, routed via the gateway.
  - Containers can therefore reach `dokploy-…tailb289f5.ts.net:<port>` from inside Docker without hairpin problems.
- **Consequences:**
  1. **No HTTPS.** Browsers would load `http://<fqdn>:3000`, which is not a secure context. Passkeys (WebAuthn), `__Secure-` cookies and `crypto.subtle` would fail. **We must add TLS** (§4.2).
  2. **Client IP is lost.** The app sees the socat container's IP, which breaks Better Auth's IP rate limiting (§2.2). Audit entries can't record the client's tailnet IP. That is acceptable for a single owner.
  3. **Everything with `expose`/`ports` gets published.** Don't list ports that should stay internal. Compose services reach each other on the compose network without `expose`.
  4. **Clients:** Linux clients ≤ v1.93 need `tailscale set --accept-routes` to reach Service VIPs. v1.94+ and the mobile and desktop apps don't (Tailscale Services docs).

#### 4.1.3 `confirmRetag`: what it does and its risks

- **What triggers it.** `decideTailscaleClientMode()` returns `retag` when a deploy server's host tailscaled is **running on the right tailnet but is user-owned** (no `tag:dokploy`). The gateway is set to `ownership=pending_retag`, `status=pending`, with the message "Administrator confirmation is required…". Tailscale Services can only be hosted by **tag-identity devices**, so nothing gets published from those servers until this is resolved.
- **What the procedure does.** `tailscale.confirmRetag` (permission `tailscale:update`) → `confirmTailscaleGatewayRetag()`:
  1. Calls the Tailscale API `POST /device/{deviceId}/tags {"tags":["tag:dokploy"]}`. This **replaces the device's user identity with tag ownership**.
  2. Marks the gateway `adopted`.
  3. Re-runs `provisionTailscaleGateway()`, which then publishes the Services.
  4. The fork never deletes or re-enrolls an adopted device (`purgeTailscaleGatewayClient` skips `adopted` / `pending_retag`).
- **Risks** (Tailscale [tags docs](https://tailscale.com/kb/1068/tags) plus INFERENCE):
  - **Tailscale SSH lockout.** "Tagged devices … cannot SSH into devices with a user-based identity". The default SSH rule's `dst: ["autogroup:self"]` covers only user-owned devices.
    - If the servers were set up with `tailscale up --ssh` (as the Dokploy Tailscale guide suggests) **and** public port 22 is firewalled, you can lose SSH after the retag.
    - This includes **Dokploy's own SSH connection to the deploy server, if it is registered with its tailnet IP**: Tailscale SSH intercepts port 22 on the tailnet IP.
    - Before confirming, add an SSH rule such as `{"action":"accept","src":["autogroup:admin"],"dst":["tag:dokploy"],"users":["root","autogroup:nonroot"]}` and, if the panel connects over the tailnet, `src: ["tag:dokploy"]`. Alternatively make sure plain OpenSSH on the public IP or the provider console still works.
  - **ACLs and grants change meaning.** Rules that target the owner's user or `autogroup:member` as *destination* no longer match the server. It is now only `tag:dokploy`. With the default allow-all policy nothing breaks. With a custom policy, add `tag:dokploy` grants first.
  - **Key expiry.** Tagged devices normally have key expiry disabled, but per the docs that applies on *first tag + authenticate*. After an API retag the existing expiry setting may remain. Check the Machines page and disable expiry, otherwise the server drops off the tailnet when the key expires (UNSURE).
  - **Hard to undo.** Going back to a user identity requires a re-login on the server (`tailscale login`/`up --force-reauth`), i.e. console or SSH access.
  - **Prerequisites.** `tag:dokploy` must exist in `tagOwners`, and the fork's API credential must be allowed to apply it. The device IP stays the same.
- **Alternative to retagging.** The fork has a `parallel` mode: a separate, tagged tailscaled in its own netns, leaving the host's user-owned client untouched. It is chosen automatically only when the host client is on a *different* tailnet. A `forceIsolated` flag exists in `decideTailscaleClientMode` but is not exposed in the router I read (UNSURE). Using it would avoid the SSH and ACL risks entirely, at the cost of a second node per server.
- **Recommendation:**
  1. Update the tailnet policy (SSH plus grants for `tag:dokploy`).
  2. Verify out-of-band access (provider console).
  3. Disable key expiry after the change.
  4. Then confirm the retag, one server at a time.

  I did **not** call any mutating procedure.

### 4.2 TLS on top of the fork: options

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. TLS edge proxy inside the app compose (recommended)** | A `caddy` service (built with `caddy-dns/cloudflare`; or a stock `traefik:v3` container, which has the Cloudflare DNS provider built in) gets a wildcard cert for `*.buero.example.de` via **DNS-01** (Cloudflare token: Zone → DNS → Edit, one zone). **Only Caddy has `expose: ["443", "8443"]`.** The fork publishes one Service (`…-caddy-<id>`) with `tcp:443` and `tcp:8443`; TLS is end-to-end to Caddy. Cloudflare DNS: `app`, `convex`, `convex-site`, `convex-dash` and `api` under `buero.example.de` are A records → the Service's **TailVIP** (`tailscale status --json` / admin console). Caddy routes by `Host` to `web:3000`, `backend:3210`, `backend:3211`, `dashboard:6791`; port 8443 serves only `/api/v1` for the website. | No fork change. Nice, **stable hostnames** independent of the fork's naming. One Service to grant. Passkey `rpID` on our own domain. The domain must be on Cloudflare anyway (Email Service). | The TailVIP changes if the Service is deleted or recreated → update DNS (scriptable via the Dokploy DNS provider / Cloudflare API). Public DNS reveals a 100.x IP (harmless). Needs `cf` token in Caddy. |
| B. Extend the fork: Tailscale terminates TLS | For `http`-scheme ports, emit `"tcp:443": "tls-terminated-tcp://<socatIp>:<port>"` (in Tailscale's serve-config parser since ≤ v1.90; tailscaled serves the Service's `*.ts.net` cert and forwards plain TCP, WebSockets included) or `https` targets. Needs "HTTPS certificates" enabled in the tailnet DNS settings. | Zero extra containers. Certs managed by Tailscale. | Code change and tests in the fork. Long, opaque hostnames (`dokploy-buchhaltung-production-web-…`). ts.net names land in **public Certificate Transparency logs**. Hostname is tied to the fork's naming. |
| C. Generic: Tailscale on the host + Dokploy Traefik bound/allowlisted to `100.64.0.0/10` + DNS-01 | The current spec (08-deployment.md option A). | Known pattern. | Dokploy publishes Traefik and the panel on `0.0.0.0`, and Docker bypasses UFW. That needs the provider firewall ([Dokploy Tailscale guide](https://docs.dokploy.com/docs/core/guides/tailscale)). Upstream has no HostIp binding for Traefik ([#5157](https://github.com/Dokploy/dokploy/issues/5157), [#2915](https://github.com/Dokploy/dokploy/issues/2915)). Containers calling the public names hit the allowlist with Docker-bridge source IPs. **Superseded by the fork.** |
| D. Generic: tailscale sidecar per service / `tsnet` / Docktail | `network_mode: service:ts` plus `TS_SERVE_CONFIG`. | Per-service ts.net certs. | Duplicates what the fork automates. |
| E. Traefik's `tailscale` cert resolver | `certificatesResolvers.x.tailscale: {}` (Traefik v3; only `*.ts.net` machine names; renews 14 days ahead; needs the local tailscaled socket). | — | Machine names only, not Service names. Not useful with the fork. |

**Pick A now; consider B later as a fork feature.** With A, also remove Dokploy domains from this compose. Domains would add more published ports, and Traefik isn't in the path anyway.

### 4.3 Convex env with option A

```yaml
# compose (one Dokploy compose resource; sketch)
services:
  caddy:     { image: <caddy-with-cloudflare>, expose: ["443", "8443"], environment: [CF_API_TOKEN=…], volumes: [caddy-data:/data] }
  web:       { image: <next-app>, environment: [
                 NEXT_PUBLIC_CONVEX_URL=https://convex.buero.example.de,
                 NEXT_PUBLIC_SITE_URL=https://app.buero.example.de,
                 CONVEX_URL_INTERNAL=http://backend:3210, CONVEX_SITE_URL_INTERNAL=http://backend:3211 ] }   # no expose
  backend:   { image: ghcr.io/get-convex/convex-backend:<pinned>, environment: [
                 CONVEX_CLOUD_ORIGIN=https://convex.buero.example.de,
                 CONVEX_SITE_ORIGIN=https://convex-site.buero.example.de ] }                                  # no expose
  dashboard: { image: ghcr.io/get-convex/convex-dashboard:<pinned>, environment: [NEXT_PUBLIC_DEPLOYMENT_URL=https://convex.buero.example.de] }
```

- Convex env: `SITE_URL=https://app.buero.example.de`, `BETTER_AUTH_SECRET`, `JWKS` (static), `PASSKEY_RP_ID=buero.example.de`, `CF_ACCOUNT_ID`, `CF_EMAIL_TOKEN`.
- The JWT `iss` is `https://convex-site.buero.example.de`. With a static JWKS the backend never needs to fetch it.
- `npx convex deploy` from a laptop or CI must be on the tailnet. In CI use `tailscale/github-action` with a `tag:ci` grant to the edge's `tcp:443`.
- If Next.js and Convex are separate Dokploy resources, either use the fork's `${{private.<convex-ref>.host}}` (this needs `expose` on the backend, which publishes it too) or keep them in one compose as above. **One compose is simpler.**

### 4.4 Better Auth `baseURL`, trusted origins, passkey RP ID

- `baseURL = SITE_URL = https://app.buero.example.de` (static; don't rely on request inference). `trustedOrigins` defaults to the baseURL origin. Add more only if the app is also opened under another name.
- **Passkey `rpID`** is a hostname suffix of the page origin, at or below the registrable domain.
  - **`ts.net` is on the Public Suffix List** (as is `*.c.ts.net`). For ts.net hosts the broadest rpID is therefore `tailb289f5.ts.net`. It survives Service renames but changes if the tailnet DNS name is changed (it can be re-randomised in the admin console).
  - With option A, use **`rpID = "buero.example.de"`**. Don't use `example.de` if a public website lives under it: a compromised public subdomain could request assertions for the same RP. Keep app hosts under `buero.`.
  - **Changing the rpID invalidates all registered passkeys**, so email OTP must stay as the recovery path.
- `origin` for the passkey plugin = `https://app.buero.example.de`. The WebAuthn ceremony runs on the app origin; the Convex site origin only receives proxied requests.
- Auth e-mails contain codes, not links. If links are used (invites), they only open on tailnet devices, which is intended.

### 4.5 Claude clients and the MCP server inside the tailnet

| Client | Works? | Why / how |
|---|---|---|
| **Claude Code** on a tailnet device | **Yes** | It connects directly from the local machine: `claude mcp add --transport http buchhaltung https://app.buero.example.de/api/mcp --header "Authorization: Bearer sk_live_…"` |
| **Claude Desktop**, local MCP config (`claude_desktop_config.json`) | **Yes, via a bridge** | A stdio server that runs locally, e.g. `npx mcp-remote https://app.buero.example.de/api/mcp --header "Authorization: Bearer …"`. Local servers use the device's network. |
| Claude Desktop / Cowork **custom connectors** (Settings → Connectors) | **No** | "Remote connectors are configured and brokered through your Claude account … the connection originates from Anthropic's servers, not from your machine's network interface." Servers on a private network or VPN are unreachable. The only workaround is to allowlist Anthropic's IP ranges, which needs a public endpoint. ([support article](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)) |
| **claude.ai web / mobile** | **No** | Same reason. |

Making claude.ai work would need a public `/api/mcp` with OAuth: Funnel or a tunnel plus OAuth-provider endpoints. Better Auth's OAuth provider currently breaks `convex()` (#395). **Out of scope** for "no public hosts".

### 4.6 A public website calling the REST API

1. **Recommended: the website's server joins the tailnet.**
   - Use a **tagged, pre-authorised, non-ephemeral auth key** (`tag:website`). For containers, use the `tailscale/tailscale` sidecar or `tsnet`/userspace mode.
   - Grant it only the edge's API port:
     ```json
     { "grants": [
       { "src": ["autogroup:admin"], "dst": ["svc:dokploy-buchhaltung-production-stack-caddy-<id>"], "ip": ["tcp:443", "tcp:8443"] },
       { "src": ["tag:website"],     "dst": ["svc:dokploy-buchhaltung-production-stack-caddy-<id>"], "ip": ["tcp:8443"] } ] }
     ```
   - Caddy on 8443 serves **only** `api.buero.example.de/api/v1/*` (the existing api-host allowlist moves here). A separate *port* is needed because grants are per Service and port, not per hostname, and the edge can't tell callers apart by IP (socat, §4.1.2).
   - The website still needs an **API key** with narrow scopes.
   - **Serverless hosting (Vercel, Workers) can't easily join a tailnet** (UNSURE for 2026 offerings). It needs a small always-on server.
2. **Tailscale Funnel for only `/api/v1`: not recommended.**
   - Funnel works per **node host:port**, only on ports 443/8443/10000, and only for `*.ts.net` names, not custom domains.
   - A port is either fully Serve (tailnet) or fully Funnel (public). Path scoping works only by mapping just `/api/v1` on a dedicated Funnel port (e.g. 8443) of a **node**.
   - The fork publishes **Services**, not node serve config. Funnel for Tailscale Services is not documented (UNSURE).
   - Bandwidth is limited and not configurable.
   - It contradicts "no public hosts". ([Funnel docs](https://tailscale.com/kb/1223/funnel))

---

## 5. Recommended setup for this owner

- **Packages:** `@convex-dev/better-auth@0.12.5`, `better-auth@1.6.33`, `@better-auth/passkey@1.6.33` (exact pins; block 1.7 until #433 is fixed), `convex@1.46.0`, `@convex-dev/rate-limiter`.
- **Better Auth Local Install** in `convex/betterAuth/`, with plugins `passkey`, `emailOTP` and `convex({ authConfig, jwks })`. Password, magic link, 2FA, admin, organization and api-key plugins are **off**.
- **Static JWKS** in the Convex env (`JWKS`), used by both `auth.config.ts` and `convex()`. Keep our **ES256 server-JWT** provider as a second `customJwt` (different `applicationID`) for `api-key:` / `mcp:` actors.
- **Sign-in:** first visit → email OTP to `OWNER_EMAIL` (the creation gate allows only that address while no user exists) → register a passkey immediately. Later sign-ins use the passkey, with email OTP as fallback. Bookkeeper: owner creates an invite (`invites` table) → email OTP sign-up allowed for that address → `members.role = "auditor"` (read-only in the wrappers).
- **Sessions:** 7 d / 1 d update; `freshAge` 10 min for ⚠ actions; no cookieCache; secure cookies. Better Auth IP rate limit off; per-e-mail OTP throttling via the rate limiter.
- **Identity in Convex:** `ctx.auth.getUserIdentity().subject` + `safeGetAuthUser` + `members` → actor `owner:<id>` / `auditor:<id>`. Login and logout audit via session triggers through `convex/model`. Allow-list `convex/betterAuth/**` in the mutation-inventory test.
- **`proxy.ts`:** host allowlist plus an optimistic `getSessionCookie` redirect. Server Actions: `isAuthenticated()` + role (this replaces the gate header in `assertGate()`).
- **API keys:** custom `apiKeys` table (SHA-256, `sk_live_` prefix, scopes from `src/domain/schemas`, expiry, `revokedAt`, throttled `lastUsedAt`). REST and MCP verify it in a Convex action, then call Convex with the server JWT.
- **E-mail out:** Cloudflare Email Service REST from a Convex action (`fetch`). Onboard `example.de` (or `mail.example.de`) on Cloudflare DNS (SPF/DKIM/DMARC records added automatically; merge any existing DMARC). Try free with verified destinations; otherwise Workers Paid ($5/month). Beta: keep the sender behind a small interface so Resend or SMTP can replace it.
- **E-mail in:** Email Routing on `in.example.de` → Email Worker → R2 `receipts-inbox` → Convex cron polls via the S3 API → artifact + receipt inbox → delete the object.
- **Network** (fork Tailscale Services + option A):
  1. Fix the tailnet policy: SSH and grants for `tag:dokploy`, `tag:website`, `tag:ci`.
  2. Confirm out-of-band server access, then `confirmRetag` per server and disable key expiry.
  3. Deploy one compose (`caddy`, `web`, `backend`, `dashboard`, `einvoice-tools`). **Only Caddy has `expose` (443 app/convex/dashboard, 8443 API)**, and the compose has no Dokploy domains.
  4. Caddy gets `*.buero.example.de` via Cloudflare DNS-01.
  5. Cloudflare A records → the Caddy Service TailVIP.
  6. Server-side calls use `http://backend:3210/3211`.
  7. Protect the Convex dashboard additionally with Caddy basic auth, or restrict it to `autogroup:admin` via a separate port.
- **Clients:** owner devices on the tailnet (Linux ≤ 1.93: `--accept-routes`). Claude Code connects directly; Claude Desktop via local `mcp-remote`; no claude.ai connectors. The public website calls the API only from a tailnet-joined server tagged `tag:website`, port 8443 only.
- **Spec updates needed (follow-up PR):**
  - 02-architecture §4: login replaces "no login + gate"; the Tailscale gate becomes the network layer.
  - 08-deployment: fork Tailscale Services + Caddy edge replace Traefik ipAllowList option A.
  - 06-mcp: claude.ai connectors not supported.
  - 03-data-model: `members`, `invites`, Better Auth component tables.
  - CLAUDE.md non-negotiable 7 ("No login, but a gate").

## Sources

- Better Auth component: npm `@convex-dev/better-auth` (0.12.5); https://labs.convex.dev/better-auth (getting started, framework-guides/next, supported-plugins, features/local-install, features/triggers); https://github.com/get-convex/better-auth (examples/next, issues #52, #82, #160, #247, #312, #377, #395, #398, #407, #422, #432, #433, #434, #446)
- Better Auth: https://www.better-auth.com/docs/reference/options, /docs/integrations/next, /docs/plugins/passkey, /docs/plugins/2fa, /docs/plugins/admin, /docs/plugins/api-key (+ /advanced, /reference); npm `better-auth` (1.6.33, 1.7.7), `@better-auth/api-key@1.6.33` source
- Cloudflare: https://developers.cloudflare.com/email-service/ ; /platform/pricing/ ; /platform/limits/ ; /api/send-emails/rest-api/ ; /api/send-emails/smtp/ ; /get-started/send-emails/ ; https://developers.cloudflare.com/changelog/post/2026-04-16-email-sending-public-beta/ ; https://blog.cloudflare.com/email-for-agents/ ; https://developers.cloudflare.com/email-routing/email-workers/runtime-api/ ; https://developers.cloudflare.com/changelog/post/2026-04-14-vpc-networks/ ; npm `cloudflare@7.3.0`
- Tailscale: https://tailscale.com/kb/1552/tailscale-services ; https://tailscale.com/docs/reference/tailscale-services-configuration-file ; https://tailscale.com/kb/1223/funnel ; https://tailscale.com/kb/1068/tags ; `tailscale/tailscale` source `ipn/conffile/serveconf.go`, `cmd/tailscale/cli/serve_v2.go` (v1.104.1, 2026-10-07); Public Suffix List (`ts.net`, `*.c.ts.net`)
- Dokploy: fork `Bl4ckBl1zZ/dokploy` v0.41.1 source; https://docs.dokploy.com/docs/core/guides/tailscale ; upstream releases (v0.30.8, 2026-09-29) and issues #2915, #4312, #5157
- Traefik: https://doc.traefik.io/traefik/reference/install-configuration/tls/certificate-resolvers/tailscale/
- Claude: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
