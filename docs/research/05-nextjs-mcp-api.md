# Research report: Next.js 16.4, MCP inside Next.js, and a public REST API with API keys (as of 2026-10-12)

Several things changed this year that make older guides wrong:

- **MCP 2026-07-28 is the current spec.** It removes sessions and the `initialize` handshake.
- **`mcp-handler` 2.x** removed `basePath`, `redisUrl`, `maxDuration` and SSE. Redis is no longer used.
- **The MCP TypeScript SDK v2** is split into packages: `@modelcontextprotocol/server` replaces `@modelcontextprotocol/sdk`.
- **shadcn now defaults to Base UI instead of Radix.**
- **Claude custom connectors** now accept static API-key headers, but only as a limited beta.
- **`@asteasolutions/zod-to-openapi` is at v9**, not v8.

---

## A) Next.js, shadcn/ui, Tailwind v4, mobile patterns

### Version and requirements
| Item | Value | Source |
|---|---|---|
| Latest stable | **`next@16.4.0`** (npm `latest`, released Oct 6, 2026) | npm registry; nextjs.org/blog/next-16-4 |
| Pending security release | **A patch is announced for Wed Oct 14, 2026** (2 Critical and 1 High severity issues in upstream dependencies). Plan to upgrade to 16.4.x after it ships. | nextjs.org/blog (Oct 8 post) |
| Node | `engines.node: ">=20.9.0"`. The official Dockerfile uses `node:24.13.0-slim`. | npm, with-docker example |
| React | 16.4 ships **React 19.3** (`react@19.3.0`): stable View Transitions, Fragment Refs, new `browser()` API | blog |
| Next 17 | Not released. Cache Components "will become the default in Next.js 17". | blog |

### Key features
- **App Router, Server Actions/Functions and Route Handlers** (`app/**/route.ts` exporting `GET`/`POST`…) are all stable.
- **Server Functions are not separate routes.** They are POSTs to the page route, so a proxy matcher can silently skip them. Check auth inside every Server Function.
- **Turbopack** has been the default for `next dev` and `next build` since 16.0. I did not re-verify that wording in the 16.4 post, but 16.4 adds Turbopack improvements: a 20–25% smaller disk cache, lazy server HMR, a shared runtime chunk, and export mangling. Experimental flags: `turbopackGc`, `turbopackLazyDynamicImports`, `turbopackRustReactCompiler`.
- **Cache Components / `"use cache"`.** Since 16.4, Vercel recommends it for every app and **`create-next-app` enables it by default**. To enable it in an existing app:
  ```ts
  // next.config.ts
  const nextConfig: NextConfig = { cacheComponents: true, partialPrefetching: true, output: 'standalone' };
  ```
  Related APIs:
  - `'use cache'` plus `cacheLife('hours')` from `next/cache`.
  - New in 16.4: `export const ensureStatic = 'navigation' | 'prefetch' | 'shell'`, and `await navigation()` / `await prefetch()` from `next/cache`.
- **`next upgrade --agent`:** `npx next@canary upgrade --agent=latest`. `experimental.agentUpgrade: 'security' | 'latest' | false` (default `'security'`) adds upgrade reminders.
- **`proxy.ts` replaces `middleware.ts`** (16.0). Middleware is deprecated. The file exports `proxy` (named or default) plus `config.matcher`. It **always runs on the Node.js runtime**, and setting `runtime` throws. To migrate: `npx @next/codemod@canary middleware-to-proxy .`
  ```ts
  // proxy.ts
  import { NextResponse, type NextRequest } from 'next/server'
  export function proxy(request: NextRequest) { /* ... */ return NextResponse.next() }
  export const config = { matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'] }
  ```

### Docker (official `examples/with-docker`)
`next.config`: `{ output: "standalone" }`. The Dockerfile has three stages (deps, builder, runner); the runner stage is:
```dockerfile
ARG NODE_VERSION=24.13.0-slim
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME="0.0.0.0"
COPY --from=builder --chown=node:node /app/public ./public
RUN mkdir .next && chown node:node .next
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```
The deps stage runs `npm ci` / `pnpm install --frozen-lockfile` using `--mount=type=cache`. Full file: https://github.com/vercel/next.js/tree/canary/examples/with-docker

### shadcn/ui + Tailwind CSS v4
- **Versions:**
  - CLI: `shadcn@4.21.4` (CLI v4 since Mar 2026)
  - `tailwindcss@4.3.3`, `@tailwindcss/postcss@4.3.3`, `tw-animate-css@1.4.0`
- **Commands:**
  - New Next.js app: `pnpm dlx shadcn@latest init -t next`
  - Existing app: `pnpm dlx shadcn@latest init`
  - Preset from shadcn/create: `init --preset <code> --template next`
  - Add components: `pnpm dlx shadcn@latest add sidebar drawer dialog sheet table card`
  - Other v4 CLI features: `add --dry-run|--diff|--view`, `shadcn info`, `shadcn docs <component>`
- **Base UI is the default since July 2026.** New projects are initialized on Base UI. To stay on Radix, pass `-b radix` (or `--base radix`). Radix is not deprecated. Drawer now uses Base UI instead of Vaul.
- **`components.json` for Tailwind v4:**
  - `tailwind.config` must be `""`.
  - Use `"style": "new-york"`; `default` is deprecated.
  - `style`, `baseColor` and `cssVariables` cannot be changed after init.
  ```json
  { "$schema": "https://ui.shadcn.com/schema.json", "style": "new-york", "rsc": true, "tsx": true,
    "tailwind": { "config": "", "css": "app/globals.css", "baseColor": "neutral", "cssVariables": true, "prefix": "" },
    "iconLibrary": "lucide",
    "aliases": { "components": "@/components", "ui": "@/components/ui", "lib": "@/lib", "hooks": "@/hooks", "utils": "@/lib/utils" } }
  ```
- **CSS-first config.** The PostCSS file and `globals.css` head below come from Tailwind/shadcn convention; the shadcn page I fetched does not quote them.
  ```js
  // postcss.config.mjs
  export default { plugins: { "@tailwindcss/postcss": {} } };
  ```
  ```css
  /* app/globals.css */
  @import "tailwindcss";
  @import "tw-animate-css";          /* replaces tailwindcss-animate */
  @custom-variant dark (&:is(.dark *));
  :root { --background: oklch(1 0 0); /* ... OKLCH tokens */ }
  .dark { /* ... */ }
  @theme inline { --color-background: var(--background); /* ... */ }
  ```
  Other v4 changes: `data-slot` attributes on every primitive, no `forwardRef` (components use `React.ComponentProps`), `size-*` utility, and toast is deprecated in favour of `sonner`.

### Mobile-responsive patterns
- **Sidebar:**
  - Below 768px the Sidebar renders inside a **Sheet**.
  - `useSidebar()` returns `isMobile`, `openMobile`, `setOpenMobile` and `toggleSidebar`.
  - Props: `collapsible="offcanvas" | "icon" | "none"`, `variant="sidebar" | "floating" | "inset"` (inset needs `<SidebarInset>`), `side`.
  - CSS variables: `--sidebar-width: 16rem`, `--sidebar-width-mobile: 18rem`. Shortcut: Cmd/Ctrl+B.
  - Cookie persistence via `sidebar_state` is not confirmed on the current docs page.
  ```tsx
  <SidebarProvider><AppSidebar /><SidebarInset><header><SidebarTrigger/></header>{children}</SidebarInset></SidebarProvider>
  ```
- **`useIsMobile`** is in `hooks/use-mobile.ts`. It uses `matchMedia("(max-width: 767px)")` with `MOBILE_BREAKPOINT = 768`, and returns `false` on the first SSR render, so expect a layout shift or use CSS where you can.
- **Dialog vs Drawer:** the docs' "Responsive Dialog" example renders a Dialog on desktop and a Drawer on mobile:
  ```tsx
  const isMobile = useIsMobile();
  return isMobile ? <Drawer>...</Drawer> : <Dialog>...</Dialog>;
  ```
- **Tables become cards** with pure CSS, which avoids hydration flicker: `<div className="hidden md:block"><Table/></div><div className="md:hidden space-y-2">{rows.map(r => <Card/>)}</div>`. TanStack Table also works with a `columnVisibility` that depends on `isMobile`.
- **Container queries** are built into Tailwind v4 with no plugin: `<div className="@container"><div className="grid @md:grid-cols-2 @3xl:grid-cols-4">`. Named containers use `@container/main` with `@lg/main:…`. Use them inside the sidebar inset, where the viewport width doesn't reflect the space available.

---

## B) MCP server inside Next.js

### Spec and packages
| Item | Value |
|---|---|
| **Current MCP spec** | **2026-07-28**. Previous revisions: 2025-11-25, then 2025-06-18. |
| What changed in 2026-07-28 | No protocol sessions or `Mcp-Session-Id`. No `initialize` handshake: every request carries its protocol version and client capabilities in `_meta`. New mandatory `server/discover`. A `subscriptions/listen` POST stream replaces the GET stream. SSE resumability removed. `resultType` added to results. Required `Mcp-Method`/`Mcp-Name` headers. `ttlMs`/`cacheScope` on list results. Roots, Sampling and Logging deprecated. DCR deprecated in favour of **CIMD** (Client ID Metadata Documents). |
| `mcp-handler` | **2.3.0** (Oct 7, 2026). Requires `@modelcontextprotocol/server@^2`, `zod@^4.2`, Node 20+, Next 13+. Serves 2026-07-28 natively and falls back to stateless handling for 2025-era Streamable HTTP clients. GET/DELETE return 405. |
| MCP TS SDK v2 | **`@modelcontextprotocol/server@2.3.1`** (stable v2 line). Optional adapters: `@modelcontextprotocol/{express,fastify,hono,node}`. Client package: `@modelcontextprotocol/client`. |
| MCP TS SDK v1 | `@modelcontextprotocol/sdk@1.32.1` is still maintained. Use it only with `mcp-handler@1.x`. |

### Option 1: `mcp-handler` (recommended)
```bash
npm install mcp-handler@^2 @modelcontextprotocol/server@^2 zod@^4
```
```ts
// app/api/mcp/route.ts  — path is free: the handler ignores the pathname
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";

const handler = createMcpHandler((server) => {
  server.registerTool("list_invoices", {
    title: "Rechnungen auflisten",
    description: "List invoices filtered by status/date. Returns max `limit` items; use `cursor` for next page.",
    inputSchema: z.object({ status: z.enum(["draft","open","paid","overdue"]).optional(),
                            limit: z.number().int().max(50).default(20), cursor: z.string().optional() }),
    outputSchema: z.object({ items: z.array(z.object({ id: z.string(), number: z.string(), total: z.number() })), nextCursor: z.string().nullable() }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args, ctx) => {
    const orgId = ctx.http?.authInfo?.extra?.orgId;   // v2: ctx.http?.authInfo (v1 was extra.authInfo)
    const data = /* fetchQuery(api.invoices.list, {...}) via Convex */ { items: [], nextCursor: null };
    return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
  });
}, { serverInfo: { name: "rechnungen", version: "1.0.0" } });

const verifyToken = async (req: Request, bearer?: string): Promise<AuthInfo | undefined> => {
  if (!bearer) return undefined;
  const key = await lookupApiKeyByHash(sha256(bearer));      // same API-key store as REST (section C)
  if (!key || key.revokedAt) return undefined;
  return { token: bearer, clientId: key.id, scopes: key.scopes, extra: { orgId: key.orgId } };
};

const authHandler = withMcpAuth(handler, verifyToken, { required: true, requiredScopes: ["invoices:read"] });
export { authHandler as GET, authHandler as POST };
```
- **Removed in 2.x:** `basePath`, `redisUrl`, `maxDuration`, `disableSse`, `sessionIdGenerator`, and the `[transport]` dynamic segment. A plain `app/api/mcp/route.ts` is enough.
- **Redis** is no longer needed. The HTTP+SSE transport was removed.
- **`inputSchema`** now takes a full `z.object(...)`, not a raw shape. `server.tool()` is gone; use `registerTool`.
- **`withMcpAuth(handler, verifyToken, { required, requiredScopes, resourceMetadataPath })`** returns 401/403 with RFC 9728 `WWW-Authenticate` headers. A static API key works fine through `verifyToken`.
- **OAuth later (optional):** serve `app/.well-known/oauth-protected-resource/route.ts` using `protectedResourceHandler({ authServerUrls: [...] })` and `metadataCorsOptionsRequestHandler()`.

### Option 2: raw SDK v2 (web-standard, stateless)
```ts
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
const mcp = createMcpHandler((/* {authInfo} */) => {
  const server = new McpServer({ name: 'rechnungen', version: '1.0.0' });
  /* server.registerTool(...) */ return server;               // factory runs per request => stateless
}, { responseMode: 'json' });                                  // or 'sse'
export async function POST(req: Request) {
  const authInfo = await verify(req.headers.get('authorization')?.replace(/^Bearer /, ''));
  if (!authInfo) return new Response('Unauthorized', { status: 401 });
  return mcp.fetch(req, { authInfo });                          // tools read ctx.http.authInfo
}
```
The handler validates neither Host nor Origin headers. Add `hostHeaderValidationResponse` / `originValidationResponse` from `@modelcontextprotocol/server` in front of it. In SDK v1, the equivalent class was `WebStandardStreamableHTTPServerTransport`, but **that name does not appear in the v2 docs**.

### Connecting clients
**Claude Code** (verified at code.claude.com/docs/en/mcp):
```bash
claude mcp add --transport http rechnungen https://rechnung.example.de/api/mcp \
  --header "Authorization: Bearer sk_live_xxx"            # short forms: -t, -H ; --scope local|project|user
```
The same server in `.mcp.json`, using environment-variable expansion:
```json
{ "mcpServers": { "rechnungen": { "type": "http", "url": "${RECHNUNG_URL:-https://rechnung.example.de}/api/mcp",
  "headers": { "Authorization": "Bearer ${RECHNUNG_API_KEY}" } } } }
```
- **Don't reference Anthropic credential variables.** Variables such as `ANTHROPIC_API_KEY` read as empty in headers; use your own variable name.
- **A rejected `Authorization` header does not fall back to OAuth.**
- **Alternatives:** `claude mcp add-json` and `headersHelper` (a script that outputs headers as JSON; it re-runs on 401/403).
- **v2 runtime:** Claude Code's v2 runtime (v2.1.232+) negotiates 2026-07-28.

**claude.ai, Claude Desktop and mobile custom connectors** (claude.com/docs/connectors):
- **OAuth is not required.** Supported auth types: `none` (authless, on by default), `oauth_dcr`, `oauth_cimd`, and `static_headers`.
- **Static headers are "beta, for a limited set of organizations".** Setup: choose "No sign-in", then add the key under **Request headers**.
  - Allowed header names: `authorization`, `x-api-key`, `x-auth-token`. Other names need Anthropic's approval. Up to 4 headers.
  - Enter the value **including `Bearer `**.
  - On Team/Enterprise plans the key is shared across the organization, so it can't identify individual users.
- **Connections come from Anthropic's cloud** (`160.79.104.0/21`), not your device. A self-hosted server must be publicly reachable or allowlist that range.
- **Claude Desktop ignores remote servers in `claude_desktop_config.json`.** Use Settings > Connectors, or a stdio bridge.
- **OAuth callback URL:** `https://claude.ai/api/mcp/auth_callback`. Claude Code uses a loopback redirect on any port.

**mcp-remote** (0.14.3) as a stdio bridge with headers, for Claude Desktop local config:
```json
{ "mcpServers": { "rechnungen": { "command": "npx",
  "args": ["mcp-remote", "https://rechnung.example.de/api/mcp", "--header", "Authorization:${AUTH_HEADER}"],
  "env": { "AUTH_HEADER": "Bearer sk_live_xxx" } } } }
```
Spaces inside `args` are mangled on Windows Desktop, so put the space inside the environment variable value.

### Tool design best practices
From Anthropic's "Writing effective tools for agents" and the MCP spec:
- **Few, workflow-level tools** rather than one per endpoint, for example `create_invoice_from_customer` instead of separate list and create calls.
- **Prefixed names** like `invoice_search` and `customer_get`. Allowed characters: `[A-Za-z0-9_.-]`, 1–128 chars.
- **Unambiguous parameter names** such as `customer_id`, with strict schemas.
- **Readable fields** in responses (invoice number, customer name) rather than bare IDs.
- **A `response_format: "concise" | "detailed"` enum.**
- **Pagination** with `limit`/`cursor`, filters, and sensible defaults.
- **Actionable errors** returned as `isError: true` with an example of correct input.
- **Annotations** (hints that clients treat as untrusted):
  - `readOnlyHint` (default false)
  - `destructiveHint` (default true)
  - `idempotentHint` (default false)
  - `openWorldHint` (default true)

  The defaults are from earlier schema revisions and were not re-verified for 2026-07-28. Mark list/get tools `readOnlyHint: true`. Mark cancel/delete tools `destructiveHint: true`. For finalising (GoBD) or sending invoices, also set `_meta["anthropic/requiresUserInteraction"]: true` so Claude Code asks for approval on every call.
- **`outputSchema` plus `structuredContent`:** any JSON is allowed in 2026-07-28. For backward compatibility, **also return the JSON as a text block**.
- **Claude Code limits:**
  - Warns above 10k tokens of output and truncates at **25k tokens** (`MAX_MCP_OUTPUT_TOKENS`).
  - Text results over 50k characters are saved to a file. Raise that per tool with `_meta["anthropic/maxResultSizeChars"]` (max 500k).
  - Tool descriptions and server instructions are truncated at 2,048 characters.
  - Server instructions matter because Claude Code defers tools behind tool search.
- **Stateless spec:** return explicit handles in results and accept them as arguments, rather than relying on session state.

---

## C) Public REST API with API keys

### Key design
- **Format:** `sk_live_<base62 of 32 random bytes>`, or `sk_test_` for test keys. Generate with `crypto.randomBytes(32)`. A checksum suffix, as GitHub tokens use, helps secret scanners (optional).
- **Storage:** store only `sha256(key)` as hex with a unique index, plus `prefix` (e.g. `sk_live_AbC1`), `last4`, `scopes[]`, `orgId`, `createdBy`, `lastUsedAt`, `expiresAt` and `revokedAt`. Show the full key once at creation.
- **Hashing:** the keys are high-entropy, so a fast SHA-256 is appropriate; bcrypt/argon2 is not needed. Look up by hash with an indexed equality query. If you compare against a stored value, use `crypto.timingSafeEqual(Buffer.from(a,'hex'), Buffer.from(b,'hex'))`.
- **Where to hash:** do it in the Next.js route handler (`node:crypto`), or in Convex with `crypto.subtle.digest('SHA-256', …)` in the default runtime; `node:crypto` there needs `"use node"`.
- **Scopes:** `invoices:read`, `invoices:write`, `customers:read`, `webhooks:manage`. Check them per route and per MCP tool. One key store can serve both REST and MCP (see `verifyToken` above).
- **Accepted headers:** `Authorization: Bearer sk_…`, and optionally `X-API-Key`. **Never accept keys in query strings**; Anthropic's docs and the MCP spec both prohibit it.
- **Hygiene:** update `lastUsedAt` asynchronously, log a key ID in an audit trail, and support rotation by allowing two active keys at once.

### Rate limiting (self-hosted)
| Option | Package / version | Notes |
|---|---|---|
| In-memory | `rate-limiter-flexible@11.2.1`, using `RateLimiterMemory` | Fine for a single container: `await limiter.consume(keyId, 1)`. On rejection it returns `RateLimiterRes { msBeforeNext, remainingPoints }`, which maps to `Retry-After` / `RateLimit-*` headers. |
| Redis | Same package, `RateLimiterRedis` with `ioredis` | Use when running several replicas. |
| Convex | **`@convex-dev/rate-limiter@0.4.2`** (peer `convex ^1.43`; current `convex@1.46.0`) | Install with `app.use(rateLimiter)` in `convex/convex.config.ts`, then `new RateLimiter(components.rateLimiter, { api: { kind: "token bucket", rate: 100, period: MINUTE, capacity: 20 } })` and `await rateLimiter.limit(ctx, "api", { key: apiKeyId })` → `{ ok, retryAfter }`. `throws: true` raises a `ConvexError`. It is transactional and fails closed. **Unverified:** I found no explicit statement that components work on a self-hosted Convex backend; test it. |
| Hosted | `@upstash/ratelimit@2.2.0` | Not self-hosted. |

### OpenAPI generation (zod v4; current `zod@4.6.6`)
- **Built into zod:** `z.toJSONSchema(schema, { target: "openapi-3.0" | "draft-2020-12" | "draft-07" | "draft-04", io: "input" | "output", reused: "ref", unrepresentable: "any" })`. Schemas with `.meta({ id })` are extracted into `$defs`. Good for building the document by hand.
- **`zod-openapi` (samchungy) `6.0.2`:** peer `zod ^4`, **Node >= 22.14**. Uses zod's native `.meta({ id, param, header, description, example })` with no monkey-patching.
  ```ts
  import { createDocument } from 'zod-openapi';
  const doc = createDocument({ openapi: '3.1.0', info: { title: 'Rechnungs-API', version: '1.0.0' },
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } }, security: [{ bearer: [] }],
    paths: { '/v1/invoices/{id}': { get: { requestParams: { path: z.object({ id: z.string() }) },
      responses: { '200': { description: 'OK', content: { 'application/json': { schema: Invoice } } } } } } } });
  ```
- **`@asteasolutions/zod-to-openapi` `9.1.0`:** peer `zod ^4`. Supports zod v4 since v8, and can read `.meta()` without `extendZodWithOpenApi`. Uses `OpenAPIRegistry`, and `OpenApiGeneratorV3`/`V31`/`V32` (3.2 supported).
- **`@hono/zod-openapi` `1.6.3`** (hono `4.13.13`): route definitions double as the spec. Mount it in Next.js via `app/api/[[...route]]/route.ts` with `handle(app)` from `hono/vercel`.
- **Others:** `@orpc/openapi@1.15.6`, `next-openapi-gen@1.9.0` (Node >= 24).
- **Serving docs:** `@scalar/nextjs-api-reference@0.12.9` (peer `next ^15 || ^16`, Node >= 22):
  ```ts
  // app/api/openapi.json/route.ts → return Response.json(doc)
  // app/docs/route.ts
  import { ApiReference } from '@scalar/nextjs-api-reference';
  export const GET = ApiReference({ url: '/api/openapi.json' });
  ```

### Webhooks (Standard Webhooks spec; `standardwebhooks@1.1.1`)
- **Headers:**
  - `webhook-id`: stable across retries, so receivers can use it as an idempotency key.
  - `webhook-timestamp`: Unix seconds.
  - `webhook-signature`: `v1,<base64 HMAC-SHA256>`. Multiple space-separated signatures allow secret rotation; `v1a,` is the ed25519 variant.
- **Signed content:** `${id}.${timestamp}.${rawBody}`. The body must be byte-identical, so don't re-serialize it.
- **Secret:** `whsec_` + base64 of 24–64 random bytes.
- **Payload:** `{ "type": "invoice.paid", "timestamp": "<ISO8601>", "data": {...} }`.
- **Library API:** `new Webhook(secret)`, `.sign(msgId: string, timestamp: Date, payload: string): string`, `.verify(payload, headers)`. Timestamp tolerance is 5 minutes, and comparison is constant-time.
  ```ts
  import { Webhook } from 'standardwebhooks';
  const wh = new Webhook(endpoint.secret);                 // "whsec_..."
  const id = `msg_${ulid()}`, ts = new Date(), body = JSON.stringify(event);
  await fetch(endpoint.url, { method: 'POST', body, signal: AbortSignal.timeout(15_000), headers: {
    'content-type': 'application/json', 'webhook-id': id,
    'webhook-timestamp': String(Math.floor(ts.getTime()/1000)), 'webhook-signature': wh.sign(id, ts, body) } });
  ```
- **Delivery and retries:**
  - Any 2xx counts as success. Everything else is a failure, including 3xx (don't follow redirects).
  - Timeout around 15–30s.
  - Honour `Retry-After` on 429/502/504.
  - On **410 Gone**, disable the endpoint.
  - Backoff with jitter, using the spec's example schedule: immediately, then 5s, 5m, 30m, 2h, 5h, 10h, 14h, 20h, 24h (about 3 days in total).
- **Convex implementation:** an outbox table plus `ctx.scheduler.runAfter(delayMs, internal.webhooks.deliver, { attemptId })` in an action, with attempt logs. The Convex Workpool/Action Retrier components are possible alternatives, but I did not verify them.

---

## Uncertain points
1. **Turbopack wording:** I did not re-confirm "default for both dev and build" in the 16.4 post. It is consistent with the 16.0 release.
2. **MCP tool annotation defaults:** taken from earlier schema revisions, not re-checked against the 2026-07-28 schema page.
3. **`@convex-dev/rate-limiter` on self-hosted Convex:** not explicitly documented.
4. **Static-header auth for claude.ai connectors:** beta for limited organizations. If yours lacks it, fall back to authless + `mcp-remote`, or implement OAuth with CIMD/DCR (`protectedResourceHandler` + an authorization server).
5. **The Oct 14 Next.js security release** will bump the patch version. Pin `next@^16.4.x` after it ships.

## Sources
- https://nextjs.org/blog
- https://nextjs.org/blog/next-16-4
- https://nextjs.org/docs/app/api-reference/file-conventions/proxy
- https://github.com/vercel/next.js/tree/canary/examples/with-docker
- https://ui.shadcn.com/docs/installation/next
- https://ui.shadcn.com/docs/tailwind-v4
- https://ui.shadcn.com/docs/components-json
- https://ui.shadcn.com/docs/components/sidebar
- https://ui.shadcn.com/docs/components/drawer
- https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default
- https://ui.shadcn.com/docs/changelog/2026-03-cli-v4
- https://github.com/vercel/mcp-handler (README, docs/AUTHORIZATION.md, docs/CLIENTS.md)
- https://ts.sdk.modelcontextprotocol.io/v2/serving/http
- https://modelcontextprotocol.io/specification/versioning
- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- https://code.claude.com/docs/en/mcp
- https://claude.com/docs/connectors/custom/add-unlisted
- https://claude.com/docs/connectors/building/authentication
- https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- https://github.com/geelen/mcp-remote
- https://www.anthropic.com/engineering/writing-tools-for-agents
- https://github.com/get-convex/rate-limiter
- https://convex.dev/components/rate-limiter
- https://zod.dev/json-schema
- https://github.com/samchungy/zod-openapi
- https://github.com/asteasolutions/zod-to-openapi
- https://github.com/scalar/scalar/tree/main/integrations/nextjs
- https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
- npm registry entries for all package versions listed above
