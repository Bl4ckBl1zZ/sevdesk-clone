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
