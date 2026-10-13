# syntax=docker/dockerfile:1.7
# web image: Next.js 16.4 standalone on Node 24 (02 §1, 08 §3.1). Build context: repository root.
#
#   docker build \
#     --build-arg NEXT_PUBLIC_CONVEX_URL=https://convex.buero.example.de \
#     --build-arg NEXT_PUBLIC_SITE_URL=https://app.buero.example.de \
#     --build-arg APP_VERSION=$(git rev-parse --short HEAD) -t rechnungen-web .
#
# NEXT_PUBLIC_* are inlined into the browser bundle at build time (08 §5.1) → one image per BASE_DOMAIN.
# No EXPOSE on purpose: only caddy is published (08 §3.1).

ARG NODE_VERSION=24.21.0
ARG PNPM_VERSION=12.11.2

# ── deps: install with the lockfile (pnpm-workspace.yaml `allowBuilds` decides which build scripts may run) ───────
FROM node:${NODE_VERSION}-slim AS deps
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN npm install -g "pnpm@${PNPM_VERSION}" && pnpm --version
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
# Workspace members must exist for a frozen install (their manifests only; the sidecar has no dependencies).
COPY services/einvoice-tools/package.json services/einvoice-tools/package.json
# pnpm patches (pdfkit: static standard-font imports so the Convex Node bundle contains the AFM data).
COPY patches ./patches
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

# ── build ────────────────────────────────────────────────────────────────────────────────────────────────────────
FROM deps AS build
ARG NEXT_PUBLIC_CONVEX_URL
ARG NEXT_PUBLIC_SITE_URL
ARG APP_VERSION=dev
ENV NEXT_PUBLIC_CONVEX_URL=${NEXT_PUBLIC_CONVEX_URL} \
    NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \
    APP_VERSION=${APP_VERSION} \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
COPY . .
RUN test -n "$NEXT_PUBLIC_CONVEX_URL" && test -n "$NEXT_PUBLIC_SITE_URL" || \
      { echo "build args NEXT_PUBLIC_CONVEX_URL and NEXT_PUBLIC_SITE_URL are required (08 §5.1)" >&2; exit 1; }
RUN pnpm build && mkdir -p public

# ── runtime: standalone server only, non-root ───────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-slim AS runtime
ARG APP_VERSION=dev
# SET-130: shown on /einstellungen/system (cd-deploy passes `git rev-parse HEAD` and the UTC build date).
ARG GIT_SHA
ARG BUILD_DATE
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA} \
    BUILD_DATE=${BUILD_DATE}
WORKDIR /app
# `node` (uid 1000) exists in the official image.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/assets ./assets
USER node

# HOSTNAME=0.0.0.0 matters: Docker sets HOSTNAME to the container id, and the standalone server binds to it.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "server.js"]
