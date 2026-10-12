# syntax=docker/dockerfile:1.7
# TLS edge image (08 §3, §8 "Caddy"): Caddy + caddy-dns/cloudflare for the DNS-01 wildcard certificate.
# Build context: deploy/caddy   →   docker build -t rechnungen-caddy deploy/caddy
# Bump CADDY_VERSION / CLOUDFLARE_DNS_VERSION on Caddy releases; certificates persist in the caddy-data volume.

ARG CADDY_VERSION=2.11.7

FROM caddy:${CADDY_VERSION}-builder AS build
ARG CADDY_VERSION
ARG CLOUDFLARE_DNS_VERSION=v0.2.4
RUN xcaddy build "v${CADDY_VERSION}" --with "github.com/caddy-dns/cloudflare@${CLOUDFLARE_DNS_VERSION}"

FROM caddy:${CADDY_VERSION}-alpine
COPY --from=build /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile

# Fail the build on a broken Caddyfile or a missing DNS module (dummy values; the token only has to look valid).
RUN set -eux; \
    caddy list-modules | grep -q '^dns.providers.cloudflare$'; \
    BASE_DOMAIN=example.test ACME_EMAIL=ci@example.test \
    CLOUDFLARE_DNS_API_TOKEN=0123456789abcdefghijklmnopqrstuvwxyzABCD \
    CONVEX_DASH_BASIC_AUTH="$(caddy hash-password --plaintext ci)" \
      caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile; \
    apk add --no-cache libcap; \
    setcap cap_net_bind_service=+ep /usr/bin/caddy; \
    grep -q '^caddy:' /etc/group || addgroup -S -g 10000 caddy; \
    grep -q '^caddy:' /etc/passwd || adduser -S -D -H -u 10000 -G caddy caddy; \
    mkdir -p /data /config; \
    chown -R caddy:caddy /data /config

# Non-root; 443/8443 bind via cap_net_bind_service. The ONLY image allowed to EXPOSE ports (08 §3.1): the fork reads
# the compose `expose:` list, this is documentation only.
USER caddy
EXPOSE 443 8443
