import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { lintCompose } from "./compose-lint";

const prod = () => parse(readFileSync(join(import.meta.dirname, "../compose/docker-compose.yml"), "utf8"));
const rules = (doc: unknown) => lintCompose(doc).map((v) => `${v.service}:${v.rule}`);

const logging = { driver: "json-file", options: { "max-size": "20m", "max-file": "5" } };
const base = () => ({
  services: {
    caddy: { image: "reg/rechnungen-caddy:abc", expose: ["443", "8443"], logging },
    web: { image: "reg/rechnungen-web:abc", logging },
    backend: { image: "ghcr.io/get-convex/convex-backend:72ce13c", environment: ["DISABLE_BEACON=1"], logging },
    dashboard: { image: "ghcr.io/get-convex/convex-dashboard:72ce13c", logging },
    postgres: { image: "postgres:17.11", logging },
  },
});

describe("production compose lint (08 §3.1)", () => {
  test("SEC-01 the committed production compose file passes", () => {
    expect(lintCompose(prod())).toEqual([]);
  });

  test("SEC-01 the committed file publishes only caddy, on 443 and 8443", () => {
    const doc = prod();
    const published = Object.entries(doc.services as Record<string, Record<string, unknown>>)
      .filter(([, s]) => s.ports !== undefined || s.expose !== undefined)
      .map(([n, s]) => [n, s.expose]);
    expect(published).toEqual([["caddy", ["443", "8443"]]]);
  });

  test("SEC-01 any other service with expose or ports fails", () => {
    const a = base();
    Object.assign(a.services.backend, { expose: ["3210"] });
    Object.assign(a.services.postgres, { ports: ["5432:5432"] });
    expect(rules(a)).toEqual(["backend:only-edge-published", "postgres:only-edge-published"]);
  });

  test("SEC-01 caddy must use expose (not ports) with exactly 443 and 8443", () => {
    const a = base();
    a.services.caddy = { image: "reg/rechnungen-caddy:abc", ports: ["443:443"], logging } as never;
    expect(rules(a)).toEqual(["caddy:edge-no-host-ports", "caddy:edge-ports"]);
    const b = base();
    b.services.caddy.expose = ["443", "8443", "2019"];
    expect(rules(b)).toEqual(["caddy:edge-ports"]);
  });

  test("SEC-01 a missing edge service fails", () => {
    const a = base() as { services: Record<string, unknown> };
    delete a.services.caddy;
    expect(rules(a)).toContain("caddy:edge-present");
  });

  test("Convex truthy flags set to a false-looking value fail (any non-empty value enables them)", () => {
    for (const value of ["false", "0", "FALSE", "off", ""]) {
      const a = base();
      a.services.backend.environment = [`DISABLE_BEACON=${value}`];
      expect(rules(a)).toEqual(["backend:convex-truthy-flag"]);
    }
    const map = base();
    Object.assign(map.services.backend, { environment: { REDACT_LOGS_TO_CLIENT: false } });
    expect(rules(map)).toEqual(["backend:convex-truthy-flag"]);
  });

  test("IS_TEST, host networking, privileged mode, build: and unpinned images fail", () => {
    const a = base();
    Object.assign(a.services.web, { environment: ["IS_TEST=1"], network_mode: "host", privileged: true, build: "." });
    a.services.postgres.image = "postgres";
    a.services.caddy.image = "reg/rechnungen-caddy:latest";
    expect(rules(a).sort()).toEqual(
      [
        "caddy:image-pinned",
        "postgres:image-pinned",
        "web:forbidden-env",
        "web:no-build",
        "web:no-host-network",
        "web:no-privileged",
      ].sort(),
    );
  });

  test("backend and dashboard must use the same Convex SHA", () => {
    const a = base();
    a.services.dashboard.image = "ghcr.io/get-convex/convex-dashboard:other";
    expect(rules(a)).toEqual(["dashboard:convex-same-sha"]);
  });

  test("a registry with a port is not mistaken for a tag", () => {
    const a = base();
    a.services.web.image = "registry.local:5000/rechnungen-web";
    expect(rules(a)).toEqual(["web:image-pinned"]);
  });

  test("DSGVO-06 every service rotates its logs (json-file/local with max-size and max-file)", () => {
    const doc = base() as { services: Record<string, Record<string, unknown>> };
    delete doc.services.web?.logging;
    if (doc.services.postgres) doc.services.postgres.logging = { driver: "json-file", options: { "max-size": "20m" } };
    if (doc.services.backend) doc.services.backend.logging = { driver: "syslog", options: {} };
    expect(rules(doc)).toEqual(["web:log-rotation", "backend:log-rotation", "postgres:log-rotation"]);
    const committed = prod() as { services: Record<string, { logging?: unknown }> };
    for (const [name, svc] of Object.entries(committed.services)) expect(svc.logging, name).toEqual(logging);
  });
});

describe("public edge compose lint (08 §12)", () => {
  const pub = () => parse(readFileSync(join(import.meta.dirname, "../compose/docker-compose.public.yml"), "utf8"));
  const publicRules = (doc: unknown) => lintCompose(doc, { edge: "public" }).map((v) => `${v.service}:${v.rule}`);
  const publicBase = () => {
    const doc = base() as { services: Record<string, Record<string, unknown>> };
    doc.services.caddy = {
      image: "reg/rechnungen-caddy:abc",
      command: ["caddy", "run", "--config", "/etc/caddy/Caddyfile.public", "--adapter", "caddyfile"],
      logging,
    };
    return doc;
  };

  test("SEC-01 the committed public compose file passes in public mode", () => {
    expect(lintCompose(pub(), { edge: "public" })).toEqual([]);
  });

  test("SEC-01 the committed public compose publishes nothing and runs caddy with Caddyfile.public", () => {
    const doc = pub() as { services: Record<string, Record<string, unknown>> };
    const published = Object.entries(doc.services).filter(([, s]) => s.ports !== undefined || s.expose !== undefined);
    expect(published).toEqual([]);
    expect(doc.services.caddy?.command).toEqual([
      "caddy",
      "run",
      "--config",
      "/etc/caddy/Caddyfile.public",
      "--adapter",
      "caddyfile",
    ]);
    const env = ((doc.services.caddy?.environment ?? []) as string[]).map((e) => e.split("=")[0]);
    expect(env).not.toContain("CLOUDFLARE_DNS_API_TOKEN");
    expect(env).not.toContain("ACME_EMAIL");
  });

  test("SEC-01 the public compose differs from the tailnet compose only in the caddy edge service", () => {
    const a = pub() as { services: Record<string, unknown> };
    const b = prod() as { services: Record<string, unknown> };
    const { caddy: _a, ...restA } = a.services;
    const { caddy: _b, ...restB } = b.services;
    expect(restA).toEqual(restB);
  });

  test("SEC-01 in public mode any expose or ports fails (caddy included) and caddy must use Caddyfile.public", () => {
    expect(publicRules(publicBase())).toEqual([]);
    const a = publicBase();
    Object.assign(a.services.caddy as object, { expose: ["80"] });
    Object.assign(a.services.backend as object, { ports: ["3210:3210"] });
    expect(publicRules(a)).toEqual(["caddy:public-not-published", "backend:public-not-published"]);
    const b = publicBase();
    delete (b.services.caddy as Record<string, unknown>).command;
    expect(publicRules(b)).toEqual(["caddy:public-caddyfile"]);
  });

  test("SEC-01 the tailnet rules still apply to the tailnet file (public caddy fails there)", () => {
    expect(rules(publicBase())).toEqual(["caddy:edge-ports"]);
  });
});
