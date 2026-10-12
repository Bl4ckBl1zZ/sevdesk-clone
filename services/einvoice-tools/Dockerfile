# syntax=docker/dockerfile:1.7
# einvoice-tools sidecar (02 §8): KoSIT validator daemon + Mustang CLI behind a zero-dependency Node HTTP server.
# Build context: services/einvoice-tools   →   docker build -t rechnungen-einvoice-tools services/einvoice-tools
#
# Versions and SHA-256 checksums are pinned here; bumping them is a PR that re-runs the golden validation suite
# (08 §8 "KoSIT config / Mustang"). Checksums computed 2026-10-12 from the official URLs
# (the KoSIT jar's SHA-1 was cross-checked against Maven Central's .sha1 file).
#
# No EXPOSE on purpose: the service is internal (08 §3.1) and must never be published by the Dokploy fork.

ARG NODE_VERSION=24.21.0
ARG TEMURIN_TAG=17.0.20.1_1-jre-noble

FROM node:${NODE_VERSION}-slim AS node

FROM alpine:3.22 AS fetch
ARG KOSIT_VERSION=1.6.3
ARG KOSIT_SHA256=799e64befca97d4080e03608c80b85dd5a5ecc5f4ae4f35d1116ec2855b9a7c9
ARG XRECHNUNG_VERSION=3.0.2
ARG XRECHNUNG_CONFIG_VERSION=2026-08-31
ARG XRECHNUNG_CONFIG_SHA256=2530cd107c414511c5d0462ec10f886910395abfca820db82e83d70bf01221a8
ARG MUSTANG_VERSION=2.26.0
ARG MUSTANG_SHA256=42d7868cb68264874a7b8cab4c3587b03b23ccc7cd72373da917f66758bb9736
RUN set -eux; \
    mkdir -p /opt/kosit/config /opt/mustang; \
    wget -q -O /opt/kosit/validator.jar \
      "https://repo1.maven.org/maven2/org/kosit/validator/${KOSIT_VERSION}/validator-${KOSIT_VERSION}-standalone.jar"; \
    echo "${KOSIT_SHA256}  /opt/kosit/validator.jar" | sha256sum -c -; \
    wget -q -O /tmp/config.zip \
      "https://github.com/itplr-kosit/validator-configuration-xrechnung/releases/download/v${XRECHNUNG_CONFIG_VERSION}/xrechnung-${XRECHNUNG_VERSION}-validator-configuration-${XRECHNUNG_CONFIG_VERSION}.zip"; \
    echo "${XRECHNUNG_CONFIG_SHA256}  /tmp/config.zip" | sha256sum -c -; \
    unzip -q /tmp/config.zip -d /opt/kosit/config; \
    test -f /opt/kosit/config/scenarios.xml; \
    wget -q -O /opt/mustang/Mustang-CLI.jar \
      "https://github.com/ZUGFeRD/mustangproject/releases/download/core-${MUSTANG_VERSION}/Mustang-CLI-${MUSTANG_VERSION}.jar"; \
    echo "${MUSTANG_SHA256}  /opt/mustang/Mustang-CLI.jar" | sha256sum -c -

FROM eclipse-temurin:${TEMURIN_TAG}
ARG KOSIT_VERSION=1.6.3
ARG XRECHNUNG_CONFIG_VERSION=2026-08-31
ARG MUSTANG_VERSION=2.26.0
# Image version, e.g. 2026-08-31-1 (02 §8: the tag includes the config bundle date). CI passes the git SHA too.
ARG EINVOICE_TOOLS_VERSION=2026-08-31-1

# Node runtime only (no npm): the server has no dependencies. Ubuntu noble ships glibc + libstdc++ for it.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=fetch /opt/kosit /opt/kosit
COPY --from=fetch /opt/mustang /opt/mustang

RUN set -eux; \
    groupadd --system --gid 10001 eit; \
    useradd --system --uid 10001 --gid eit --home-dir /tmp --shell /usr/sbin/nologin eit; \
    node --version; java -version

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    KOSIT_PORT=8081 \
    KOSIT_JAR=/opt/kosit/validator.jar \
    KOSIT_CONFIG_DIR=/opt/kosit/config \
    MUSTANG_JAR=/opt/mustang/Mustang-CLI.jar \
    KOSIT_VERSION=${KOSIT_VERSION} \
    XRECHNUNG_CONFIG_VERSION=${XRECHNUNG_CONFIG_VERSION} \
    MUSTANG_VERSION=${MUSTANG_VERSION} \
    EINVOICE_TOOLS_VERSION=${EINVOICE_TOOLS_VERSION} \
    HOME=/tmp \
    JAVA_TOOL_OPTIONS="-XX:+UseSerialGC -Djava.awt.headless=true"

USER 10001:10001

# The KoSIT daemon needs ~10–20 s to load the scenarios; /health is 503 until it is up.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
