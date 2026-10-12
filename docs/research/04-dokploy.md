# Dokploy: deploying a self-hosted Next.js app and Convex (docker-compose)

Research date: 2026-10-12. Sources are docs.dokploy.com, github.com/Dokploy/{dokploy,cli,templates} (source code read directly) and npm. Items marked **[UNCERTAIN]** could not be confirmed. The headline finding is that the CLI documentation on docs.dokploy.com is out of date. The real CLI is generated from the API, and `dokploy authenticate` and `env pull/push` no longer exist (section 2).

---

## 1. Current version

- **Dokploy v0.30.8**, published 2026-09-29. This is the latest release. Before it: v0.30.7 (2026-09-18), v0.30.6 (2026-09-08), v0.30.5 (2026-09-02) and v0.30.4 (2026-09-01).
  - Source: https://api.github.com/repos/Dokploy/dokploy/releases
- **Install:**
  ```bash
  curl -sSL https://dokploy.com/install.sh | sh
  ```
  - Pin a specific version by using that release's own installer: `curl -sL https://github.com/Dokploy/dokploy/releases/download/v0.30.8/install.sh | sh`
  - `DOKPLOY_VERSION=canary|latest` also works.
- **Update:**
  ```bash
  curl -sSL https://dokploy.com/install.sh | sh -s update
  ```
- **Requirements:** at least 2 GB RAM and 30 GB disk. Ports 80, 443 and 3000 must be free.
- **Firewall:** keep port 3000 (the Dokploy UI) closed to the public. Docker bypasses UFW, so the production-hardening guide recommends `ufw-docker`.
  - Sources: https://docs.dokploy.com/docs/core/installation and https://docs.dokploy.com/docs/core/guides/production-hardening
- **Traefik:** the bundled image is `traefik:v3.6.25` by default. I read this from `packages/server/src/setup/traefik-setup.ts` on the canary branch; I did not check the v0.30.8 tag.

## 2. Dokploy CLI

- **npm package:** `@dokploy/cli`. The latest version is **0.30.7** (published around September 2026). The binary is called `dokploy`.
  ```bash
  npm install -g @dokploy/cli
  ```
- **Repository:** https://github.com/Dokploy/cli (branch `main`). It is now generated from `openapi.json`.
  - The README says it has 449 commands across 43 groups, one per API endpoint.
  - Usage is `dokploy <group> <action> [--flags] [--json]`.
  - Action names are the API methods in kebab-case, for example `application.saveBuildType` becomes `application save-build-type`.
  - Flags are the API fields in camelCase, for example `--applicationId`.

**Authentication** (from `src/commands/auth.ts` and `src/client.ts`):
```bash
dokploy auth -u https://dokploy.example.com -t <API_KEY>
# or set env vars (also read from ./.env; shell vars take precedence):
export DOKPLOY_URL=https://dokploy.example.com
export DOKPLOY_API_KEY=<API_KEY>   # DOKPLOY_AUTH_TOKEN also accepted as fallback
```
- `auth` checks the token with `GET /api/trpc/user.get` and the `x-api-key` header, then writes `config.json` next to the installed package.
- All CLI calls go to `${url}/api/trpc/<endpoint>`.

**Stale documentation.** https://docs.dokploy.com/docs/cli still describes the old CLI:
- `dokploy verify`
- `dokploy app create|delete|deploy|stop`
- `dokploy database postgresql|mysql|mariadb|mongodb|redis create|delete|deploy|stop`
- `dokploy env pull <file>` / `env push <file>`

In the current 0.30.x code, only `auth` plus the generated commands are registered. There is **no `authenticate`, `verify`, `env pull` or `env push`**. To get environment variables, use `application one --applicationId X --json`. To set them, use `application save-environment` or `compose save-environment`.

**Main command groups and actions in 0.30.x** (from `src/generated/commands.ts`):

| Group | Actions |
|---|---|
| `project` | all, all-for-permissions, create (`--name` required; `--description`, `--env` optional), duplicate, one, remove, search, update |
| `environment` | by-project-id, create, duplicate, one, remove, search, update |
| `application` | create (`--name --environmentId` required; `[--sourceType github\|docker\|git\|gitlab\|bitbucket\|gitea\|drop] [--serverId] [--appName]`), deploy, redeploy, start, stop, reload, delete, one, move, search, cancel-deployment, kill-build, clean-queues, clear-deployments, read-logs, read-app-monitoring, read-traefik-config, update-traefik-config, refresh-token, save-build-type, save-environment, save-github-provider, save-git-provider, save-gitlab-provider, save-bitbucket-provider, save-gitea-provider, save-docker-provider, disconnect-git-provider, update, mark-running, drop-deployment, deploy-nginx-quickstart |
| `compose` | create (`--name --environmentId` required; `[--composeType docker-compose\|stack] [--sourceType git\|github\|gitlab\|bitbucket\|gitea\|raw] [--composeFile] [--serverId]`), deploy (`--composeId [--freshVolumes]`), redeploy, start, stop, delete, one, update, save-environment (`--composeId --env [--createEnvFile]`), load-services, load-mounts-by-service, get-converted-compose, randomize-compose, isolated-deployment, import, templates, preview-template, process-template, deploy-template, fetch-source-type, get-default-command, get-tags, move, search, cancel-deployment, kill-build, clean-queues, clear-deployments, read-logs, refresh-token, disconnect-git-provider |
| `domain` | create (only `--host` required), update, delete, one, by-application-id, by-compose-id, generate-domain, validate-domain, toggle-enable, can-generate-traefik-me-domains |
| `postgres`, `mysql`, `mariadb`, `mongo`, `redis`, `libsql` | create, deploy, start, stop, reload, rebuild, remove, one, update, move, read-logs, save-environment, save-external-port, change-status, change-password, search. libsql is a newer database type and uses `save-external-ports`. |
| `backup` | create, one, update, remove, list-backup-files, manual-backup-postgres, -my-sql, -mariadb, -mongo, -libsql, -compose, -web-server |
| `volume-backups` | create (`--name --volumeName --prefix --cronExpression --destinationId`), list, one, update, delete, run-manually |
| `schedule` | create (`--name --cronExpression --command`), list, one, update, delete, run-manually |
| `security` (basic auth) | create (`--applicationId --username --password`), update, delete, one |
| Other groups | `mounts`, `port`, `redirects`, `destination` (all/create/one/remove/test-connection/update), `deployment`, `rollback` (rollback/delete), `preview-deployment` (all/delete/one/redeploy), `registry`, `server`, `settings` (e.g. reload-traefik, update-middleware-traefik-config, read-traefik-file/update-traefik-file), `certificates`, `notification`, `forward-auth`, `patch`, `vault-provider`, `ssh-key`, `user` (create-api-key/delete-api-key), `docker*`, `network`, `swarm`, `tag`, `organization`, `sso`, `scim`, `license-key`, `whitelabeling` |

**Generating an API token:** go to Dashboard, then Settings, then **Profile** (`/dashboard/settings/profile`), open the **API/CLI** section and click **Generate**.
- Tokens never expire by default. You can set an expiry, which the docs recommend for CI.
- Admins can always create tokens. Other users need an admin to grant API/token permission first.
- Source: https://docs.dokploy.com/docs/cli/authentication

## 3. REST API

- **Base URL:** `https://<dokploy-host>/api/<router>.<procedure>`, for example `/api/project.all`. It is tRPC exposed as OpenAPI.
  - Mutations use `POST` with a JSON body.
  - Queries use `GET` with query parameters, for example `GET /api/project.one?projectId=...`.
- **Auth header:** `x-api-key: <token>`
- **Swagger UI:** `http://<host>:3000/swagger`. By default only authenticated admins can open it. The OpenAPI document is also available through `settings.getOpenApiDocument`.
  - Source: https://docs.dokploy.com/docs/api
- **Reference pages:** `https://docs.dokploy.com/docs/api/reference-<router>`, for example `reference-application`, `reference-compose`, `reference-domain`.

**Key endpoints and request bodies:**

| Endpoint | Body (required in **bold**) |
|---|---|
| `POST project.create` | **name**, description, env. Returns `{project, environment}`, so you get a default `environmentId` (from the router source). **[UNCERTAIN]** that the default environment is named "production". |
| `POST environment.create` | **name**, **projectId** (likely) |
| `POST application.create` | **name**, **environmentId**, appName, description, serverId, sourceType. Returns the application including `applicationId`. |
| `POST application.saveGithubProvider` | **applicationId, repository, owner, buildPath, githubId, branch, triggerType** (`push`\|`tag`), watchPaths, enableSubmodules |
| `POST application.saveGitProvider` | **applicationId, customGitUrl, customGitBranch, customGitBuildPath, watchPaths**, customGitSSHKeyId |
| `POST application.saveDockerProvider` | **applicationId, dockerImage, username, password, registryUrl** (nullable) |
| `POST application.saveBuildType` | **applicationId, buildType** (`dockerfile\|nixpacks\|railpack\|heroku_buildpacks\|paketo_buildpacks\|static`), **dockerfile, dockerContextPath, dockerBuildStage, herokuVersion, railpackVersion** (nullable), publishDirectory, isStaticSpa |
| `POST application.saveEnvironment` | **applicationId, env, buildArgs, buildSecrets, createEnvFile** (bool) |
| `POST application.deploy` / `redeploy` | **applicationId**, title, description |
| `POST application.update` | **applicationId**, plus autoDeploy, replicas, healthCheckSwarm, cpuLimit, memoryLimit, … |
| `GET application.readTraefikConfig` / `POST application.updateTraefikConfig` | applicationId / **applicationId, traefikConfig** (YAML string) |
| `POST compose.create` | **name, environmentId**, composeType (`docker-compose`\|`stack`), sourceType (`raw`\|`git`\|`github`\|`gitlab`\|`bitbucket`\|`gitea`), composeFile, appName (`^[a-zA-Z0-9._-]+$`, 1–63 characters), serverId |
| `POST compose.update` | **composeId**, plus env, composeFile, sourceType, composePath, autoDeploy, isolatedDeployment, randomize, command, watchPaths, … |
| `POST compose.deploy` / `redeploy` | **composeId**, title, description, freshVolumes |
| `GET compose.loadServices` | composeId, type=`cache`\|`fetch` |
| `POST compose.deployTemplate` | **environmentId, id** (template id, e.g. `convex`), serverId, baseUrl |
| `POST domain.create` | **host**, path, port, https, certificateType (`letsencrypt`\|`none`\|`custom`), customCertResolver, applicationId \| composeId + **serviceName** (for compose), domainType, internalPath, stripPath, **middlewares** (string[]), customEntrypoint, forwardAuthEnabled |
| `POST security.create` | **applicationId, username, password** |
| `POST backup.create` | **schedule, prefix, destinationId, database, databaseType** (`postgres\|mariadb\|mysql\|mongo\|web-server\|libsql`), keepLatestCount, backupType (`database`\|`compose`), composeId, serviceName, enabled |
| `POST volumeBackups.create` | **name, volumeName, prefix, cronExpression, destinationId**, serviceType (`application\|compose\|postgres\|…`), serviceName, turnOff, keepLatestCount, applicationId \| composeId |
| `POST destination.create` | **name, provider, accessKey, secretAccessKey, bucket, region, endpoint, additionalFlags**, serverId |

**Example curl** (from https://docs.dokploy.com/docs/core/auto-deploy):
```bash
curl -X GET 'https://dokploy.example.com/api/project.all' \
  -H 'accept: application/json' -H 'x-api-key: <token>'

curl -X POST 'https://dokploy.example.com/api/application.deploy' \
  -H 'accept: application/json' -H 'Content-Type: application/json' \
  -H 'x-api-key: <token>' -d '{"applicationId":"<id>"}'

# compose domain example
curl -X POST 'https://dokploy.example.com/api/domain.create' -H 'Content-Type: application/json' -H 'x-api-key: <token>' \
  -d '{"host":"convex-api.example.com","port":3210,"https":true,"certificateType":"letsencrypt","composeId":"<id>","serviceName":"backend","domainType":"compose"}'
```
**[UNCERTAIN]** The exact `domainType` values are probably `application`, `compose` and `preview`; the reference page lists the field only as a string.

**CI actions:** there is no official Dokploy GitHub Action. Community options are `qbix-tech/dokploy-deploy-action@v1` (supports apps and compose) and `benbristow/dokploy-deploy-action`. Alternatively, call `application.deploy` or `compose.deploy` with curl.

## 4. Docker Compose services

Source: https://docs.dokploy.com/docs/core/docker-compose (and its /domains and /utilities subpages).

**Docker Compose vs Stack:**
- "Docker Compose" runs `docker compose up`.
- "Stack" runs in Swarm mode:
  - `build:` is not supported, so you need prebuilt images.
  - Traefik labels go under `deploy.labels`.
  - With replicas and a private registry, add `--with-registry-auth`.

**Source types:**
- `raw`: paste the compose file in the UI.
- Git: GitHub, GitLab, Bitbucket, Gitea or a custom Git URL, with a `composePath`.
  - Git sources re-clone on every deploy, and support auto-deploy webhooks and watch paths.

**Custom command:** in Advanced. It replaces Dokploy's command completely rather than appending to it. The default is `compose -p <app-name> -f <compose-path> up -d --build --remove-orphans --force-recreate`.

**Environment variables:**
- Variables entered in the UI are written to a `.env` file next to `docker-compose.yml`.
- They are **not automatically injected into containers**. Use `env_file: [.env]`, or `environment: - KEY=${KEY}` (compose interpolation).
- Shared variables: `${{project.X}}`, `${{environment.X}}`. Vault references: `${{vault.<provider>.<path>:KEY}}`.

**Domains (recommended method, the Domains tab):**
- Add a domain and choose the **Service Name** (the compose service) and **Container Port**.
- At deploy time Dokploy injects the Traefik labels and attaches `dokploy-network` to that service. Use "Preview Compose" to see the result.
- **Redeploy after every domain change.** Compose domains are labels, so there is no hot reload. Application domains are file-based and hot-reload.
- From the source code:
  - Router name: `${appName}-${uniqueConfigKey}-${entrypoint}`.
  - The `web` router gets `redirect-to-https@file` when HTTPS is on.
  - The cert resolver is `letsencrypt`.
  - The network label is `traefik.docker.network=dokploy-network`, or `traefik.swarm.network` for stacks.
  - Custom `middlewares` on the domain are added to the `websecure` router.
- Without Isolated Deployment, only the selected service gets `dokploy-network`. Other services reach each other through the compose `default` network.

**Manual labels** (alternative method):
```yaml
services:
  frontend:
    expose: ["3000"]
    networks: [dokploy-network]
    labels:
      - traefik.enable=true
      - traefik.http.routers.frontend-app.rule=Host(`frontend.example.com`)
      - traefik.http.routers.frontend-app.entrypoints=websecure
      - traefik.http.routers.frontend-app.tls.certresolver=letsencrypt
      - traefik.http.services.frontend-app.loadbalancer.server.port=3000
networks:
  dokploy-network:
    external: true
```
The docs example uses `entrypoints=web`. I added the websecure and certresolver lines based on Dokploy's generated labels. Prefer `expose` over `ports`.

**Isolated Deployments** (Utilities):
- Creates a network named after the appName, attaches every service to it, and connects Traefik to it.
- Templates turn this on by default. Use it when running multiple copies of the same stack.

**Volumes:**
- Use **named volumes** for databases and anything stateful. Only named volumes can use Volume Backups.
- `../files/...` bind mounts are for config files and are kept across deploys.
- Never use absolute host paths ("will be cleaned up during deployments").
- Never use `./` repo-relative mounts with Git sources, because each deploy re-clones the repo. Use Advanced, then Mounts, then File Mount, and reference it as `../files/<name>`.
- A compose volume's real Docker name is `{appName}_{volumeName}`.

## 5. Next.js application

**Build types:**

| Build type | Notes |
|---|---|
| `nixpacks` | Default. Configured with `NIXPACKS_*` env vars or `nixpacks.toml`. Supports a publish directory. |
| `railpack` | Successor to Nixpacks. Optional pinned version (e.g. `0.15.1`). Uses `RAILPACK_BUILD_CMD` and `RAILPACK_START_CMD`. |
| `dockerfile` | Fields: Dockerfile path, Docker context path, build stage. |
| `heroku_buildpacks` | Default version 24. |
| `paketo_buildpacks` | |
| `static` | nginx serving on port 80. `isStaticSpa` is available. |

Source: https://docs.dokploy.com/docs/core/applications/build-type

**How env vars reach the build** (verified in `packages/server/src/utils/builders/*.ts`):
- **Nixpacks:** app, project and environment env vars are passed as `--env`, so they **are visible at build time**. `NEXT_PUBLIC_*` values in the Environment tab get baked into the bundle.
- **Railpack:** env vars are passed as BuildKit secrets plus `--env` during prepare, so they are available at build time. A hash of them invalidates the cache when they change. Empty values are skipped.
- **Dockerfile:** the runtime `env` is **NOT** passed to `docker build`.
  - Put `NEXT_PUBLIC_*` in **Build Args**, which become `--build-arg`, and declare `ARG NEXT_PUBLIC_CONVEX_URL` (plus `ENV`) in the builder stage.
  - Put secrets (for example `CONVEX_SELF_HOSTED_ADMIN_KEY`, if `npx convex deploy` runs during the build) in **Build Secrets**. These become `--secret type=env,id=KEY`, which you read with `RUN --mount=type=secret,id=KEY`.
  - Build args stay in the image; build secrets do not.
- **`createEnvFile`:** writes a `.env` file next to the Dockerfile. It is skipped when a publish directory is set.
- **Runtime env:** container env comes from the Environment tab.

**Recommended approach for production:**
- Use `output: 'standalone'` with a multi-stage Dockerfile: the `builder` stage runs `next build`, and the runner copies `.next/standalone`, `.next/static` and `public`, then runs `CMD ["node","server.js"]`.
- Set the domain port to 3000, or whatever `PORT` you use.
- The Dokploy docs suggest building in CI and deploying the image (source type Docker) to avoid building on the server, which can freeze it (going-production guide).
- Dokploy's official Next.js guide (https://docs.dokploy.com/docs/core/nextjs) is only the examples repo (`https://github.com/Dokploy/examples.git`, path `/nextjs`) with Nixpacks.

**GitHub provider and auto-deploy:**
- Install the Dokploy GitHub App (Settings, then Git), then pick the repository, branch and build path.
- Auto-deploy on push works with no further setup. `triggerType` can be `push` or `tag`. `watchPaths` limits deploys to changes in certain paths (useful for monorepos).
- GitLab, Bitbucket, Gitea and Docker Hub: turn on Auto Deploy and copy the webhook URL into the provider. The branch must match, or you get a "Branch Not Match" error.
- Source: https://docs.dokploy.com/docs/core/auto-deploy

## 6. Domains, Traefik, HTTPS

**Domain fields:** Host, Path, Internal Path, Strip Path, Container Port, HTTPS, Certificate Provider (None / Let's Encrypt / Custom resolver), Custom Entrypoint, and **Middlewares**.
- The Middlewares field is a tag list with the placeholder "e.g., rate-limit@file, auth@file". Its tooltip says "Middlewares must be defined in your Traefik configuration." (from `handle-domain.tsx`)
- traefik.me generated domains are HTTP only. For HTTPS, upload the traefik.me certificate as a custom certificate and set the provider to None.

**Traefik setup** (from `traefik-setup.ts`):
- Runs as the standalone container `dokploy-traefik`.
- Entrypoints are `web` (:80) and `websecure` (:443).
- Providers: docker and swarm (`exposedByDefault: false`, network `dokploy-network`) and file (`/etc/dokploy/traefik/dynamic`, watched).
- Let's Encrypt resolver `letsencrypt`: HTTP challenge on `web`, storage `/etc/dokploy/traefik/dynamic/acme.json`.
- **The default ACME email is `test@localhost.com`.** Set a real one in the Web Server settings or in `traefik.yml`.
- The default `middlewares.yml` defines `redirect-to-https` (redirectScheme https, permanent).

**Editing Traefik config:**
- **Per app:** Advanced, then Traefik, edits that app's dynamic router file (`application.updateTraefikConfig`). Generated routers are named `${appName}-router-${key}` and `${appName}-router-websecure-${key}`.
- **Global:** Web Server, then Traefik, then File System, edits `traefik.yml`, `dynamic/middlewares.yml` and any custom dynamic files. Use Reload Traefik after editing the static config.
- An unofficial source reports that edits to `middlewares.yml` do not automatically propagate to remote servers. **[UNCERTAIN]**

**Other options:**
- Cloudflare: see https://docs.dokploy.com/docs/core/domains/cloudflare
- DNS-challenge and wildcard certificates: see `/docs/core/dns-providers/cloudflare` and `/docs/core/dns-providers/route53` (pages exist; not read in detail).
- www to apex redirect: Advanced, then Redirects, has a preset.

## 7. Volumes, mounts, backups, cron

**Application mounts** (Advanced, then Volumes): Bind, Volume (named) and File Mount.
- File mounts are stored in the service's `files` folder and survive redeploys.
- If a mount is invalid, Swarm silently fails to start the app. Check the Swarm section in General.

**S3 destinations** (Settings, then Destinations): any S3-compatible store (AWS S3, R2, B2, MinIO, …), with a test-connection button.

**Database backups** (Backups tab on Dokploy-managed databases):
- Supports Postgres, MySQL, MariaDB, Mongo and libSQL.
- Settings: destination, database name, cron, prefix, enabled, and `keepLatestCount` for retention.
- **Compose database backups also exist**: `backupType: "compose"` with `serviceName`, plus `backup.manualBackupCompose`.
- Restore: https://docs.dokploy.com/docs/core/databases/restore
- Web Server backups cover the Dokploy Postgres database plus `/etc/dokploy`, zipped to S3.

**Volume Backups: yes, supported now** (https://docs.dokploy.com/docs/core/volume-backups):
- Works for Applications and Compose services, **named volumes only**. Uploads to S3 on a cron schedule, with `keepLatestCount`.
- "Turn off container" is recommended for consistency (for example for Convex's SQLite data).
- Restore: Volume Backups, then Restore Volume. The target volume must not exist or be in use.

**Schedule Jobs** (Schedules tab and Web Server):
- Four types: Application (`docker exec` in the container), Compose (one service), Server (bash on the host) and Dokploy Server (inside the Dokploy container).
- Each run is logged. Do not change `COMPOSE_PROJECT_NAME`.
- Source: https://docs.dokploy.com/docs/core/schedule-jobs

## 8. Protecting an app that has no login

**Basic auth, Applications only:**
- Advanced, then **Security**, add a username and password. API: `security.create {applicationId, username, password}`.
- Dokploy generates a middleware `auth-${appName}` and attaches it to the app's routers.
- Preview deployments inherit it.
- There is **no Security tab for compose**. `security.create` only accepts `applicationId`.

**IP allowlist:** define it once in Web Server, then Traefik, then File System, `dynamic/middlewares.yml`:
```yaml
http:
  middlewares:
    redirect-to-https:            # keep the default
      redirectScheme: { scheme: https, permanent: true }
    office-only:
      ipAllowList:
        sourceRange: ["203.0.113.10/32", "10.0.0.0/8"]
        # behind Cloudflare/another proxy: ipStrategy: { depth: 1 }  (or configure forwardedHeaders.trustedIPs on the entrypoint)
    convex-basic:
      basicAuth:
        users: ["admin:$apr1$...."]   # htpasswd -nb admin pass
```
Then attach it in one of these ways:
- **Any domain, app or compose:** in the domain's **Middlewares** field, enter `office-only@file`. This is the easiest option. For compose, the code appends it to the websecure router, then redeploy.
- **Applications, manually:** edit the router in Advanced, then Traefik, and add `middlewares: [office-only@file]` (same pattern as the hardening guide's `secure-headers` example).
- **Compose, through labels:**
  ```yaml
  labels:
    - traefik.http.routers.<router>.middlewares=office-only@file
    # or inline basic auth (escape $ as $$ in compose):
    - traefik.http.middlewares.convex-auth.basicauth.users=admin:$$apr1$$...
  ```

Notes:
- `ipWhiteList` is deprecated in Traefik v3. Use `ipAllowList`.
- Do not put basic auth in front of the Convex backend API (port 3210/3211), because clients call it directly. Protect the dashboard (6791) or the Next.js app only.
- **SSO forward-auth (Enterprise license only):** oauth2-proxy plus Traefik forwardAuth, configured under Settings, then SSO, then Application Authentication. It works on application domains only, not compose. Source: https://docs.dokploy.com/docs/core/enterprise/sso/application-authentication

## 9. Templates: Convex exists

- Location: https://github.com/Dokploy/templates/tree/canary/blueprints/convex
- Files: `docker-compose.yml`, `template.toml`, `meta.json`, `convex.svg`. Last updated 2026-08-25; the image was bumped and ports changed to `expose` on 2026-03-05.
- Deploy it from the UI (Create Service, then Template, then Convex) or with `compose.deployTemplate {environmentId, id:"convex"}`.

`docker-compose.yml` (verbatim):
```yaml
services:
  backend:
    image: ghcr.io/get-convex/convex-backend:5cdea511cd6527a95dd24152ea0d3c3bb2ab379f
    expose: ["3210", "3211"]
    volumes: [data:/convex/data]
    environment:
      - INSTANCE_NAME=${INSTANCE_NAME:-}
      - INSTANCE_SECRET=${INSTANCE_SECRET:-}
      - CONVEX_RELEASE_VERSION_DEV=${CONVEX_RELEASE_VERSION_DEV:-}
      - ACTIONS_USER_TIMEOUT_SECS=${ACTIONS_USER_TIMEOUT_SECS:-}
      - CONVEX_CLOUD_ORIGIN=${CONVEX_CLOUD_ORIGIN:-http://127.0.0.1:3210}
      - CONVEX_SITE_ORIGIN=${CONVEX_SITE_ORIGIN:-http://127.0.0.1:3211}
      - DATABASE_URL=${DATABASE_URL:-}
      - DISABLE_BEACON=${DISABLE_BEACON:-FALSE}
      - REDACT_LOGS_TO_CLIENT=${REDACT_LOGS_TO_CLIENT:-}
      - RUST_LOG=${RUST_LOG:-info}
      - RUST_BACKTRACE=${RUST_BACKTRACE:-}
    healthcheck:
      test: curl -f http://localhost:3210/version
      interval: 5s
      start_period: 5s
  dashboard:
    image: ghcr.io/get-convex/convex-dashboard:5cdea511cd6527a95dd24152ea0d3c3bb2ab379f
    expose: ["6791"]
    environment:
      - NEXT_PUBLIC_DEPLOYMENT_URL=${NEXT_PUBLIC_DEPLOYMENT_URL:-http://127.0.0.1:3210}
    depends_on:
      backend: { condition: service_healthy }
volumes:
  data:
```
(`expose` and `volumes` are condensed to inline YAML here; the values are verbatim.)

`template.toml` (verbatim):
```toml
[variables]
dashboard_domain = "${domain}"
backend_domain = "${domain}"
actions_domain = "${domain}"

[config]
env = [
  "NEXT_PUBLIC_DEPLOYMENT_URL=http://${backend_domain}",
  "CONVEX_CLOUD_ORIGIN=http://${backend_domain}",
  "CONVEX_SITE_ORIGIN=http://${actions_domain}",
]
mounts = []

[[config.domains]]
serviceName = "dashboard"
port = 6_791
host = "${dashboard_domain}"

[[config.domains]]
serviceName = "backend"
port = 3_210
host = "${backend_domain}"

[[config.domains]]
serviceName = "backend"
port = 3_211
host = "${actions_domain}"
```

What to change after deploying the template:
- It generates three traefik.me hosts and uses `http://` URLs, with the image pinned to a commit hash.
- In production, replace the hosts with real domains with HTTPS and Let's Encrypt, change the env values to `https://…`, and consider bumping the image tag.
- Create the admin key inside the backend container (Docker or terminal tab): `./generate_admin_key.sh` (Convex's documented script; not covered by the Dokploy docs).
- In the Next.js app, set `NEXT_PUBLIC_CONVEX_URL=https://<backend_domain>` as a **build arg** (Dockerfile) or a build-time env var (Nixpacks/Railpack).
- Template helper variables: `${domain}`, `${password:N}`, `${base64:N}`, `${hash:N}`, `${uuid}`, `${randomPort}`, `${email}`, `${username}`, `${timestamp}`, `${jwt:secret_var[:payload_var]}`.

## 10. Monitoring, rollbacks, previews, multi-server

**Monitoring:**
- Each app and compose service has CPU, memory, disk and network graphs. They only update while the page is open.
- The full server and container metrics setup uses a metrics service on port 4500, refreshes every 20 s, keeps data for 2 days, and sends threshold alerts through notifications.
- The docs page says that full setup is "only available in the Cloud version". **[UNCERTAIN]** whether it works when self-hosted. Remote-server monitoring is not supported.
- Notification channels: Slack, Discord, Telegram, email, Resend, Gotify, ntfy, Pushover, Teams, Lark, Mattermost, custom webhook.

**Rollbacks:**
- *Swarm automatic rollback:* in Advanced, then Cluster, then Swarm Settings:
  - Health Check example: `{"Test":["CMD","curl","-f","http://localhost:3000/health"],"Interval":30000000000,"Timeout":10000000000,"StartPeriod":30000000000,"Retries":3}`
  - Update Config example: `{"Parallelism":1,"Delay":10000000000,"FailureAction":"rollback","Order":"start-first"}`
  - Both are my reconstruction from the docs (durations in nanoseconds). The image needs `curl`.
  - This is also how you get zero-downtime deploys.
- *Registry-based rollback:* in Deployments, then Rollback Settings, turn it on and select a registry. Each deployment's image is pushed there, and a Rollback button appears per deployment.
- Applications only.
- Sources: https://docs.dokploy.com/docs/core/applications/rollbacks and https://docs.dokploy.com/docs/core/applications/zero-downtime

**Preview deployments:**
- Built for GitHub-integrated applications. Off by default.
- Preview URLs use a wildcard domain (e.g. `*.example.com`) or traefik.me.
- `${{DOKPLOY_DEPLOY_URL}}` is available to the preview.
- Default limit is 3 previews per app; default port 3000. You can require PR labels.
- Previews are cleaned up when the PR closes. The docs advise against using them with public repositories.
- Source: https://docs.dokploy.com/docs/core/applications/preview-deployments

**Multi-server:**
- Remote servers connect over SSH. Each gets its own Traefik, and you choose `serverId` per service.
- Build servers build images and push them to a registry, for Applications only.
- Swarm nodes are available for clustering.
- The Dokploy UI alone uses about 250 MB RAM when you only deploy to remote servers.
- Source: https://docs.dokploy.com/docs/core/remote-servers

**Other things worth knowing:**
- Only the last 10 deployments are shown.
- Queued deployments can be cancelled; in-progress ones cannot.
- Resource limits take raw bytes and nanoCPUs. Units like `1024m` cause a Swarm deploy error.
