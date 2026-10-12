## Self-hosted Convex for a Next.js invoicing app on Dokploy (verified 2026-10-12)

I checked this against the official files: `get-convex/convex-backend` (README, `docker/docker-compose.yml`, `docker-build/*.sh`, `advanced/*.md`, CHANGELOG), docs.convex.dev (via its `.md` endpoints), `convex-js` CLI source, the GHCR registry, npm, and the Dokploy and Coolify template repos. Anything marked **[uncertain]** is my inference and not stated in a primary source.

### 1. Versions and images
- **Images:** `ghcr.io/get-convex/convex-backend` and `ghcr.io/get-convex/convex-dashboard`. The only tags are `latest` and 40-character git commit SHAs (648 tags each). There is no semver.
- **Newest SHA tags** (match GitHub release `precompiled-2026-10-10-72ce13c`, 2026-10-10): `72ce13c379fe6dbdfc305bc8ad699c5663c68c2a` and `bb95347206534c36ffc2b842dad28bd3479e0fec`.
  - **[uncertain]** The `:latest` digest (`sha256:d715e9ec…`) matched none of the last 25 SHA tags I checked, so `latest` may be built from a different commit.
  - **Recommendation:** pin backend and dashboard to the **same** SHA. The CHANGELOG says: "Make sure to use the same version of `convex-backend` and `convex-dashboard`. Different versions are not guaranteed to be compatible."
- **CHANGELOG:** not maintained since 2025-09-17 ("Check `git log`").
  - Useful milestones: S3 storage (2025-02-26); R2 (2025-03-06); `POSTGRES_URL`/`MYSQL_URL` replaced `DATABASE_URL` (2025-02-19); `AWS_S3_FORCE_PATH_STYLE` for MinIO (2025-08-05); log-stream/export integrations (axiom/datadog/sentry/fivetran/airbyte) in self-hosted (2025-07-01).
- **npm `convex`:** latest is **1.46.0** (published 2026-09-16). The README says to use `npm install convex@latest`.
- **License:** FSL-1.1-Apache-2.0. Each release converts to Apache-2.0 after 2 years. You may not build a product that competes with Convex Cloud.

### 2. Official docker-compose.yml (verbatim, `self-hosted/docker/docker-compose.yml`)
```yaml
services:
  backend:
    # Change this to :${REV} if you want to pin to a specific version
    image: ghcr.io/get-convex/convex-backend:latest
    stop_grace_period: 10s
    stop_signal: SIGINT
    ports:
      - "${PORT:-3210}:3210"
      - "${SITE_PROXY_PORT:-3211}:3211"
    volumes:
      - data:/convex/data
    environment:
      - V8_ACTION_USER_TIMEOUT_SECS
      - NODE_ACTION_USER_TIMEOUT_SECS
      - APPLICATION_MAX_CONCURRENT_MUTATIONS=${APPLICATION_MAX_CONCURRENT_MUTATIONS:-16}
      - APPLICATION_MAX_CONCURRENT_NODE_ACTIONS=${APPLICATION_MAX_CONCURRENT_NODE_ACTIONS:-16}
      - APPLICATION_MAX_CONCURRENT_QUERIES=${APPLICATION_MAX_CONCURRENT_QUERIES:-16}
      - APPLICATION_MAX_CONCURRENT_V8_ACTIONS=${APPLICATION_MAX_CONCURRENT_V8_ACTIONS:-16}
      - AWS_ACCESS_KEY_ID
      - AWS_REGION
      - AWS_S3_DISABLE_CHECKSUMS
      - AWS_S3_DISABLE_SSE
      - AWS_S3_FORCE_PATH_STYLE
      - AWS_SECRET_ACCESS_KEY
      - AWS_SESSION_TOKEN
      - CONVEX_CLOUD_ORIGIN=${CONVEX_CLOUD_ORIGIN:-http://127.0.0.1:${PORT:-3210}}
      - CONVEX_RELEASE_VERSION_DEV
      - CONVEX_SITE_ORIGIN=${CONVEX_SITE_ORIGIN:-http://127.0.0.1:${SITE_PROXY_PORT:-3211}}
      - DATABASE_URL
      - DISABLE_BEACON
      - DISABLE_METRICS_ENDPOINT=${DISABLE_METRICS_ENDPOINT:-true} # Enable if you want prometheus compatible /metrics endpoint
      - DOCUMENT_RETENTION_DELAY=${DOCUMENT_RETENTION_DELAY:-172800} # Lower default document retention to 2 days
      - DO_NOT_REQUIRE_SSL
      - HTTP_SERVER_TIMEOUT_SECONDS
      - INSTANCE_NAME
      - INSTANCE_SECRET
      - MYSQL_URL
      - POSTGRES_URL
      - REDACT_LOGS_TO_CLIENT
      - RUST_BACKTRACE
      - RUST_LOG=${RUST_LOG:-info}
      - S3_ENDPOINT_URL
      - S3_STORAGE_EXPORTS_BUCKET
      - S3_STORAGE_FILES_BUCKET
      - S3_STORAGE_MODULES_BUCKET
      - S3_STORAGE_SEARCH_BUCKET
      - S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET
    healthcheck:
      test: curl -f http://localhost:3210/version
      interval: 5s
      start_period: 10s
  dashboard:
    image: ghcr.io/get-convex/convex-dashboard:latest
    stop_grace_period: 10s
    stop_signal: SIGINT
    ports:
      - "${DASHBOARD_PORT:-6791}:6791"
    environment:
      - NEXT_PUBLIC_DEPLOYMENT_URL=${NEXT_PUBLIC_DEPLOYMENT_URL:-http://127.0.0.1:${PORT:-3210}}
      - NEXT_PUBLIC_LOAD_MONACO_INTERNALLY
    depends_on:
      backend:
        condition: service_healthy
volumes:
  data:
```
- Port 3210 is the API and WebSocket.
- Port 3211 serves HTTP actions (the "site" origin).
- Port 6791 is the dashboard.
- All state lives in the `/convex/data` volume: `db.sqlite3`, `storage/`, `tmp/` and `credentials/`.

### 3. Environment variables (behaviour taken from `docker-build/run_backend.sh` and `read_credentials.sh`)
| Var | Notes |
|---|---|
| `INSTANCE_NAME` | Defaults to `convex-self-hosted`. Persisted to `/convex/data/credentials/instance_name`. With Postgres/MySQL the **database name is INSTANCE_NAME with `-` replaced by `_`** (default `convex_self_hosted`), and you must create that database first. |
| `INSTANCE_SECRET` | If unset, it is read from `credentials/instance_secret`, or a new one is generated with `openssl rand -hex 32` and persisted. Rotating it invalidates all admin keys. For Dokploy, set it explicitly with `openssl rand -hex 32` so it doesn't depend on the volume. |
| `CONVEX_CLOUD_ORIGIN` | Public API URL, e.g. `https://convex-api.example.de`. It appears in storage URLs and action callbacks. |
| `CONVEX_SITE_ORIGIN` | Public HTTP-actions URL, e.g. `https://convex-site.example.de`. |
| `NEXT_PUBLIC_DEPLOYMENT_URL` | Dashboard variable: the backend API URL **as the browser reaches it**. |
| `POSTGRES_URL` / `MYSQL_URL` | Connection string **without the database name or query params**, e.g. `postgresql://user:pass@host:5432`. The backend is tested with Postgres 17 and MySQL 8. Logs show `Connected to Postgres`. |
| `DATABASE_URL` | **Deprecated.** It still works but treats the value as Postgres and prints a warning. |
| `DO_NOT_REQUIRE_SSL` | Needed for a local or internal DB without TLS. |
| S3 | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (+ optional `AWS_SESSION_TOKEN`) and the five buckets `S3_STORAGE_EXPORTS_BUCKET`, `S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET`, `S3_STORAGE_MODULES_BUCKET`, `S3_STORAGE_FILES_BUCKET`, `S3_STORAGE_SEARCH_BUCKET`. **All 6 (region + 5 buckets) are required.** If only some are set, the backend warns and falls back to local storage. `S3_ENDPOINT_URL` is for R2, MinIO, Hetzner and similar. `AWS_S3_FORCE_PATH_STYLE` is for MinIO/DO. `AWS_S3_DISABLE_SSE` and `AWS_S3_DISABLE_CHECKSUMS` help with S3-compatible services. |
| `DISABLE_BEACON` | Turns off the anonymous usage beacon (random ID + version). |
| `REDACT_LOGS_TO_CLIENT` | Redacts error and log details sent to clients, as Convex Cloud prod does. Recommended for prod. |
| `RUST_LOG` | Default `info`. `RUST_BACKTRACE` is also available. |
| `DISABLE_METRICS_ENDPOINT` | Default `true`. Set `false` for a Prometheus `/metrics` endpoint. |
| `DOCUMENT_RETENTION_DELAY` | Default 172800 (2 days). |
| Others | `V8_ACTION_USER_TIMEOUT_SECS`, `NODE_ACTION_USER_TIMEOUT_SECS`, `HTTP_SERVER_TIMEOUT_SECONDS`, `APPLICATION_MAX_CONCURRENT_*` (default 16 each). Advanced tuning is in `advanced/knobs.md`. |

- **Default is SQLite** at `/convex/data/db.sqlite3` with local file storage under `/convex/data/storage`.
- **Gotcha (verified in the script):** `DISABLE_BEACON`, `REDACT_LOGS_TO_CLIENT` and `DO_NOT_REQUIRE_SSL` are passed with `${VAR:+--flag}`. **Any non-empty value turns the feature on, including `false` or `FALSE`.** Leave them empty or unset to keep them off.
- **Latency:** the backend should sit close to its database. The docs stress putting it in the same region or host.

### 4. Admin key
```sh
docker compose exec backend ./generate_admin_key.sh
# runs: ./generate_key "$INSTANCE_NAME" "$INSTANCE_SECRET"
# output looks like: convex-self-hosted|01c046ab...
```
- In Dokploy, run `./generate_admin_key.sh` from the backend container's terminal.
- The key is valid for as long as `INSTANCE_SECRET` is unchanged.
- Self-hosted has no deploy keys and no preview keys. The admin key is the single root credential, so treat it as a secret.

### 5. Deploying functions
`.env.local` (not committed):
```sh
CONVEX_SELF_HOSTED_URL='https://convex-api.example.de'
CONVEX_SELF_HOSTED_ADMIN_KEY='<admin key>'
```
- **Commands:**
  - `npx convex dev` watches and pushes code.
  - `npx convex dev --once` pushes once.
  - `npx convex deploy` typechecks, runs codegen, bundles and pushes.
- **CLI rules (from `deploymentSelection.ts`):**
  - Both variables must be set.
  - `CONVEX_DEPLOYMENT` **must not** be set at the same time. The CLI errors on a mix of cloud and self-hosted variables.
- **`--env-file`:** `npx convex deploy --env-file .env.prod` picks a different file that contains `CONVEX_SELF_HOSTED_URL`. This is documented.
- **Hidden flags:** `--url <url>` and `--admin-key <key>` also exist on `dev` and `deploy`.
- **CI / Docker build**, using the documented `--cmd` and `--cmd-url-env-var-name` flags:
  ```sh
  CONVEX_SELF_HOSTED_URL=... CONVEX_SELF_HOSTED_ADMIN_KEY=... \
    npx convex deploy --cmd 'npm run build' --cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL
  ```
  - This pushes functions, then runs the Next build with `NEXT_PUBLIC_CONVEX_URL` set to the deployment URL.
  - It is the README's pattern: replace `CONVEX_DEPLOY_KEY` with the two `SELF_HOSTED` variables.
  - In a Dockerfile, pass both as build args or secrets and avoid baking the admin key into an image layer, e.g. `RUN --mount=type=secret`.
  - Alternative: run `npx convex deploy` as a separate CI step or Dokploy pre-deploy step, then do a plain `next build` with `NEXT_PUBLIC_CONVEX_URL` passed as a **build-time** argument. Next.js inlines `NEXT_PUBLIC_*` at build time.
- **[medium confidence, from CLI source]** With self-hosted variables, `npx convex dev` does **not** write `NEXT_PUBLIC_CONVEX_URL` to `.env.local` for you. Set it by hand to the same URL as `CONVEX_SELF_HOSTED_URL`.
- **Environment variables for functions:** `npx convex env set KEY value` or the dashboard.

### 6. Backups, migration and upgrades
- **Backup:**
  - `npx convex export --path ./backups/` (or `--path snapshot.zip`).
  - Add **`--include-file-storage`** to include uploaded files, e.g. invoice PDFs, under `_storage/`.
  - The result is a consistent point-in-time snapshot ZIP named `snapshot_{ts}.zip` with `<table>/documents.jsonl`.
- **What an export leaves out:** code (it lives in your repo), environment variables, and pending scheduled functions.
  - Save environment variables separately with `npx convex env list --include-values > .env.convex`.
  - Restore them with `npx convex env set --force --from-file .env.convex`.
- **No periodic backups:** the cloud "Backup automatically" feature is a Pro feature of Convex Cloud. **[uncertain]** Whether the self-hosted dashboard offers backups at all. For self-hosted, plan a cron job that runs `npx convex export` with the admin-key variables and/or volume- or DB-level backups (`pg_dump`, Dokploy volume backups).
- **Restore:** `npx convex import --replace-all snapshot.zip`.
  - `--replace` replaces only the tables in the import; `--append` adds to them; `-y` skips the prompt.
  - For a single table: `--table`.
  - To clear a table: `npx convex import --table T --replace --format jsonLines /dev/null -y` (from `clearing_data.md`). There is deliberately no reset command.
- **Switching database or storage provider** (SQLite to Postgres, local to S3): export, start a fresh backend, import with `--replace-all`, and redeploy functions with `npx convex deploy`.
- **Upgrading** (`advanced/upgrading.md`):
  - **Option 1, in place:** run `npx convex export` first, change the image tag, then watch the logs for migration lines like `Executing Migration 114/115. MigrationComplete(115)`. Export/import is **not required**, only recommended as a safety net.
  - **Option 2, export/import:**
    1. Stop traffic.
    2. `npx convex export`.
    3. Save environment variables with `npx convex env list --include-values > .env.convex`.
    4. Upgrade the image.
    5. `npx convex import --replace-all`.
    6. `npx convex env set --force --from-file .env.convex`.
    7. Restore traffic.

    Downtime scales with the amount of data.
  - Upgrade backend and dashboard to the same SHA together.

### 7. Feature support and limits
- **README:** "Self-hosted Convex supports all the free-tier features of the cloud-hosted product."
  - That includes queries, mutations, actions (including `"use node"` actions), **HTTP actions** on `CONVEX_SITE_ORIGIN`/3211 (`convex/http.ts`), **file storage** (`ctx.storage`; `getUrl` URLs are built from `CONVEX_CLOUD_ORIGIN`, so that variable must be the public HTTPS URL), **scheduled functions and crons**, text and vector search, components, and the dashboard.
  - Log-stream and export integrations have been available since 2025-07.
- **Limits and differences:**
  - Runs on a single machine; you scale vertically.
  - You own operations: backups, monitoring, restarts.
  - No official support plan; help is in Discord `#self-hosted`.
  - One backend equals one deployment. For a dev/staging/prod split, run separate backends, each with its own key.
  - No preview deployments, deploy keys or team/project management.
  - The Convex Auth CLI setup doesn't support self-hosted; use the manual setup.
  - Cloud dashboard features such as the usage page, periodic backups and insights are absent or Pro-only. **[uncertain]** I could not confirm this list from an official source.

### 8. Next.js integration (docs.convex.dev, App Router)
```tsx
// app/ConvexClientProvider.tsx
"use client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ReactNode } from "react";
const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return <ConvexProvider client={convex}>{children}</ConvexProvider>;
}
// app/layout.tsx: <body><ConvexClientProvider>{children}</ConvexClientProvider></body>
```
- **Server side:** `import { preloadQuery, fetchQuery, fetchMutation, fetchAction, preloadedQueryResult } from "convex/nextjs"`, with `usePreloadedQuery` from `convex/react` on the client.
  - These need **either `NEXT_PUBLIC_CONVEX_URL` set, or `{ url }` passed in the third options argument**. Auth goes in the same argument as `{ token }`.
  - They use the stateless `ConvexHttpClient` with `cache: 'no-store'`, so there is no static rendering. Multiple `preloadQuery` calls on one page aren't guaranteed to be consistent with each other.
  - Next.js server rendering support is marked **beta**.
- **Server-side URL tip [suggestion]:** the third-argument `url` lets Next server code reach the backend over the internal Docker network, e.g. `{ url: process.env.CONVEX_INTERNAL_URL }` with `http://backend:3210` on `dokploy-network`, while browsers use the public URL.

### 9. Auth
- **Convex Auth is not required.** Without an auth provider, `ctx.auth.getUserIdentity()` returns `null`, and every **public** query, mutation and action can be called by anyone who knows the API URL.
- **For an invoicing app [recommendation]:**
  - Configure your own JWT/OIDC provider (`convex/auth.config.ts`, "Custom JWT Provider" docs, e.g. Better Auth, Clerk, Auth0, Keycloak) and pass tokens via `ConvexProviderWithAuth` or `{ token }`.
  - Or keep logic in `internal*` functions and expose only checked public wrappers.
- **If you do use Convex Auth:** follow the manual setup at https://labs.convex.dev/auth/setup/manual. The README says the CLI doesn't support self-hosted for this.
- Community threads report "could not verify token claim" problems on self-hosted; these are usually wrong `CONVEX_SITE_ORIGIN` or issuer settings **[uncertain]**.

### 10. Dokploy and Coolify
- **Dokploy template exists:** `github.com/Dokploy/templates/blueprints/convex` (`docker-compose.yml`, `template.toml`, `meta.json`; meta version "latest").
  - Images are pinned to **`5cdea511cd6527a95dd24152ea0d3c3bb2ab379f`**, which is old: last bumped in PR #730, 2025-08-23.
  - Services use `expose` (3210, 3211, 6791) instead of `ports`.
  - `template.toml` defines **three domains**: dashboard → `dashboard:6791`, backend → `backend:3210`, actions → `backend:3211`. It also sets the environment variables `NEXT_PUBLIC_DEPLOYMENT_URL=http://${backend_domain}`, `CONVEX_CLOUD_ORIGIN=http://${backend_domain}` and `CONVEX_SITE_ORIGIN=http://${actions_domain}`.
- **Problems with the template:**
  - It uses `http://`. Change to `https://` once Let's Encrypt is enabled on each domain.
  - It uses deprecated `DATABASE_URL` and the outdated `ACTIONS_USER_TIMEOUT_SECS`.
  - It has `DISABLE_BEACON=${DISABLE_BEACON:-FALSE}`, which actually **disables** the beacon (see section 3).
  - It lacks the S3 and `POSTGRES_URL` variables.
  - **Recommendation:** start from the official compose, replace `ports` with `expose`, pin a current SHA, and add the three domains in the Dokploy Domains tab.
- **Coolify template:** `coollabsio/coolify/templates/compose/convex.yaml`, pinned to `a9a760ca10399ed42e1b4bb87c78539a235488c7`.
  - Uses `SERVICE_URL_BACKEND_3210`, `SERVICE_URL_SITE_3211`, `SERVICE_URL_DASHBOARD_6791` and `INSTANCE_SECRET=${SERVICE_HEX_64_SECRET}`.
  - Includes the full S3 and Postgres/MySQL variable set. It is a good reference.
- **Official routing example** (`advanced/hosting_on_own_infra.md`): `api.my-domain.com`→3210, `my-domain.com`→3211, `dashboard.my-domain.com`→6791. `.env` next to the compose file sets `CONVEX_CLOUD_ORIGIN`, `CONVEX_SITE_ORIGIN` and `NEXT_PUBLIC_DEPLOYMENT_URL`.
- **Traefik notes:**
  - WebSockets go over the 3210 domain; Traefik handles them natively.
  - Point DNS at the server before adding domains.
  - Don't also publish host ports.
  - Consider restricting the dashboard domain with basic-auth or IP allowlist middleware; it is protected only by the admin key **[suggestion]**.
- **Hosting in Germany:** one VPS (e.g. Hetzner DE) with backend + Postgres + MinIO/Hetzner Object Storage keeps data in the EU. Convex Cloud does not offer EU data residency, per news.convex.dev/self-hosting.
- **Community guide:** bitdoze "Self-Host Convex in 2026: Docker Compose & Dokploy Setup Guide" (template walkthrough with a Postgres 17 sidecar). Coolify threads on discord-questions.convex.dev show `CONVEX_SITE_ORIGIN` set to `<backend>/http`, a path-based alternative to a second domain **[uncertain; not in official docs]**.

### 11. Local development and tests
- **Option A, Docker:** `docker compose up` the official file, run `generate_admin_key.sh`, then point `.env.local` at `http://127.0.0.1:3210`. This gives dev/prod parity with the self-hosted setup.
- **Option B, CLI-managed local backend (beta):**
  - With no deployment configured, a non-interactive `npx convex dev` provisions an **anonymous local deployment** with no login. State goes in `.convex/`. The CLI downloads the binary on first run.
  - `npx convex deployment select local` targets the local deployment. `--local` still exists but is now a hidden flag. `CONVEX_AGENT_MODE=anonymous` forces anonymous mode.
  - The backend runs only while `convex dev` is running.
  - `npx convex deploy` refuses to deploy from an anonymous local deployment.
  - Don't mix this with the `CONVEX_SELF_HOSTED_*` variables.
- **CI against a real backend:**
  - Run the backend image as a service container. Use healthcheck `curl -f http://localhost:3210/version`.
  - Set a fixed `INSTANCE_SECRET` and generate the admin key with `docker exec <c> ./generate_admin_key.sh`.
  - Then: `npx convex env set IS_TEST true`, `npx convex deploy`, run vitest.
  - Clear data between tests with a guarded `clearAll` mutation, or with `import --replace` from `/dev/null`.
  - Test with vitest `maxWorkers: 1`; scheduled functions and crons really run, so gate crons on `IS_TEST`.
  - Sources: docs.convex.dev/testing/convex-backend and stack.convex.dev/testing-with-local-oss-backend.
  - Alternative: `convex-test` (a JS mock, faster, with time control).
  - Precompiled binaries are attached to GitHub releases, e.g. `convex-local-backend-x86_64-unknown-linux-gnu.zip`; run with `./convex-local-backend --instance-name … --instance-secret …`.

### Sources
- https://github.com/get-convex/convex-backend/blob/main/self-hosted/README.md
- https://github.com/get-convex/convex-backend/blob/main/self-hosted/docker/docker-compose.yml
- https://github.com/get-convex/convex-backend/tree/main/self-hosted/docker-build (`run_backend.sh`, `read_credentials.sh`, `generate_admin_key.sh`)
- https://github.com/get-convex/convex-backend/tree/main/self-hosted/advanced (`postgres_or_mysql.md`, `s3_storage.md`, `upgrading.md`, `hosting_on_own_infra.md`, `clearing_data.md`, `disabling_logging.md`, `dashboard.md`, `running_binary_directly.md`)
- https://github.com/get-convex/convex-backend/blob/main/self-hosted/CHANGELOG.md
- https://github.com/get-convex/convex-backend/releases and https://github.com/get-convex/convex-backend/pkgs/container/convex-backend
- https://docs.convex.dev/self-hosting, /client/nextjs/app-router/server-rendering, /quickstart/nextjs, /cli/reference/deploy, /cli/reference/export, /cli/reference/import, /database/backup-restore, /cli/local-deployments, /cli/agent-mode, /testing/convex-backend
- https://github.com/get-convex/convex-js (`src/cli/deploy.ts`, `lib/deploymentSelection.ts`, `configure.ts`, `dev.ts`)
- https://registry.npmjs.org/convex (1.46.0)
- https://github.com/Dokploy/templates/tree/main/blueprints/convex
- https://github.com/coollabsio/coolify/blob/main/templates/compose/convex.yaml
- https://stack.convex.dev/self-hosted-develop-and-deploy
- https://stack.convex.dev/testing-with-local-oss-backend
- https://www.bitdoze.com/convex-self-host/
- https://news.convex.dev/self-hosting/
- https://discord-questions.convex.dev/m/1345150160627437578
