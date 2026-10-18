import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/** Text checks of the production Caddyfile; the image build additionally runs `caddy validate` (deploy/caddy/Dockerfile). */
const caddyfile = readFileSync(join(import.meta.dirname, "Caddyfile"), "utf8");
const snippet = (name: string) => {
  const start = caddyfile.indexOf(`(${name}) {`);
  const end = caddyfile.indexOf("\n}\n", start);
  return caddyfile.slice(start, end);
};
const siteAddresses = () =>
  caddyfile
    .split("\n")
    .filter((l) => /^\S.*\{\s*$/.test(l) && !l.startsWith("(") && !l.startsWith("{"))
    .map((l) => l.replace(/\s*\{\s*$/, ""));

describe("Caddyfile (08 §3.2)", () => {
  test("DSGVO-06 DSGVO-05 the access log truncates client IPs and never records cookies or credentials", () => {
    const log = snippet("access_log");
    expect(log).toMatch(/format filter \{/);
    expect(log).toMatch(/request>remote_ip ip_mask 24 48/);
    expect(log).toMatch(/request>client_ip ip_mask 24 48/);
    for (const header of ["request>headers>Cookie", "request>headers>Authorization", "resp_headers>Set-Cookie"]) {
      expect(log).toContain(`${header} delete`);
    }
    // Every site logs through the filtered snippet; no other log directive exists.
    const sites = siteAddresses();
    expect(sites.length).toBeGreaterThanOrEqual(2);
    expect(caddyfile.match(/import access_log/g)?.length).toBe(sites.length);
    expect(caddyfile.match(/^\s*log \{/gm)?.length).toBe(1);
  });

  test("DSGVO-05 TLS everywhere: only TLS listeners (443/8443), HSTS, no plain-HTTP sites", () => {
    expect(siteAddresses()).toEqual(["*.{$BASE_DOMAIN}:443", "*.{$BASE_DOMAIN}:8443"]);
    expect(caddyfile).not.toMatch(/^\s*http:\/\//m);
    expect(caddyfile).not.toMatch(/auto_https off|tls internal|protocols tls1\.[01]/);
    expect(snippet("security_headers")).toMatch(/Strict-Transport-Security "max-age=31536000"/);
  });
});

/** Public edge mode (08 §12): Cloudflare terminates TLS → tunnel → Traefik → caddy:80. Same routing as the tailnet edge. */
const publicCaddyfile = readFileSync(join(import.meta.dirname, "Caddyfile.public"), "utf8");
const sitesOf = (text: string) =>
  text
    .split("\n")
    .filter((l) => /^\S.*\{\s*$/.test(l) && !l.startsWith("(") && !l.startsWith("{"))
    .map((l) => l.replace(/\s*\{\s*$/, ""));
/** The host routing of the first site block: from the first `@app host` matcher to the 421 fallback. */
const routing = (text: string) => {
  const start = text.indexOf("\t@app host");
  const end = text.indexOf("respond 421", start);
  return text
    .slice(start, end)
    .replace(/^\s*#.*$/gm, "")
    .replace(/\s+/g, " ");
};

describe("Caddyfile.public (08 §12, public edge mode)", () => {
  test("SEC-01 one plain-HTTP site on :80 behind Cloudflare/Traefik; no ACME, no website listener", () => {
    expect(sitesOf(publicCaddyfile)).toEqual([":80"]);
    const directives = publicCaddyfile.replace(/^\s*#.*$/gm, "");
    expect(directives).not.toMatch(/acme_dns|ACME_EMAIL|CLOUDFLARE_DNS_API_TOKEN|:8443|:443|\btls\b/);
    expect(publicCaddyfile).toMatch(/auto_https off/);
    expect(publicCaddyfile).toMatch(/admin off/);
  });

  test("SEC-01 SEC-06 the host routing is identical to the tailnet edge (allowlists, cookie strip, dash auth, 421)", () => {
    const route = routing(publicCaddyfile);
    expect(route.length).toBeGreaterThan(500);
    expect(route).toBe(routing(caddyfile));
    for (const host of ["app", "api", "convex", "convex-site", "convex-dash"]) {
      expect(route).toContain(`host ${host}.{$BASE_DOMAIN}`);
    }
    expect(route).toContain("request_header -Cookie");
    expect(route).toContain("owner {$CONVEX_DASH_BASIC_AUTH}");
    expect(route).toMatch(
      /@machine_api path \/api\/v1 \/api\/v1\/\* \/api\/mcp \/api\/mcp\/\* handle @machine_api \{ respond 404/,
    );
    expect(publicCaddyfile).toMatch(/handle \{\s*respond 421\s*\}/);
  });

  test("DSGVO-06 DSGVO-05 the public site logs through the filtered snippet and keeps HSTS", () => {
    const snip = (name: string) => {
      const start = publicCaddyfile.indexOf(`(${name}) {`);
      return publicCaddyfile.slice(start, publicCaddyfile.indexOf("\n}\n", start));
    };
    expect(snip("access_log")).toBe(snippet("access_log"));
    expect(snip("security_headers")).toBe(snippet("security_headers"));
    expect(publicCaddyfile.match(/import access_log/g)?.length).toBe(1);
    expect(publicCaddyfile.match(/^\s*log \{/gm)?.length).toBe(1);
  });
});
