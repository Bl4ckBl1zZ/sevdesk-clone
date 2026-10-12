# Self-hosted German invoicing app (sevdesk clone): technology research, October 2026

I checked this on 2026-10-12 against official docs, GitHub source, the npm registry, Docker Hub and the GitHub release APIs. Items marked **[UNCERTAIN]** could not be confirmed from a primary source. I wrote no files.

**Things that make older guides wrong:**
- **Next.js**
  - The current version is **16.4.0**. `middleware.ts` has been replaced by `proxy.ts`.
  - Cache Components (`"use cache"`) is now on by default in new apps.
  - A security patch is announced for **2026-10-14**.
- **MCP**
  - The current spec is **2026-07-28**. It has no sessions and no `initialize` handshake.
  - **`mcp-handler` 2.x** dropped `basePath`, Redis and SSE.
  - The TypeScript SDK v2 is a new package, **`@modelcontextprotocol/server`**.
- **Dokploy CLI:** the docs page is out of date. `dokploy authenticate` and `env pull/push` **no longer exist**. The command is now `dokploy auth`.
- **Major version bumps:** Vitest is at **5**, MSW at **3**, `@asteasolutions/zod-to-openapi` at **9**, and shadcn defaults to **Base UI** instead of Radix (since July 2026).
- **Banking and tax services**
  - **GoCardless Bank Account Data** has accepted no new signups since about July 2025.
  - The **BZSt eVatR XML-RPC** interface was shut down on 30.11.2025. Use the new REST API.
  - The **`fints`** npm package is dead; **`lib-fints`** is the maintained one.
- **PDF and e-invoice libraries**
  - **`pdf-lib`** has had no release since 2021. Use **`@cantoo/pdf-lib`**, which has `embedFacturX()` built in.
  - **`@react-pdf/renderer` 4.9** can now output PDF/A-3b directly.

---

## 0. Version quick reference (npm `latest` / GitHub releases, 2026-10-12)

| Area | Package / artifact | Version (date) |
|---|---|---|
| Framework | `next` | 16.4.0 (2026-10-06) |
| | `react` / `react-dom` | 19.3.0 |
| | `tailwindcss` / `@tailwindcss/postcss` | 4.3.3 |
| | `shadcn` (CLI) | 4.21.4 |
| | `tw-animate-css` | 1.4.0 |
| Convex | `convex` | 1.46.0 (2026-09-16) |
| | `convex-test` | 0.0.61 (2026-10-09) |
| | `@convex-dev/rate-limiter` | 0.4.2 |
| | Backend/dashboard images | `ghcr.io/get-convex/convex-backend` / `convex-dashboard`, tags `latest` or a git SHA. Newest release: `precompiled-2026-10-10-72ce13c` |
| Dokploy | Dokploy server | v0.30.8 (2026-09-29) |
| | `@dokploy/cli` | 0.30.7 |
| MCP | `mcp-handler` | 2.3.0 (2026-10-07) |
| | `@modelcontextprotocol/server` (SDK v2) | 2.3.1 |
| | `@modelcontextprotocol/sdk` (v1, legacy) | 1.32.1 |
| | `mcp-remote` | 0.14.3 |
| | Spec | **2026-07-28** (previous: 2025-11-25, 2025-06-18) |
| API | `zod` | 4.6.6 |
| | `zod-openapi` | 6.0.2 |
| | `@asteasolutions/zod-to-openapi` | 9.1.0 |
| | `@hono/zod-openapi` | 1.6.3 |
| | `@scalar/nextjs-api-reference` | 0.12.9 |
| | `standardwebhooks` | 1.1.1 |
| | `rate-limiter-flexible` | 11.2.1 |
| PDF | `@react-pdf/renderer` | 4.9.0 (2026-08-27) |
| | `@cantoo/pdf-lib` | 2.11.1 (2026-09-15) |
| | `pdf-lib` | 1.17.1 (**2021**, unmaintained) |
| | `pdfmake` | 0.3.11 |
| | `pdfjs-dist` | 6.4.299 |
| E-invoice | `@e-invoice-eu/core` | 3.4.0 (2026-10-04) |
| | `node-zugferd` | 0.1.1-beta.1 (2025-08, stale) |
| | Mustang | core-2.26.0 (2026-08-25) |
| | KoSIT validator | v1.6.3 (2026-08-20) |
| | XRechnung validator config | v2026-08-31 |
| | veraPDF | 1.30.3 |
| | Gotenberg | 8.37.0 |
| | `fast-xml-parser` | 5.11.2 |
| Testing | `vitest` | 5.0.4 (4.1.11 on the `V4` tag) |
| | `@playwright/test` | 1.64.0 |
| | `msw` | 3.0.3 |
| | `@testing-library/react` | 16.3.3 |
| | `jsdom` | 30.1.2 |
| | `@edge-runtime/vm` | 5.0.0 |
| Misc | `ibantools` | 4.5.4 |
| | `qrcode` | 1.5.4 |
| | `sepa-payment-qr-code` | 2.0.2 |
| | `lib-fints` | 1.5.2 |
| | `camt-parser` | 2.1.0 |
| | `mt940js` | 1.3.5 (2020) |
| | `tesseract.js` | 7.0.0 |
| | `@anthropic-ai/sdk` | 0.133.0 |
| | `nodemailer` | 10.1.0 |
| | `resend` | 6.32.1 |
| | `react-email` | 6.11.1 |

---

## 1. Self-hosted Convex

### 1.1 Images and versions
- **Images:** `ghcr.io/get-convex/convex-backend` and `ghcr.io/get-convex/convex-dashboard`. The only tags are `latest` and 40-character commit SHAs; there is no semver.
  - Newest SHAs, matching release `precompiled-2026-10-10-72ce13c`: `72ce13c379fe6dbdfc305bc8ad699c5663c68c2a` and `bb95347206534c36ffc2b842dad28bd3479e0fec`.
- **Pin backend and dashboard to the same SHA.** The CHANGELOG says different versions are not guaranteed to be compatible.
  - **[UNCERTAIN]** The `:latest` digest didn't match any of the last 25 SHA tags, so `latest` may be built from a different commit.
- **CHANGELOG** is not maintained since 2025-09; use `git log`.
  - Milestones: S3 (2025-02), R2 (2025-03), `POSTGRES_URL`/`MYSQL_URL` replacing `DATABASE_URL` (2025-02), `AWS_S3_FORCE_PATH_STYLE` (2025-08), log streams in self-hosted (2025-07).
- **License:** FSL-1.1-Apache-2.0. Each release becomes Apache-2.0 after 2 years. You may not build a product that competes with Convex Cloud.

### 1.2 Official `self-hosted/docker/docker-compose.yml` (condensed, values verbatim)
```yaml
services:
  backend:
    image: ghcr.io/get-convex/convex-backend:latest   # pin :<SHA>
    stop_grace_period: 10s
    stop_signal: SIGINT
    ports: ["${PORT:-3210}:3210", "${SITE_PROXY_PORT:-3211}:3211"]
    volumes: [data:/convex/data]
    environment:
      - INSTANCE_NAME
      - INSTANCE_SECRET
      - CONVEX_CLOUD_ORIGIN=${CONVEX_CLOUD_ORIGIN:-http://127.0.0.1:${PORT:-3210}}
      - CONVEX_SITE_ORIGIN=${CONVEX_SITE_ORIGIN:-http://127.0.0.1:${SITE_PROXY_PORT:-3211}}
      - POSTGRES_URL
      - MYSQL_URL
      - DATABASE_URL            # deprecated
      - DO_NOT_REQUIRE_SSL
      - AWS_REGION
      - AWS_ACCESS_KEY_ID
      - AWS_SECRET_ACCESS_KEY
      - AWS_SESSION_TOKEN
      - AWS_S3_FORCE_PATH_STYLE
      - AWS_S3_DISABLE_SSE
      - AWS_S3_DISABLE_CHECKSUMS
      - S3_ENDPOINT_URL
      - S3_STORAGE_EXPORTS_BUCKET
      - S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET
      - S3_STORAGE_MODULES_BUCKET
      - S3_STORAGE_FILES_BUCKET
      - S3_STORAGE_SEARCH_BUCKET
      - DISABLE_BEACON
      - REDACT_LOGS_TO_CLIENT
      - RUST_LOG=${RUST_LOG:-info}
      - RUST_BACKTRACE
      - DISABLE_METRICS_ENDPOINT=${DISABLE_METRICS_ENDPOINT:-true}
      - DOCUMENT_RETENTION_DELAY=${DOCUMENT_RETENTION_DELAY:-172800}
      - APPLICATION_MAX_CONCURRENT_MUTATIONS=${APPLICATION_MAX_CONCURRENT_MUTATIONS:-16}
      - APPLICATION_MAX_CONCURRENT_QUERIES=${APPLICATION_MAX_CONCURRENT_QUERIES:-16}
      - APPLICATION_MAX_CONCURRENT_V8_ACTIONS=${APPLICATION_MAX_CONCURRENT_V8_ACTIONS:-16}
      - APPLICATION_MAX_CONCURRENT_NODE_ACTIONS=${APPLICATION_MAX_CONCURRENT_NODE_ACTIONS:-16}
      - V8_ACTION_USER_TIMEOUT_SECS
      - NODE_ACTION_USER_TIMEOUT_SECS
      - HTTP_SERVER_TIMEOUT_SECONDS
      - CONVEX_RELEASE_VERSION_DEV
    healthcheck:
      test: curl -f http://localhost:3210/version
      interval: 5s
      start_period: 10s
  dashboard:
    image: ghcr.io/get-convex/convex-dashboard:latest  # same SHA as backend
    ports: ["${DASHBOARD_PORT:-6791}:6791"]
    environment:
      - NEXT_PUBLIC_DEPLOYMENT_URL=${NEXT_PUBLIC_DEPLOYMENT_URL:-http://127.0.0.1:${PORT:-3210}}
      - NEXT_PUBLIC_LOAD_MONACO_INTERNALLY
    depends_on:
      backend: { condition: service_healthy }
volumes:
  data:
```
- **Ports:** 3210 serves the API and WebSocket (`CONVEX_CLOUD_ORIGIN`). 3211 serves HTTP actions (`CONVEX_SITE_ORIGIN`). 6791 is the dashboard.
- **State:** everything lives in `/convex/data`: `db.sqlite3`, `storage/` and `credentials/`.

### 1.3 Environment variables (behaviour verified in `docker-build/run_backend.sh`)
| Var | Notes |
|---|---|
| `INSTANCE_NAME` | Defaults to `convex-self-hosted`. With Postgres/MySQL, the database name is INSTANCE_NAME with `-` replaced by `_` (e.g. `convex_self_hosted`). **Create that database first.** |
| `INSTANCE_SECRET` | If unset, it is generated with `openssl rand -hex 32` and saved in the volume. **Set it explicitly in Dokploy.** Changing it invalidates all admin keys. |
| `CONVEX_CLOUD_ORIGIN` | Public API URL, e.g. `https://convex-api.example.de`. It is also used in file-storage URLs, so it must be the public HTTPS URL. |
| `CONVEX_SITE_ORIGIN` | Public HTTP-actions URL, e.g. `https://convex-site.example.de`. |
| `NEXT_PUBLIC_DEPLOYMENT_URL` | Dashboard setting: the backend URL **as the browser reaches it**. |
| `POSTGRES_URL` / `MYSQL_URL` | Connection string **without database name or query params**, e.g. `postgresql://user:pass@host:5432`. Tested with Postgres 17 and MySQL 8. Keep the database close to the backend (same host or region). |
| `DATABASE_URL` | Deprecated. It still works but is treated as Postgres and logs a warning. |
| `DO_NOT_REQUIRE_SSL` | Needed for an internal database without TLS. |
| S3 | `AWS_REGION` plus **all five** `S3_STORAGE_*_BUCKET` variables are required. If only some are set, it warns and falls back to local storage. Use `S3_ENDPOINT_URL` for R2, MinIO or Hetzner, and `AWS_S3_FORCE_PATH_STYLE` for MinIO. |
| `REDACT_LOGS_TO_CLIENT` | Recommended for production. |
| `DISABLE_BEACON` | Turns off the anonymous usage beacon. |

- **Default storage:** with nothing set, the backend uses SQLite and local file storage.
- **Gotcha:** `DISABLE_BEACON`, `REDACT_LOGS_TO_CLIENT` and `DO_NOT_REQUIRE_SSL` use `${VAR:+--flag}`. **Any non-empty value, including `false`, turns them on.**

### 1.4 Admin key and deploying functions
```sh
docker compose exec backend ./generate_admin_key.sh
# -> convex-self-hosted|01c046ab...
# In Dokploy: open the backend container's terminal and run ./generate_admin_key.sh
```
- **The admin key is the only credential.** Self-hosted has no deploy keys or preview keys. The key stays valid until `INSTANCE_SECRET` changes.

`.env.local` (gitignored):
```sh
CONVEX_SELF_HOSTED_URL='https://convex-api.example.de'
CONVEX_SELF_HOSTED_ADMIN_KEY='<admin key>'
NEXT_PUBLIC_CONVEX_URL='https://convex-api.example.de'
```
- **`NEXT_PUBLIC_CONVEX_URL` must be set by hand** [medium confidence, from the CLI source]. With self-hosted variables the CLI doesn't write it for you.
- **Commands:** `npx convex dev` (watch), `npx convex dev --once`, `npx convex deploy`, `npx convex deploy --env-file .env.prod`. `--url` and `--admin-key` are hidden flags.
- **Don't mix modes:** `CONVEX_DEPLOYMENT` must **not** be set alongside the self-hosted variables; the CLI errors.
- **CI/build pattern** (from the README, with the self-hosted variables in place of `CONVEX_DEPLOY_KEY`):
  ```sh
  npx convex deploy --cmd 'npm run build' --cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL
  ```
  - In a Dockerfile, pass the admin key with `RUN --mount=type=secret`, never as `ARG`.
  - Simpler alternative: run `npx convex deploy` as its own CI step, then `next build` with `NEXT_PUBLIC_CONVEX_URL` as a build arg.
- **Environment variables for functions:** `npx convex env set KEY value`.

### 1.5 Backups, restore, upgrades
```sh
npx convex export --path ./backups/ --include-file-storage     # snapshot_{ts}.zip (tables as JSONL + _storage/)
npx convex env list --include-values > .env.convex             # env vars are NOT in exports
npx convex import --replace-all snapshot.zip                   # also --replace / --append / --table T / -y
npx convex env set --force --from-file .env.convex
```
- **Exports leave out** code, environment variables and pending scheduled functions.
- **No automatic backups in self-hosted** (that is a Convex Cloud Pro feature) **[UNCERTAIN]**. Schedule `npx convex export` with a cron job, and add a Dokploy volume backup or `pg_dump`.
- **Upgrade, option 1 (in place):** export first as a safety net, bump both image SHAs, and watch the logs for `MigrationComplete(N)`. Export/import is not required.
- **Upgrade, option 2:** stop traffic, export, upgrade, `import --replace-all`, restore environment variables.
- **Switching SQLite → Postgres or local → S3:** export, start a fresh backend, import, redeploy functions.
- **Clearing a table:** `npx convex import --table T --replace --format jsonLines /dev/null -y`.

### 1.6 Features in self-hosted
- **Supported:** the README says self-hosted supports "all the free-tier features of the cloud-hosted product". That includes:
  - queries, mutations and actions (including `"use node"`)
  - **HTTP actions** (`convex/http.ts` → port 3211 / site origin)
  - **file storage** (`ctx.storage`)
  - **scheduled functions and crons**
  - text and vector search, components, the dashboard, and log streams
- **Limits:**
  - Runs on a single machine and scales vertically. You handle operations yourself.
  - One backend is one deployment, so dev, staging and prod each need their own backend and key.
  - No preview deployments or deploy keys.
  - The Convex Auth CLI setup doesn't work self-hosted (manual setup only).
- **[UNCERTAIN]** whether components such as `@convex-dev/rate-limiter` work on self-hosted. Components are listed as supported in general, but test it.

### 1.7 Next.js integration
```tsx
// app/ConvexClientProvider.tsx
"use client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
export function ConvexClientProvider({ children }: { children: React.ReactNode }) {
  return <ConvexProvider client={convex}>{children}</ConvexProvider>;
}
```
```tsx
// app/invoices/page.tsx (Server Component)
import { preloadQuery, fetchQuery, fetchMutation } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
export default async function Page() {
  const preloaded = await preloadQuery(api.invoices.list, {}, { url: process.env.CONVEX_INTERNAL_URL }); // optional internal URL
  return <InvoiceList preloaded={preloaded} />;   // client: usePreloadedQuery(preloaded)
}
```
- **URL:** these helpers need `NEXT_PUBLIC_CONVEX_URL` or `{ url }` in the third argument. Auth goes in the same argument as `{ token }`.
- **Internal URL:** server code can use the Docker-internal address (`http://backend:3210` on `dokploy-network`) while browsers use the public URL.
- **Caching:** the helpers use `ConvexHttpClient` with `no-store`, so pages are dynamic. Several `preloadQuery` calls on one page aren't guaranteed to be consistent. Next.js SSR support is marked **beta**.

### 1.8 Auth
- **Convex Auth is not needed.** Without it, `ctx.auth.getUserIdentity()` returns `null`.
- **Risk:** every public function can be called by anyone who knows the API URL, and Basic Auth on the Next.js app does **not** protect the Convex API.
- **Options for an app without logins:**
  - (a) Make sensitive functions `internal*` and call them only from Next.js server code or HTTP actions that check a shared secret.
  - (b) Add a custom JWT provider (`convex/auth.config.ts`) later.

### 1.9 Dokploy template for Convex
- **It exists:** `github.com/Dokploy/templates/blueprints/convex`.
- **Contents:**
  - **3 domains:** dashboard → `dashboard:6791`, backend → `backend:3210`, actions → `backend:3211`.
  - Uses `expose` rather than `ports`.
  - Images pinned to SHA `5cdea511cd6527a95dd24152ea0d3c3bb2ab379f`, which is old. Sources disagree on when it was last bumped (2025-08 vs 2026-03); either way it lags current releases.
- **Problems:**
  - URLs use `http://`; switch to `https://` after enabling Let's Encrypt.
  - Uses the deprecated `DATABASE_URL` and `ACTIONS_USER_TIMEOUT_SECS`.
  - `DISABLE_BEACON=${DISABLE_BEACON:-FALSE}` actually *disables* the beacon (see 1.3).
  - No S3 or `POSTGRES_URL` variables.
- **Recommendation:** use the official compose with `ports` changed to `expose`, pin a current SHA, and add the 3 domains in Dokploy.
- **Alternative reference:** Coolify's `templates/compose/convex.yaml` has the full S3 and Postgres variable set.

### 1.10 Local dev and tests
- **Docker:** `docker compose up` with the official file, then point `.env.local` at `http://127.0.0.1:3210`. This mirrors production.
- **Anonymous local deployment (beta):** `npx convex dev` without a login (or `CONVEX_AGENT_MODE=anonymous`) runs a local backend; state goes in `.convex/`. `--local` is now a hidden flag. Don't mix this with the self-hosted variables.
- **CI:** run the backend image as a service, set a fixed `INSTANCE_SECRET`, `docker exec … ./generate_admin_key.sh`, then `npx convex deploy`.
- **Precompiled binaries** are also attached to releases (`convex-local-backend-x86_64-unknown-linux-gnu.zip`).

---

## 2. Dokploy

### 2.1 Install
```bash
curl -sSL https://dokploy.com/install.sh | sh          # latest = v0.30.8
curl -sSL https://dokploy.com/install.sh | sh -s update
```
- **Requirements:** at least 2 GB RAM and 30 GB disk; ports 80, 443 and 3000 free.
- **Firewall:** keep port 3000 closed to the public. Docker bypasses UFW, so use `ufw-docker`.
- **Bundled Traefik:** `traefik:v3.6.x`.
- **ACME email:** the default is `test@localhost.com`. **Set a real one** in Web Server → Traefik.

### 2.2 CLI: `@dokploy/cli` 0.30.7, binary `dokploy`
```bash
npm i -g @dokploy/cli
dokploy auth -u https://dokploy.example.com -t <API_KEY>
# or env: DOKPLOY_URL=... DOKPLOY_API_KEY=...   (also read from ./.env)
```
- **Generated from the OpenAPI spec:** about 449 commands in 43 groups, in the form `dokploy <group> <action> --camelCaseFlags [--json]`. API method names become kebab-case (`application.saveBuildType` → `application save-build-type`).
- **docs.dokploy.com/docs/cli is out of date.** `authenticate`, `verify`, `app create` and `env pull/push` are gone.
  - Read environment variables with `application one --applicationId X --json`.
  - Write them with `application save-environment` or `compose save-environment`.
- **Main groups:**
  - `project create --name`
  - `environment create`
  - `application create --name --environmentId` (also `deploy`, `redeploy`, `save-build-type`, `save-environment`, `save-github-provider`, `update-traefik-config`, …)
  - `compose create --name --environmentId [--composeType docker-compose|stack] [--sourceType raw|github|git…] [--composeFile]` (also `deploy`, `save-environment --composeId --env`, `deploy-template`)
  - `domain create --host …`
  - `postgres|mysql|mariadb|mongo|redis|libsql create/deploy/…`
  - `backup create`, `volume-backups create`, `schedule create`
  - `security create` (basic auth)
  - `destination create`, `rollback`, `preview-deployment`, `settings reload-traefik`, `user create-api-key`
- **API token:** Settings → **Profile** → API/CLI → Generate. Tokens don't expire unless you set an expiry.

### 2.3 REST API
- **Endpoints:** `https://<host>/api/<router>.<procedure>`. It is tRPC exposed as OpenAPI: mutations are `POST` with a JSON body, queries are `GET` with query parameters.
- **Auth header:** `x-api-key: <token>`.
- **Docs:** Swagger UI at `https://<host>/swagger` (admins only). Reference pages at `docs.dokploy.com/docs/api/reference-<router>`.
```bash
curl -s 'https://dokploy.example.com/api/project.all' -H 'x-api-key: $T'
curl -X POST 'https://dokploy.example.com/api/application.deploy' -H 'Content-Type: application/json' \
  -H "x-api-key: $T" -d '{"applicationId":"<id>"}'
curl -X POST 'https://dokploy.example.com/api/domain.create' -H 'Content-Type: application/json' -H "x-api-key: $T" \
  -d '{"host":"convex-api.example.de","port":3210,"https":true,"certificateType":"letsencrypt","composeId":"<id>","serviceName":"backend","domainType":"compose"}'
```
**Key endpoints:**
- `project.create {name}` returns `{project, environment}`.
- `application.create {name, environmentId}`.
- `application.saveBuildType {applicationId, buildType: dockerfile|nixpacks|railpack|heroku_buildpacks|paketo_buildpacks|static, dockerfile, dockerContextPath, dockerBuildStage, …}`.
- `application.saveEnvironment {applicationId, env, buildArgs, buildSecrets, createEnvFile}`.
- `compose.create {name, environmentId, composeType, sourceType, composeFile}`.
- `compose.deploy {composeId}`.
- `compose.deployTemplate {environmentId, id:"convex"}`.
- `backup.create`, `volumeBackups.create`, `security.create {applicationId, username, password}`.
- `domainType` values are probably `application|compose|preview` **[UNCERTAIN]**.
- **CI:** there is no official GitHub Action. Use curl, or the community `qbix-tech/dokploy-deploy-action`.

### 2.4 Deploying Convex as a Docker Compose service
1. Create Service → Compose (type "Docker Compose"; Stack/Swarm mode doesn't support `build:`). Source: `raw` or Git.
2. **Environment tab:** values are written to a `.env` file next to the compose file. They are **not injected automatically**. Reference them with `${VAR}` in `environment:` or use `env_file: [.env]`.
3. **Domains tab:** add one domain per Service Name and Port (backend:3210, backend:3211, dashboard:6791), turn on HTTPS with Let's Encrypt, and **redeploy**. Compose domains are Traefik labels and don't hot-reload.
4. **Volumes:**
   - Use **named volumes**; only these can use Volume Backups. The real name is `{appName}_{volume}`.
   - Use `../files/…` for config files.
   - Never use absolute host paths, and never use `./` with Git sources (the repo is re-cloned on every deploy).
5. **Admin key:** generate it from the backend container's terminal.
6. **Isolated Deployment** (on by default for templates) puts all services on a dedicated network that Traefik joins.

### 2.5 Deploying the Next.js app
| Build type | What happens to env vars at build time |
|---|---|
| **Nixpacks** (default) / **Railpack** | Environment-tab variables **are available at build time**, so `NEXT_PUBLIC_*` gets baked in. |
| **Dockerfile** | Runtime env is **not** passed to `docker build`. Put `NEXT_PUBLIC_CONVEX_URL` in **Build Args** and declare `ARG`/`ENV` in the builder stage. Put secrets such as `CONVEX_SELF_HOSTED_ADMIN_KEY` in **Build Secrets** and read them with `RUN --mount=type=secret,id=…`. |

- **Recommended:** `output: 'standalone'` with a multi-stage Dockerfile (section 3.2). Set the domain port to 3000.
- **For production, consider building in CI** and deploying the image (source type Docker). Dokploy recommends this to avoid freezing the server during builds.
- **Auto-deploy:** the GitHub App deploys on push automatically (`triggerType` push or tag; `watchPaths` for monorepos). Other Git hosts and registries use a webhook URL.

### 2.6 Domains, Traefik, HTTPS
- **Domain fields:** host, path, internal path, strip path, port, HTTPS, certificate (Let's Encrypt / none / custom), and **Middlewares** (e.g. `office-only@file`).
- **Traefik setup:** the provider file directory is `/etc/dokploy/traefik/dynamic`. The cert resolver is `letsencrypt` (HTTP challenge). DNS challenge is available for Cloudflare and Route53.
- **Per-app config:** Advanced → Traefik edits the app's router YAML.
- **Global config:** Web Server → Traefik → File System → `dynamic/middlewares.yml`.

### 2.7 Volumes, backups, cron
- **S3 destinations:** Settings → Destinations (any S3-compatible store).
- **Database backups:** for Postgres, MySQL, MariaDB, Mongo and libSQL, with cron and `keepLatestCount`. **Databases inside a compose file can be backed up too** (`backupType: "compose"` + `serviceName`).
- **Volume Backups** (named volumes, apps and compose) to S3 on a cron schedule:
  - **Turn on "Turn off container"** for consistency (important for Convex's SQLite).
  - Restore through Restore Volume.
- **Web Server backup:** covers Dokploy's own database plus `/etc/dokploy`.
- **Schedule Jobs:** run in an application container, a compose service, on the host, or inside Dokploy. Useful for nightly `npx convex export`.

### 2.8 Protecting an app with no login
- **Basic Auth (Applications only):** Advanced → **Security** → username and password (`security.create`). It generates the `auth-<appName>` middleware. **Compose services don't have this tab.**
- **IP allowlist:** add to `dynamic/middlewares.yml`:
  ```yaml
  http:
    middlewares:
      redirect-to-https: { redirectScheme: { scheme: https, permanent: true } }   # keep default
      office-only:
        ipAllowList:
          sourceRange: ["203.0.113.10/32", "10.8.0.0/24"]
          # behind Cloudflare: ipStrategy: { depth: 1 }
      dash-basic:
        basicAuth: { users: ["admin:$apr1$..."] }   # htpasswd -nb admin pass
  ```
  Then attach it:
  - in a domain's Middlewares field as `office-only@file` (works for apps and compose; redeploy compose), or
  - with a compose label: `traefik.http.routers.<r>.middlewares=office-only@file`. Escape `$` as `$$` in compose.
- Use `ipAllowList`; `ipWhiteList` is deprecated in Traefik v3.
- **Don't put basic auth on the Convex API (3210/3211).** Browsers call it directly over WebSocket. Protect the dashboard (6791) and the Next.js app instead.
- An IP allowlist or VPN (WireGuard/Tailscale) is the strongest option for a single-user app.
- SSO forward-auth requires the Enterprise license.

### 2.9 Other features
- **Rollbacks:** Swarm health check with `FailureAction: rollback` (also gives zero-downtime deploys), or registry-based rollback (applications only).
- **Preview deployments:** GitHub apps only, wildcard domain, default limit 3.
- **Multi-server:** over SSH, with separate build servers.
- **Monitoring:** per-service graphs. Full server monitoring may be Cloud-only **[UNCERTAIN]**.
- **Notifications:** Slack, Discord, Telegram, email, ntfy, webhook, and others.
- **Resource limits** take raw bytes and nanoCPUs, not `1024m`.

---

## 3. Next.js 16.4 + shadcn/ui + Tailwind v4

### 3.1 Version and features
- **`next@16.4.0`** (2026-10-06). A **security release is announced for 2026-10-14** (2 Critical, 1 High in upstream dependencies); upgrade to 16.4.x once it ships.
- **Runtime:** React **19.3**. Node **≥20.9**; the official Docker example uses `node:24.13.0-slim`.
- **App Router, Server Actions/Functions and Route Handlers** are stable.
  - **Server Functions are POSTs to the page route.** A proxy matcher can skip them, so check auth inside each one.
- **Turbopack** is the default for dev and build (since 16.0).
- **Cache Components / `"use cache"`** with `cacheLife()`: `create-next-app` turns it on by default since 16.4, with `cacheComponents: true`. Next 17 will make it the global default.
- **`proxy.ts` replaces `middleware.ts`:** it exports `proxy` and always runs on Node. Migrate with `npx @next/codemod@canary middleware-to-proxy .`
```ts
// next.config.ts
import type { NextConfig } from "next";
const nextConfig: NextConfig = { output: "standalone", cacheComponents: true };
export default nextConfig;
```

### 3.2 Dockerfile (based on the official `examples/with-docker`)
```dockerfile
ARG NODE_VERSION=24.13.0-slim
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

FROM node:${NODE_VERSION} AS builder
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_CONVEX_URL
ENV NEXT_PUBLIC_CONVEX_URL=$NEXT_PUBLIC_CONVEX_URL
RUN pnpm build

FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /app/public ./public
RUN mkdir .next && chown node:node .next
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

### 3.3 shadcn/ui + Tailwind v4
```bash
pnpm dlx shadcn@latest init -t next          # new project; add "-b radix" to stay on Radix (Base UI is default since 07/2026)
pnpm dlx shadcn@latest add sidebar sheet drawer dialog table card form sonner
```
- **`components.json`:** `"style": "new-york"` and `"tailwind": { "config": "", "css": "app/globals.css", "baseColor": "neutral", "cssVariables": true }`.
- **PostCSS:** `export default { plugins: { "@tailwindcss/postcss": {} } }`.
- **`globals.css`:**
  - `@import "tailwindcss"; @import "tw-animate-css";` (replaces tailwindcss-animate)
  - `@custom-variant dark (&:is(.dark *));`
  - OKLCH variables in `:root` and `.dark`, plus `@theme inline { … }`
- **v4 component changes:** `data-slot` on every primitive, no `forwardRef`, toast replaced by `sonner`. Drawer now uses Base UI instead of Vaul.

### 3.4 Mobile-responsive patterns
- **Sidebar:** below 768px it renders inside a **Sheet**.
  - `useSidebar()` returns `{ isMobile, openMobile, setOpenMobile, toggleSidebar }`.
  - Props: `collapsible="offcanvas|icon|none"` and `variant="inset"` (with `<SidebarInset>`).
- **`useIsMobile()`** (`hooks/use-mobile.ts`, 768px breakpoint) returns `false` during SSR. **Prefer CSS breakpoints** for layout to avoid a flash.
- **Responsive dialog:** `isMobile ? <Drawer/> : <Dialog/>`.
- **Tables become cards:** `<div className="hidden md:block"><Table/></div><div className="md:hidden space-y-2">{cards}</div>`.
- **Container queries** are built into Tailwind v4: `@container` with `@md:grid-cols-2`. Use them inside `SidebarInset`, where the viewport width doesn't reflect the space available.
- **Sticky action bar** on mobile for invoice-editor actions; use `inputMode="decimal"` on amount fields.

---

## 4. MCP server inside Next.js

### 4.1 Spec status
- **Current spec: 2026-07-28.** Changes:
  - No `Mcp-Session-Id` and no `initialize` handshake. Each request carries the protocol version and client capabilities in `_meta`.
  - New mandatory `server/discover`. `subscriptions/listen` replaces the GET stream.
  - Required `Mcp-Method`/`Mcp-Name` headers.
  - Roots, Sampling and Logging are deprecated. DCR is deprecated in favour of **CIMD** (Client ID Metadata Documents).
- **`mcp-handler` 2.3.0** speaks 2026-07-28 natively and falls back to stateless handling for 2025-era clients.
  - Requires `@modelcontextprotocol/server@^2`, `zod@^4.2` and Node 20+.
  - **Removed:** `basePath`, `redisUrl`, `maxDuration`, SSE and the `[transport]` path segment.
- **SDK v1** (`@modelcontextprotocol/sdk` 1.32.1) is still maintained. Use it only with `mcp-handler@1.x`.

### 4.2 Implementation (recommended: `mcp-handler`)
```bash
pnpm add mcp-handler@^2 @modelcontextprotocol/server@^2 zod@^4
```
```ts
// app/api/mcp/route.ts
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";

const handler = createMcpHandler((server) => {
  server.registerTool("invoice_search", {
    title: "Rechnungen suchen",
    description: "Search invoices by status/customer/date. Max `limit` items; pass `cursor` for the next page.",
    inputSchema: z.object({
      status: z.enum(["draft", "open", "paid", "overdue"]).optional(),
      customer_id: z.string().optional(),
      limit: z.number().int().max(50).default(20),
      cursor: z.string().optional(),
    }),
    outputSchema: z.object({
      items: z.array(z.object({ id: z.string(), number: z.string(), customer: z.string(), total_gross: z.number() })),
      nextCursor: z.string().nullable(),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args, ctx) => {
    const orgId = ctx.http?.authInfo?.extra?.orgId;          // v2 (v1: extra.authInfo)
    const data = await fetchQuery(api.invoices.search, { ...args }); // from "convex/nextjs"
    return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
  });
}, { serverInfo: { name: "rechnungen", version: "1.0.0" } });

const verifyToken = async (_req: Request, bearer?: string): Promise<AuthInfo | undefined> => {
  if (!bearer) return undefined;
  const key = await lookupApiKeyByHash(sha256Hex(bearer));   // same store as REST API keys (section 5)
  if (!key || key.revokedAt) return undefined;
  return { token: bearer, clientId: key.id, scopes: key.scopes, extra: { orgId: key.orgId } };
};

const authed = withMcpAuth(handler, verifyToken, { required: true, requiredScopes: ["invoices:read"] });
export { authed as GET, authed as POST };
```
- **v2 API changes:** `inputSchema` takes a full `z.object()`, and `server.tool()` is replaced by `registerTool`.
- **401/403 responses** from `withMcpAuth` include RFC 9728 `WWW-Authenticate` headers.
- **OAuth later:** add `app/.well-known/oauth-protected-resource/route.ts` using `protectedResourceHandler({ authServerUrls })`.

**Alternative: raw SDK v2, web-standard and stateless:**
```ts
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
const mcp = createMcpHandler(() => { const s = new McpServer({ name: "rechnungen", version: "1.0.0" }); /* registerTool */ return s; },
  { responseMode: "json" });
export async function POST(req: Request) {
  const authInfo = await verify(req.headers.get("authorization")?.replace(/^Bearer /, ""));
  if (!authInfo) return new Response("Unauthorized", { status: 401 });
  return mcp.fetch(req, { authInfo });
}
```
- **Host/Origin validation** isn't done for you. Add `hostHeaderValidationResponse` / `originValidationResponse` in front of the handler.

### 4.3 Connecting clients
**Claude Code** (verified at code.claude.com/docs/en/mcp):
```bash
claude mcp add --transport http rechnungen https://rechnung.example.de/api/mcp \
  --header "Authorization: Bearer sk_live_xxx"      # -t / -H ; --scope local|project|user
```
```json
// .mcp.json (project-shared)
{ "mcpServers": { "rechnungen": { "type": "http", "url": "https://rechnung.example.de/api/mcp",
  "headers": { "Authorization": "Bearer ${RECHNUNG_API_KEY}" } } } }
```
- **Variable names:** don't use Anthropic credential variables in headers; they read as empty.
- **No OAuth fallback:** a rejected header does not fall back to OAuth.
- **Rotating tokens:** `headersHelper` runs a script that prints headers as JSON.

**claude.ai, Claude Desktop and mobile custom connectors:**
- **OAuth is not required.** Supported auth types: `none` (authless), `oauth_dcr`, `oauth_cimd` and `static_headers`.
- **Static headers are in beta for a limited set of organizations.**
  - Setup: choose "No sign-in", then add the key under Request headers.
  - Allowed names: `authorization`, `x-api-key`, `x-auth-token`.
  - Enter the value including `Bearer `.
  - On Team/Enterprise plans the key is shared across the organization.
- **Connections come from Anthropic's cloud (`160.79.104.0/21`)**, not from your device. The server must be public, or your IP allowlist must include that range. This matters if you protect the app with an IP allowlist.
- **Claude Desktop ignores remote servers in `claude_desktop_config.json`.** Use Settings → Connectors, or a stdio bridge:
  ```json
  { "mcpServers": { "rechnungen": { "command": "npx",
    "args": ["mcp-remote", "https://rechnung.example.de/api/mcp", "--header", "Authorization:${AUTH_HEADER}"],
    "env": { "AUTH_HEADER": "Bearer sk_live_xxx" } } } }
  ```
- **OAuth callback for claude.ai:** `https://claude.ai/api/mcp/auth_callback`.
- **If static headers aren't available to you:** implement OAuth (CIMD/DCR) or use mcp-remote.

### 4.4 Tool design best practices
From Anthropic's "Writing effective tools for agents" and the MCP spec:
- **Few, workflow-level tools** rather than one per endpoint, e.g. `invoice_create_from_customer`, `invoice_finalize`, `invoice_send`, `invoice_search`, `customer_upsert`, `payment_match`, `report_ustva_values`.
- **Names:** prefix them (`invoice_*`, `customer_*`). Allowed characters `[A-Za-z0-9_.-]`, 1–128 chars.
- **Parameters:** unambiguous names (`customer_id`) and strict zod schemas.
- **Responses:** human-readable fields (invoice number, customer name), a `response_format: "concise"|"detailed"` option, pagination with `limit`/`cursor`, and filters.
- **Errors:** return `isError: true` with an actionable message that shows correct input.
- **Annotations:**
  - `readOnlyHint: true` on reads.
  - `destructiveHint: true` on cancel or storno.
  - `idempotentHint` where it applies.
  - For legally binding actions (finalise under GoBD, send), add `_meta["anthropic/requiresUserInteraction"]: true` so Claude Code asks for approval on every call.
- **Output:** `outputSchema` plus `structuredContent`, and **also** a JSON text block for older clients.
- **Claude Code limits:**
  - Warns above 10k tokens and truncates at 25k (`MAX_MCP_OUTPUT_TOKENS`).
  - Text over 50k characters is saved to a file; raise this per tool with `_meta["anthropic/maxResultSizeChars"]` (max 500k).
  - Descriptions are truncated at 2,048 characters.
- **Statelessness:** the spec is stateless, so return explicit IDs and handles rather than relying on session state.

---

## 5. Public REST API with API keys

### 5.1 Key design
- **Format:** `sk_live_<base62(randomBytes(32))>`, plus `sk_test_` for test keys. Show the full key **once**.
- **Storage:**
  - `hash = sha256(key)` as hex, with a unique index.
  - `prefix` (e.g. `sk_live_AbC1`) and `last4` for display.
  - `scopes[]`, `orgId`, `createdBy`, `lastUsedAt`, `expiresAt`, `revokedAt`.
- **Hashing:** fast SHA-256 is fine for high-entropy keys; bcrypt/argon2 isn't needed. Look up by hash with an indexed equality query. When comparing stored values, use `crypto.timingSafeEqual`.
- **Where to hash:** in a Convex default-runtime function, use `crypto.subtle.digest("SHA-256", …)`; `node:crypto` there needs `"use node"`. In a Next.js route handler, `node:crypto` works.
- **Scopes:** `invoices:read|write`, `customers:read|write`, `webhooks:manage`. Check them per route **and** per MCP tool, using one key store for both.
- **Accepted headers:** `Authorization: Bearer …` (optionally `X-API-Key`). **Never accept keys in query strings.**
- **Hygiene:** update `lastUsedAt` asynchronously, keep an audit log with the key ID, and allow two active keys for rotation.
```ts
// lib/api-auth.ts (route handler helper)
import { createHash, randomBytes } from "node:crypto";
export const newKey = () => {
  const raw = "sk_live_" + randomBytes(32).toString("base64url");
  return { raw, hash: createHash("sha256").update(raw).digest("hex"), prefix: raw.slice(0, 12), last4: raw.slice(-4) };
};
export async function requireKey(req: Request, scope: string) {
  const token = req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw new Response("Unauthorized", { status: 401 });
  const key = await fetchQuery(api.apiKeys.byHash, { hash: createHash("sha256").update(token).digest("hex"), secret: process.env.INTERNAL_SECRET! });
  if (!key || key.revokedAt || !key.scopes.includes(scope)) throw new Response("Forbidden", { status: 403 });
  return key;
}
```

### 5.2 Rate limiting (self-hosted)
| Option | Package | Notes |
|---|---|---|
| In-memory | `rate-limiter-flexible@11.2.1` (`RateLimiterMemory`) | Fine for a single container. `await limiter.consume(keyId)`. On rejection it returns `msBeforeNext`, which maps to `Retry-After`/`RateLimit-*` headers. |
| Redis | same package, `RateLimiterRedis` + `ioredis` | For several replicas. |
| Convex | `@convex-dev/rate-limiter@0.4.2` (peer `convex ^1.43`) | `app.use(rateLimiter)` in `convex/convex.config.ts`, then `new RateLimiter(components.rateLimiter, { api: { kind: "token bucket", rate: 100, period: MINUTE, capacity: 20 } })` and `await rl.limit(ctx, "api", { key })` → `{ ok, retryAfter }`. Transactional. **[UNCERTAIN]** on self-hosted; test it. |

### 5.3 OpenAPI with zod v4
- **Built into zod:** `z.toJSONSchema(schema, { target: "openapi-3.0" | "draft-2020-12", io: "input"|"output", reused: "ref" })`. Schemas with `.meta({ id })` are extracted into `$defs`.
- **`zod-openapi` 6.0.2** (peer zod ^4, **Node ≥22.14**). Uses native `.meta()` with no monkey-patching:
  ```ts
  import { createDocument } from "zod-openapi";
  const doc = createDocument({ openapi: "3.1.0", info: { title: "Rechnungs-API", version: "1.0.0" },
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } }, security: [{ bearer: [] }],
    paths: { "/v1/invoices/{id}": { get: { requestParams: { path: z.object({ id: z.string() }) },
      responses: { "200": { description: "OK", content: { "application/json": { schema: Invoice } } } } } } } });
  ```
- **Alternatives:**
  - `@asteasolutions/zod-to-openapi` 9.1.0: registry style, OpenAPI 3.0/3.1/3.2.
  - `@hono/zod-openapi` 1.6.3: mount at `app/api/[[...route]]/route.ts` with `handle(app)` from `hono/vercel`; routes double as the spec.
- **Serving docs:**
  ```ts
  // app/api/openapi.json/route.ts -> Response.json(doc)
  // app/docs/route.ts
  import { ApiReference } from "@scalar/nextjs-api-reference";
  export const GET = ApiReference({ url: "/api/openapi.json" });
  ```

### 5.4 Webhooks (Standard Webhooks spec, `standardwebhooks@1.1.1`)
- **Headers:** `webhook-id` (stable across retries; receivers use it as an idempotency key), `webhook-timestamp` (Unix seconds), `webhook-signature: v1,<base64 HMAC-SHA256>`. Space-separated signatures allow secret rotation.
- **Signed content:** `${id}.${timestamp}.${rawBody}`.
- **Secret:** `whsec_` + base64 of 24–64 random bytes.
- **Payload:** `{ type: "invoice.paid", timestamp, data }`.
```ts
import { Webhook } from "standardwebhooks";
const wh = new Webhook(endpoint.secret);
const id = `msg_${ulid()}`, ts = new Date(), body = JSON.stringify(event);
await fetch(endpoint.url, { method: "POST", body, redirect: "manual", signal: AbortSignal.timeout(15_000), headers: {
  "content-type": "application/json", "webhook-id": id,
  "webhook-timestamp": String(Math.floor(ts.getTime() / 1000)), "webhook-signature": wh.sign(id, ts, body) } });
// receiver: new Webhook(secret).verify(rawBody, headers)  (5-min tolerance, constant-time)
```
- **Delivery rules:**
  - Only 2xx counts as success; 3xx is a failure (don't follow redirects).
  - Honour `Retry-After`. On **410**, disable the endpoint.
  - Backoff with jitter: immediately, then 5s, 5m, 30m, 2h, 5h, 10h, 14h, 20h, 24h.
- **In Convex:** an outbox table plus an action that reschedules itself with `ctx.scheduler.runAfter(delay, internal.webhooks.deliver, { attemptId })`. Log every attempt.

---

## 6. PDF + E-Rechnung in TypeScript/Node

### 6.1 Legal context (brief)
- **Receiving:** every domestic B2B business must be able to receive e-invoices **since 1.1.2025**.
- **Issuing:**
  - **From 1.1.2027:** mandatory if prior-year turnover is above **€800k**.
  - **From 1.1.2028:** mandatory for everyone.
  - Detailed rules are in the BMF letters of 15.10.2024 and 15.10.2025.
- **Exempt:** small-amount invoices up to €250, travel tickets, and issuing by Kleinunternehmer (they must still be able to receive).
- **Valid formats:** **XRechnung** (UBL or CII), or **ZUGFeRD/Factur-X** with profile **EN16931, EXTENDED or XRECHNUNG**. BASIC is reportedly accepted [UNCERTAIN wording]. **MINIMUM and BASIC-WL are not valid e-invoices.** In a hybrid PDF, the XML is the leading part.
- **Current versions:**

| Standard | Version | Notes |
|---|---|---|
| XRechnung | **3.0.2** | Valid at least until 31.07.2027. XRechnung **4.0** pre-release came out 2026-09-15 (EN 16931-1:2026); the production bundle is expected spring 2027. |
| ZUGFeRD / Factur-X | **ZUGFeRD 2.5.2 = Factur-X 1.09.2** | Applies from 1.9.2026. Backward compatible. Updated about twice a year for code lists. |
| CEN Schematron | 1.3.16 | |

### 6.2 PDF generation
| Option | Version | Notes |
|---|---|---|
| **`@react-pdf/renderer`** | 4.9.0 | React 19 OK. **New: `<Document conformance="PDF/A-3b">`** writes XMP `pdfaid` and an sRGB OutputIntent. **Fonts must be registered** with `Font.register` (TTF or WOFF, no WOFF2, no variable fonts); the standard 14 fonts fail PDF/A. German hyphenation: `@react-pdf/hyphenate`. No attachment API, so add the XML afterwards. |
| Playwright/Puppeteer HTML→PDF | 1.64.0 / 25.13.0 | Install just the shell with `npx playwright install --with-deps --only-shell chromium`. Output is **not PDF/A**, so it needs post-processing. |
| **Gotenberg** | 8.37.0 (`gotenberg/gotenberg:8`, ~700 MB) | Chromium + LibreOffice over HTTP. `pdfa=PDF/A-3b`, `embeds`, and a **dedicated Factur-X route**. |
| `pdfmake` | 0.3.11 | `{ version:'1.7', subset:'PDF/A-3b', tagged:true }` |
| `pdf-lib` | 1.17.1 | **Unmaintained since 2021.** |
| **`@cantoo/pdf-lib`** | 2.11.1 | Maintained fork with the same API. Adds `convertToPDFA()`, **`embedFacturX()`** and `getAttachments()`. |

### 6.3 PDF/A-3 + embedded ZUGFeRD/Factur-X in JS
- **What a valid hybrid PDF needs:**
  - all fonts embedded
  - an sRGB OutputIntent ICC profile
  - XMP with `pdfaid:part=3`/`conformance=B` and the Factur-X `fx:` extension schema
  - an attachment named `factur-x.xml` (`xrechnung.xml` for the XRECHNUNG profile) with `/AFRelationship /Alternative` and a catalog `/AF` array
  - no encryption and no JavaScript
- **Validate every output** with veraPDF and Mustang.

| Library | Version | License | XML generation | PDF/A-3 embed | Verdict |
|---|---|---|---|---|---|
| **`@cantoo/pdf-lib`** | 2.11.1 | MIT | – | ✓ `embedFacturX(doc, xml, { conformanceLevel: 'EN 16931' })` (levels MINIMUM to XRECHNUNG) | **Best "bring your own XML" option** |
| **`@e-invoice-eu/core`** | 3.4.0 | WTFPL | ✓ UBL, CII, XRECHNUNG-UBL/CII, Factur-X/ZUGFeRD (all profiles) from a JSON (BT-based) model | ✓ via cantoo; LibreOffice only for spreadsheet input | Mature. README calls PDF/A "not battle-tested". Also has a CLI, a REST server, and Docker `gflohr/e-invoice-eu` (`:slim`). |
| `@stackforge-eu/factur-x` | 1.4.3 | **EUPL-1.2** (copyleft) | ✓ CII (Factur-X 1.09), standalone XRechnung CII | ✓ | XSD validation via libxml2-wasm |
| `node-zugferd` | 0.1.1-beta.1 (2025-08) | MIT | ✓ CII, **no XRECHNUNG profile** | ✓ | WIP and stale. Avoid. |
| `factur-x-kit`, `@stafyniaksacha/facturx`, `@fin.cx/einvoice` | 2026 | MIT | partial | ✓ | Small user bases |
| `zugferd-js`, `einvoice`, `@fiscalbase/*` | – | – | – | – | **Don't exist.** `factur-x`/`zugferd`/`xrechnung` on npm are empty placeholders. |

**Recommended pipeline:**
```ts
import { renderToBuffer } from "@react-pdf/renderer";
import { PDFDocument, embedFacturX } from "@cantoo/pdf-lib";
const pdf = await renderToBuffer(<InvoiceDoc conformance="PDF/A-3b" />);   // registered TTF fonts only
const doc = await PDFDocument.load(pdf);
doc.setTitle(`Rechnung ${nr}`); doc.setAuthor(seller.name);
await embedFacturX(doc, new TextEncoder().encode(ciiXml), { conformanceLevel: "EN 16931" });
const hybrid = await doc.save();   // -> validate with Mustang/veraPDF + KoSIT (XML) before storing/sending
```
- **[UNCERTAIN]** I haven't tested `embedFacturX` on a PDF that react-pdf already made PDF/A; the README says it keeps the existing level.

**Gotenberg alternative (no JS PDF/A code):**
```bash
curl -X POST http://gotenberg:3000/forms/pdfengines/factur-x --form files=@invoice.pdf \
  --form facturxXml=@factur-x.xml --form 'facturxConformanceLevel=EN 16931' -o invoice-zugferd.pdf
```
- It doesn't validate the XML and always names the attachment `factur-x.xml`.

### 6.4 Mustang (Java) as a sidecar
- **Version:** core-2.26.0, Apache-2.0. Jar: `github.com/ZUGFeRD/mustangproject/releases/download/core-2.26.0/Mustang-CLI-2.26.0.jar`.
- **CLI actions** (`java -Xmx1G -Dfile.encoding=UTF-8 -jar Mustang-CLI-2.26.0.jar --action <x>`): `combine`, `extract`, `validate` (XML + PDF/A via veraPDF), `visualize`, `pdf` (XML → PDF/A-3), `a3only`, `ubl` (CII → UBL), `upgrade`.
```bash
java -jar Mustang-CLI-2.26.0.jar --action combine --source in.pdf --source-xml factur-x.xml --out out.pdf \
  --format zf --version 2 --profile E --no-additional-attachments
java -jar Mustang-CLI-2.26.0.jar --no-notices --action validate --source out.pdf   # exit 0 = valid; XML report on stdout
```
- **No official Docker image.** "Mustangserver" is proprietary.
- **Community options:**
  - **`gflohr/e-invoice-eu-validator`** (WTFPL): a Java HTTP server around Mustang, `POST /validate` with multipart field `invoice`, returns 200 or 400 with an XML report.
  - `docentric/e-invoice-validator`.
- **Recommendation:** build your own image, `FROM eclipse-temurin:17-jre` plus the jar, and keep the JVM warm. The CLI pays JVM startup cost on every call.

### 6.5 Generating XRechnung / CII XML in TS
- **Approach:** a typed domain model plus `xmlbuilder2` (4.0.3) or tagged templates, or map your model to `@e-invoice-eu/core` JSON. Store amounts as integer cents or `decimal.js`, format decimals deterministically, and compute totals per the BR-CO rules. Use the KoSIT testsuite as fixtures.
- **Identifiers:**
  - BT-24: `urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0`
  - BT-23: `urn:fdc:peppol.eu:2017:poacc:billing:01:1.0`
  - ZUGFeRD EN16931 guideline ID: `urn:cen.eu:en16931:2017`
- **German extra rules (BR-DE):**
  - payment instructions BG-16
  - seller contact BG-6: name, phone (at least 3 digits), email
  - seller and buyer city and post code
  - **BT-10 Buyer reference mandatory** (BR-DE-15)
  - seller VAT ID BT-31 or tax number BT-32
  - Skonto syntax `#SKONTO#TAGE=14#PROZENT=2.00#` in BT-20
  - IBAN check (code 58)
  - **seller and buyer electronic addresses BT-34/BT-49 mandatory** (email scheme `EM`, or `0204` with a Leitweg-ID)
- **Leitweg-ID (BT-10)** for public-sector buyers: `Grob(2–12 digits)-Fein(≤30 alphanumeric, optional)-Prüfziffer(2 digits, ISO 7064 Mod 97-10)`, e.g. `04011000-1234512345-06`. For B2B, put the buyer's order or reference number in BT-10.

### 6.6 Validation
- **KoSIT validator v1.6.3** (Java 11+). Jar on Maven Central: `https://repo1.maven.org/maven2/org/kosit/validator/1.6.3/validator-1.6.3-standalone.jar`.
- **Configuration:** `https://github.com/itplr-kosit/validator-configuration-xrechnung/releases/download/v2026-08-31/xrechnung-3.0.2-validator-configuration-2026-08-31.zip`. It covers XRechnung and plain EN16931 UBL/CII.
```bash
# CLI: exit 0 = all acceptable, n>0 = n rejected
java -jar validator-1.6.3-standalone.jar -s scenarios.xml -r $PWD -h invoice.xml
# Daemon (HTTP):
java -jar validator-1.6.3-standalone.jar -s scenarios.xml -r /cfg -D -H 0.0.0.0 -P 8080 --disable-gui
curl -X POST http://kosit:8080 -H 'Content-Type: application/xml' --data-binary @invoice.xml
# 200 acceptable | 406 not acceptable | 422 error; body = XML report; health: GET /server/health
```
- **XML only.** For a ZUGFeRD PDF, extract the XML first.
- **No official Docker image.** Community images:
  - `apps4everything/kosit-validator-xrechnung` (1.6.3 + 3.0.2, updated 2026-08-31)
  - `exsemt/xrechnung-kosit-validator` (amd64 and arm64)
  - `flx235/xr-validator-service`
  - `easybill/kosit-validator-xrechnung_3.0.2`

  Better: **build your own tiny Temurin image** so you control the configuration version.
- **PDF/A:** veraPDF 1.30.3 (`verapdf/cli:v1.30.3`, `verapdf/rest`).
- **Manual portal:** https://erechnungsvalidator.service-bw.de/

### 6.7 Parsing incoming e-invoices
- **Detecting the format:**
  - root `Invoice`/`CreditNote` in the UBL namespace means UBL
  - `rsm:CrossIndustryInvoice` means CII
  - a PDF means looking for the attachment `factur-x.xml`, `zugferd-invoice.xml`, `ZUGFeRD-invoice.xml` or `xrechnung.xml`
- **Extracting the attachment:**
  ```ts
  import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";   // pdfjs-dist 6.4.299, Node >= 22.13
  const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
  const atts = await doc.getAttachments();
  const xml = Object.values(atts ?? {}).find((a: any) => /^(factur-x|zugferd-invoice|xrechnung)\.xml$/i.test(a.filename));
  ```
  Or use `@cantoo/pdf-lib`'s `doc.getAttachments()`.
- **Parsing:** `fast-xml-parser` 5.11.2 with `new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, isArray: n => LIST_TAGS.has(n) })`. Keeping values as strings preserves amounts and IDs.
- **Visualization:** KoSIT `xrechnung-visualization` v2026-08-31 provides UBL/CII → XR → HTML via XSLT. Run it with Saxon-JS (`xslt3` 2.7.0, proprietary freeware; compile with `npx xslt3 -xsl:… -export:….sef.json -nogo`) **[UNCERTAIN that the XSLTs compile under Saxon-JS]**, or with Mustang `--action visualize`, or render your own React view from the parsed model.

---

## 7. Testing for TDD

### 7.1 Versions and the main caveat
- **Versions:**
  - `vitest` **5.0.4** (Node ^22.12/^24; `vite` is now a peer dependency)
  - `@vitest/browser-playwright` 5.0.4
  - `convex-test` 0.0.61 plus `@edge-runtime/vm` 5.0.0
  - `@testing-library/react` 16.3.3 (also install `@testing-library/dom ^10`), `@testing-library/user-event` 14.6.7, `@testing-library/jest-dom` 7.0.1
  - `@playwright/test` 1.64.0
  - `msw` 3.0.3 (ESM only, Node ≥22)
- **Main caveat:** the Convex docs only cover Vitest 4. **Pin `vitest@^4.1` (4.1.11)** until convex-test is confirmed on Vitest 5 [UNCERTAIN].
- **Vitest 5 breaking changes:**
  - `clearMocks` defaults to true.
  - Inline projects inherit the root config.
  - A forgotten `await` on an async assertion now fails the test.
  - `test.sequential` is removed.
  - Reports go under `.vitest/`.
  - Fake timers also mock `Temporal`.

### 7.2 Vitest config
```ts
// vitest.config.mts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    projects: [
      { extends: true, test: { name: "convex", include: ["convex/**/*.test.ts"], environment: "edge-runtime",
          server: { deps: { inline: ["convex-test"] } } } },
      { extends: true, test: { name: "unit", include: ["src/**/*.test.{ts,tsx}", "lib/**/*.test.ts"],
          environment: "jsdom", setupFiles: ["./vitest.setup.ts"] } },
      // optional browser mode: browser: { enabled: true, provider: playwright(), instances: [{ browser: "chromium" }] }
    ],
  },
});
```
- **Async Server Components** can't be unit-tested with RTL; cover them in E2E.

### 7.3 convex-test
```ts
// convex/test.setup.ts
/// <reference types="vite/client" />
export const modules = import.meta.glob("./**/!(*.*.*)*.*s");

// convex/invoices.test.ts
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

test("finalize assigns gapless number", async () => {
  const t = convexTest(schema, modules);
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { name: "ACME GmbH" }));
  const id = await t.mutation(api.invoices.create, { customerId });
  await t.mutation(api.invoices.finalize, { id });
  expect((await t.query(api.invoices.get, { id }))?.number).toMatch(/^RE-2026-\d+$/);
});

test("dunning schedule", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  await t.mutation(api.dunning.schedule, { delayMs: 10_000 });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useRealTimers();
});
```
- **Other APIs:** `t.withIdentity({...})` (chainable), `t.fetch("/webhook", {...})` for HTTP actions, `t.withRequestMetadata`, `defineTestApp` for components (0.0.61).
- **Limitations:**
  - Cron jobs don't run; call their target functions directly.
  - Size and time limits aren't enforced, and IDs and error messages differ from the real backend.
  - Queries and mutations throw if they call `fetch` or timers.

### 7.4 Playwright E2E
```ts
// playwright.config.ts
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "e2e", fullyParallel: false, retries: process.env.CI ? 2 : 0,
  use: { baseURL: "http://localhost:3000", trace: "on-first-retry" },
  expect: { toHaveScreenshot: { maxDiffPixels: 100, animations: "disabled" } },
  globalSetup: "./e2e/global-setup.ts",          // npx convex deploy + seed / clearAll
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "iphone", use: { ...devices["iPhone 15"] } },
    { name: "pixel", use: { ...devices["Pixel 7"] } },
  ],
  webServer: { command: "pnpm build && pnpm start", url: "http://localhost:3000", reuseExistingServer: !process.env.CI,
    timeout: 180_000, env: { NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3210" } },
});
```
- **Visual regression:**
  - Assert with `await expect(page).toHaveScreenshot("invoice-list.png", { stylePath: "e2e/hide-volatile.css" })`.
  - Update baselines with `--update-snapshots`.
  - Generate and compare baselines in the same image: `docker run --rm --ipc=host -v $PWD:/work -w /work mcr.microsoft.com/playwright:v1.64.0-noble npx playwright test --update-snapshots`.
- **Convex backend for E2E:** use the self-hosted Docker image (recommended; matches production). The anonymous `npx convex dev` backend only stays up while the CLI runs.
- **Resetting data:** a `clearAll` mutation guarded by `IS_TEST` (`npx convex env set IS_TEST true`, `customMutation` from convex-helpers). It deletes all tables, cancels `_scheduled_functions` and removes `_storage` files. Gate crons on `IS_TEST` too.

### 7.5 MSW 3
```ts
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw/http";      // v3: no longer from "msw" root
export const server = setupServer(
  http.post("https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number",
    () => HttpResponse.json({ valid: true, name: "ACME", requestIdentifier: "WAPI..." })));
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));   // renamed from onUnhandledRequest
afterEach(() => server.resetHandlers()); afterAll(() => server.close());
```
- **Moved utilities:** `delay`, `bypass` and `passthrough` are now under `msw/utils/*`.
- **Fake timers:** MSW no longer patches `setTimeout`.
- **Note:** MSW does **not** intercept Convex actions running inside the Convex backend. Mock at the action boundary or use test env vars.

### 7.6 GitHub Actions
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
      - run: pnpm vitest run          # commit convex/_generated so no deployment is needed for codegen
  e2e:
    runs-on: ubuntu-latest
    services:
      convex:
        image: ghcr.io/get-convex/convex-backend:<PINNED_SHA>
        env: { INSTANCE_SECRET: ${{ secrets.CI_CONVEX_INSTANCE_SECRET }} }
        ports: ["3210:3210", "3211:3211"]
        options: --health-cmd "curl -f http://localhost:3210/version" --health-interval 5s --health-retries 20
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - uses: actions/cache@v4
        with: { path: ~/.cache/ms-playwright, key: pw-${{ hashFiles('pnpm-lock.yaml') }} }
      - run: pnpm exec playwright install --with-deps
      - name: Deploy Convex functions
        run: |
          KEY=$(docker exec ${{ job.services.convex.id }} ./generate_admin_key.sh | tail -n1)
          echo "CONVEX_SELF_HOSTED_ADMIN_KEY=$KEY" >> $GITHUB_ENV
          export CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 CONVEX_SELF_HOSTED_ADMIN_KEY=$KEY
          npx convex env set IS_TEST true && npx convex deploy
      - run: pnpm exec playwright test
        env: { CONVEX_SELF_HOSTED_URL: http://127.0.0.1:3210 }
      - uses: actions/upload-artifact@v4
        if: ${{ !cancelled() }}
        with: { name: playwright-report, path: playwright-report/ }
```
- **[UNCERTAIN]** whether `curl` exists in the image, and the `tail -n1` key parsing.
- **Screenshot jobs:** run them in `container: mcr.microsoft.com/playwright:v1.64.0-noble`.
- **Additional CI job:** validate generated XRechnung and ZUGFeRD fixtures with KoSIT and Mustang containers.

---

## 8. Other libraries

### 8.1 EPC / GiroCode QR (EPC069-12 v3.0)
- **Lines, separated by LF:**
  1. `BCD`
  2. `002` (BIC optional in the EEA)
  3. charset `1` (UTF-8)
  4. `SCT`
  5. BIC
  6. name (≤70)
  7. IBAN
  8. `EUR12.34` (optional)
  9. purpose (4 chars)
  10. RF reference (≤35), **or**
  11. text (≤140)
  12. info (≤70)
- **Limits:** at most 331 bytes, error correction level M.
- **Packages:** `sepa-payment-qr-code` 2.0.2 (payload only), `qrcode` 1.5.4 (rendering). Building the payload yourself is simple:
```ts
import QRCode from "qrcode";
import { electronicFormatIBAN, isValidIBAN } from "ibantools";
export function epcPayload(p: { name: string; iban: string; bic?: string; amountCents?: number; text?: string }) {
  const iban = electronicFormatIBAN(p.iban)!;
  if (!isValidIBAN(iban)) throw new Error("invalid IBAN");
  const lines = ["BCD", "002", "1", "SCT", p.bic ?? "", p.name.slice(0, 70), iban,
    p.amountCents != null ? `EUR${(p.amountCents / 100).toFixed(2)}` : "", "", "", (p.text ?? "").slice(0, 140)];
  while (lines.length > 8 && lines.at(-1) === "") lines.pop();
  const s = lines.join("\n");
  if (new TextEncoder().encode(s).length > 331) throw new Error("payload too long");
  return s;
}
export const epcSvg = (s: string) => QRCode.toString(s, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
```

### 8.2 IBAN validation and BIC lookup
- **`ibantools` 4.5.4:** `electronicFormatIBAN`, `isValidIBAN`, `validateIBAN` (returns error codes), `isValidBIC`, `friendlyFormatIBAN`. A German BLZ is `iban.slice(4, 12)`.
- **BIC lookup:** use the Bundesbank Bankleitzahlendatei (CSV/TXT/XML, updated quarterly; next file 07.12.2026).
  - Use only rows with Merkmal=`1`.
  - Import it into a Convex table each quarter.

### 8.3 VAT-ID checks
- **VIES REST** at `https://ec.europa.eu/taxation_customs/vies/rest-api`:
  - `POST /check-vat-number` with `{ countryCode, vatNumber, requesterMemberStateCode, requesterNumber, trader* }`.
  - Response: `{ valid, name, address, requestIdentifier, trader*Match }`. You get `requestIdentifier` (proof of the check) only when you send the requester fields.
  - `GET /ms/{cc}/vat/{num}` works but isn't in the swagger.
  - Also `GET /check-status` and `POST /check-vat-test-service`.
  - Germany returns no name or address [from experience].
- **BZSt eVatR (German qualified confirmation):** the **XML-RPC interface was shut down on 30.11.2025**.
  - REST: `POST https://api.evatr.vies.bzst.de/app/v1/abfrage` with `{ anfragendeUstid, angefragteUstid, firmenname?, strasse?, plz?, ort? }`.
  - Response: `{ id, status: "evatr-0000", ergFirmenname: A|B|C|D, … }`.
  - No auth. Only foreign VAT IDs can be checked. Store `id` and the full response as proof.
  - Docs: `https://api.evatr.vies.bzst.de/api-docs`. npm wrapper: `evatr-api` [version not checked].

### 8.4 Bank sync
- **FinTS:** **`lib-fints` 1.5.2** (LGPL-2.1, maintained, releases through Sep 2026).
  - Supports PIN/TAN and decoupled TAN (poll until done).
  - Fetches statements (MT940, plus CAMT with a built-in parser), balances and credit-card statements. **No transfers yet.**
  - ```ts
    const client = new FinTSClient(FinTSConfig.forFirstTimeUse(productId, productVersion, bankUrl, blz, userId, pin));
    await client.synchronize();
    let r = await client.getAccountStatements(account);
    if (r.requiresTan) r = await client.getAccountStatementsWithTan(r.tanReference!, tan);
    ```
  - `fints` (Prior99, 2020) is dead. Python sidecar alternative: `python-fints` 5.0.1.
- **FinTS product registration is required:**
  - Free, via registrierung@hbci-zka.de (fints.org/de/hersteller/produktregistrierung).
  - The number takes about 2–3 weeks; banks can take weeks more to whitelist it.
  - For OSS, either register it yourself or let each self-hoster enter their own product ID.
- **PSD2 aggregators:**
  - **GoCardless Bank Account Data:** new signups disabled since about July 2025; existing accounts still work.
  - **Enable Banking:** free "restricted production" mode for accounts you link yourself. Used by Actual and Firefly III; the best fit for single-tenant self-hosting [current limits UNCERTAIN].
  - **Tink, Yapily, Salt Edge, finAPI, TrueLayer:** contracts, KYB, sometimes eIDAS certificates. Not practical for self-hosters.
- **File import:**
  - `camt-parser` 2.1.0: CAMT.053 .001.02/.08/.13. Uses native `libxmljs2`, and its repository link is a placeholder, so use it with care.
  - Alternatively, parse CAMT yourself with `fast-xml-parser`.
  - `mt940js` 1.3.5 (2020): old but works. MT940 is being phased out in favour of CAMT.

### 8.5 Receipt OCR
- **Claude API** (`@anthropic-ai/sdk` 0.133.0).
- **Models:**

  | Model | ID | Price per MTok (input / output) |
  |---|---|---|
  | Claude Sonnet 5.5 | `claude-sonnet-5-5` | $2 / $10 |
  | Claude Haiku 5.5 | `claude-haiku-5-5` | from $0.10 / $0.50 |
  | Claude Opus 5.5 | `claude-opus-5-5` | $4 / $20 |
  | Claude Fable 5.1 | `claude-fable-5-1` | $10 / $50 |

- **PDF input:** a `document` block (base64, URL or Files API). Limits: 32 MB per request, 600 pages.
- **Structured outputs:** use `output_config.format` (json_schema), which is GA; the old `output_format` parameter is deprecated.
```ts
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
const res = await new Anthropic().messages.parse({
  model: "claude-sonnet-5-5", max_tokens: 2048,
  messages: [{ role: "user", content: [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfB64 } },
    { type: "text", text: "Extrahiere die Belegdaten." } ] }],
  output_config: { format: zodOutputFormat(ReceiptSchema) },
});
res.parsed_output;
```
- **Where it runs:** in a Convex `"use node"` action that reads the file from `ctx.storage`.
- **Local alternative:** `tesseract.js` 7.0.0 (`createWorker('deu')`), or PaddleOCR/docTR as a Python sidecar.

### 8.6 Email
- **`nodemailer` 10.1.0** (Node ≥20; v9 added stricter TLS checks). Attach both the PDF and the XML:
  ```ts
  attachments: [
    { filename: "RE-2026-001.pdf", content: pdfBuf, contentType: "application/pdf" },
    { filename: "xrechnung.xml", content: xml, contentType: "application/xml" },
  ]
  ```
- **`resend` 6.32.1:** `attachments: [{ filename, content: base64 }]`, max 40 MB, no attachments on batch sends.
- **SMTP via nodemailer** keeps the app self-hosted with no vendor dependency.
- **React Email 6** (`react-email` 6.11.1): import everything from `react-email`. **`@react-email/components` is deprecated.**

### 8.7 ELSTER / ERiC
- **ERiC** is a closed C library.
  - Register at elster.de/eportal/infoseite/entwickler; a Hersteller-ID is requested separately and can take weeks.
  - It **can't be redistributed** in a public repository.
- **Integration options:**
  - (1) Node FFI with `koffi` against `libericapi.so` (no existing project; effort unknown).
  - (2) A Python sidecar based on `pyeric`. `digitalservicebund/erica`, a REST wrapper, was archived in July 2025 but is MIT and usable as reference code.
  - `geierlein` (pure JS) is dead.
- **MVP recommendation:** skip ERiC.
  - Compute the UStVA values (Kz 81, 86, 66, 83, …) and display them for manual entry in "Mein ELSTER".
  - Add a **DATEV Buchungsstapel (EXTF) export** for the Steuerberater:
    - **Line 1 (header):** `"EXTF";700;21;"Buchungsstapel";13;<YYYYMMDDHHMMSSfff>;;"<Herkunft>";"<User>";;<Beraternr>;<Mandantennr>;<WJ-Beginn>;<Sachkontenlänge>;<von>;<bis>;"<Bezeichnung>";;1;0;"EUR"`. The header has more trailing fields; check developer.datev.de.
    - **Line 2:** column names (`Umsatz (ohne Soll/Haben-Kz);Soll/Haben-Kennzeichen;WKZ Umsatz;…;Konto;Gegenkonto (ohne BU-Schlüssel);BU-Schlüssel;Belegdatum;Belegfeld 1;…;Buchungstext`).
    - **Data rows:** e.g. `1234,56;S;;;;;8400;1000;3;0103;RE-2026-001;;;"Rechnung ACME"` (SKR03: 8400 = revenue 19%; BU-Schlüssel 3 = 19%, 2 = 7%; `Belegdatum` is TTMM).
    - Semicolon-separated, decimal comma. Encoding is traditionally Windows-1252 **[UNCERTAIN]**.

---

## 9. Suggested architecture

1. **Dokploy project "rechnungen"** with three services.
   - **Compose "convex":**
     - The official compose with `expose` instead of `ports`, pinned to one SHA for both images.
     - Postgres 17 (`POSTGRES_URL`, `DO_NOT_REQUIRE_SSL`) or SQLite for a single user.
     - Optionally S3 (Hetzner/MinIO) with all 5 buckets.
     - Domains: `convex-api.` → 3210, `convex-site.` → 3211, `convex-dash.` → 6791 (the dashboard behind `office-only@file` plus basic auth).
     - Set `INSTANCE_SECRET` explicitly and `REDACT_LOGS_TO_CLIENT=1`.
   - **Application "web":** Next.js 16.4 standalone Dockerfile.
     - `NEXT_PUBLIC_CONVEX_URL` as a build arg.
     - Domain `app.` protected with an IP allowlist middleware or Basic Auth via the Security tab.
     - Expose `/api/v1/*` and `/api/mcp` on a separate domain without basic auth, protected by API keys. If you restrict `/api/mcp` by IP, allowlist Anthropic's `160.79.104.0/21` for claude.ai connectors.
   - **Sidecar "einvoice-tools":** KoSIT daemon plus the e-invoice-eu-validator (Mustang), internal only. Optionally Gotenberg.
2. **Backups:**
   - Dokploy volume backup of the Convex data volume ("turn off container") to S3, or a Postgres compose backup.
   - Plus a nightly Schedule Job running `npx convex export --include-file-storage` and `npx convex env list --include-values`.
3. **Protect Convex itself:** keep business logic in `internal*` functions. Public Convex functions are reachable by anyone who knows the API URL.
4. **CI:**
   - Vitest 4.1 with convex-test for domain logic: numbering, VAT, totals, BR-DE rules.
   - XML snapshot tests checked against the KoSIT and Mustang containers.
   - Playwright on desktop, iPhone and Pixel against the Convex Docker service.
   - Deploy: `npx convex deploy`, then `curl application.deploy` on Dokploy.

### Main uncertainties to verify early
1. convex-test on Vitest 5.
2. `@convex-dev/rate-limiter` and other components on self-hosted Convex.
3. `embedFacturX` on react-pdf's PDF/A output; check with veraPDF and Mustang.
4. Whether claude.ai static-header connectors are enabled for your organization.
5. Saxon-JS compatibility with the KoSIT visualization XSLTs.
6. Enable Banking's current free-tier limits.
7. The full DATEV EXTF header field list.
8. The `:latest` Convex image digest; pin a SHA anyway.

### Key sources
- **Convex:** github.com/get-convex/convex-backend (`self-hosted/README.md`, `docker/docker-compose.yml`, `docker-build/*.sh`, `advanced/*.md`), docs.convex.dev (self-hosting, `/client/nextjs/app-router/server-rendering`, `/testing/convex-test`, `/cli/reference/export`), stack.convex.dev/testing-with-local-oss-backend
- **Dokploy:** github.com/Dokploy/templates/tree/main/blueprints/convex, github.com/Dokploy/cli (`src/generated/commands.ts`), docs.dokploy.com (`/docs/api`, `/docs/core/docker-compose`, `/docs/core/volume-backups`, `/docs/core/applications/build-type`)
- **Next.js / shadcn:** nextjs.org/blog/next-16-4, github.com/vercel/next.js/tree/canary/examples/with-docker, ui.shadcn.com/docs/tailwind-v4, ui.shadcn.com/docs/changelog/2026-07-base-ui-default
- **MCP:** github.com/vercel/mcp-handler, ts.sdk.modelcontextprotocol.io/v2/serving/http, modelcontextprotocol.io/specification/2026-07-28/changelog, code.claude.com/docs/en/mcp, claude.com/docs/connectors/building/authentication, anthropic.com/engineering/writing-tools-for-agents
- **REST API / webhooks:** github.com/standard-webhooks/standard-webhooks, github.com/samchungy/zod-openapi, zod.dev/json-schema
- **PDF / E-Rechnung:** github.com/cantoo-scribe/pdf-lib, github.com/gflohr/e-invoice-eu, github.com/diegomura/react-pdf (CHANGELOG), gotenberg.dev/docs/manipulate-pdfs/factur-x, github.com/ZUGFeRD/mustangproject, mustangproject.org/commandline, github.com/itplr-kosit/validator (`docs/daemon.md`, `docs/cli.md`), github.com/itplr-kosit/validator-configuration-xrechnung, github.com/gflohr/e-invoice-eu-validator
- **Testing:** vitest.dev/guide/migration, mswjs.io/docs/migrations/2.x-to-3.x, playwright.dev/docs/test-snapshots
- **VAT ID checks:** ec.europa.eu/assets/taxud/vow-information/swagger_publicVAT.yaml, api.evatr.vies.bzst.de/api-docs
- **Bank sync:** github.com/robocode13/lib-fints, fints.org/de/hersteller/produktregistrierung, bankaccountdata.gocardless.com/new-signups-disabled
- **Claude API:** platform.claude.com/docs (models, structured outputs, PDF support)
- **ELSTER / DATEV:** elster.de/eportal/infoseite/entwickler, developer.datev.de
- **Versions:** registry.npmjs.org (fetched 2026-10-12)
