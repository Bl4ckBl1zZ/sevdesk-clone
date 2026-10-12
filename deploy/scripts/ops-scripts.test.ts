import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Server scripts that only run on the DEPLOYED STACK (Dokploy server schedules, 08 §7.1): log-retention.sh
 * (DSGVO-06) and ops-check.sh (DSGVO-05/06, SEC-05). CI exercises their checks with fixtures; the `all` mode
 * (docker, lsblk/zfs, /opt/rechnungen/backup.env) is verified only on the server.
 */
const dir = import.meta.dirname;
const NOW = "2026-10-12T00:00:00Z";
const line = (time: string, log = "x") => `${JSON.stringify({ log: `${log}\n`, stream: "stdout", time })}\n`;
const tmp = () => mkdtempSync(join(tmpdir(), "ops-"));
const run = (script: string, args: string[], env: Record<string, string> = {}, input?: string) =>
  spawnSync("bash", [join(dir, script), ...args], { encoding: "utf8", env: { ...process.env, ...env }, input });

describe("log-retention.sh (DSGVO-06)", () => {
  test("DSGVO-06 removes container log lines older than 90 days and deletes fully expired rotated files", () => {
    const d = tmp();
    const log = join(d, "c-json.log");
    writeFileSync(log, line("2026-06-01T10:00:00.123456789Z", 'old "time":"2020"') + line("2026-08-01T10:00:00.1Z"));
    writeFileSync(`${log}.1`, line("2026-05-01T00:00:00Z"));
    writeFileSync(`${log}.2`, line("2026-07-01T00:00:00Z") + line("2026-07-20T00:00:00Z"));
    const r = run("log-retention.sh", [log], { LOG_RETENTION_NOW: NOW });
    expect(r.status).toBe(0);
    expect(readFileSync(log, "utf8")).toBe(line("2026-08-01T10:00:00.1Z"));
    expect(existsSync(`${log}.1`)).toBe(false);
    expect(existsSync(`${log}.2`)).toBe(true); // newest line is within 90 days
  });

  test("DSGVO-06 refuses a retention above 90 days", () => {
    const r = run("log-retention.sh", ["/dev/null"], { LOG_RETENTION_DAYS: "120" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/90-day limit/);
  });
});

describe("ops-check.sh (DSGVO-05, DSGVO-06, SEC-05) — deployed stack only", () => {
  test("DSGVO-06 log-age fails when the oldest line is older than 90 days", () => {
    const d = tmp();
    writeFileSync(join(d, "ok.log"), line("2026-09-01T00:00:00Z"));
    writeFileSync(join(d, "old.log"), line("2026-06-01T00:00:00Z"));
    const ok = run("ops-check.sh", ["log-age", join(d, "ok.log")], { OPS_CHECK_NOW: NOW });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/^OK log-age .* 41 Tage/);
    const bad = run("ops-check.sh", ["log-age", join(d, "old.log")], { OPS_CHECK_NOW: NOW });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(/^FAIL log-age .*133 Tage/);
  });

  test("DSGVO-05 DSGVO-06 caddy-log: truncated IPs and no credentials pass; a full IP or a Cookie header fails", () => {
    const d = tmp();
    const wrap = (o: unknown) => line("2026-10-11T00:00:00Z", JSON.stringify(o));
    const good = join(d, "good.log");
    writeFileSync(
      good,
      wrap({ request: { remote_ip: "100.64.12.0", client_ip: "100.64.12.0", headers: { "User-Agent": ["x"] } } }) +
        wrap({ request: { remote_ip: "fd7a:115c:a1e0::", headers: {} } }),
    );
    expect(run("ops-check.sh", ["caddy-log", good]).stdout).toMatch(/^OK caddy-log/);
    const ip = join(d, "ip.log");
    writeFileSync(ip, wrap({ request: { remote_ip: "100.64.12.7" } }));
    const r1 = run("ops-check.sh", ["caddy-log", ip]);
    expect(r1.status).toBe(1);
    expect(r1.stdout).toMatch(/ungekürzte IP-Adresse.*100\.64\.12\.7/);
    const cookie = join(d, "cookie.log");
    writeFileSync(cookie, wrap({ request: { remote_ip: "100.64.12.0", headers: { Cookie: ["session=1"] } } }));
    expect(run("ops-check.sh", ["caddy-log", cookie]).stdout).toMatch(/^FAIL caddy-log Header .*Cookie/);
  });

  test("SEC-05 DSGVO-05 r2-endpoint accepts only the EU-jurisdiction endpoint", () => {
    const acct = "0123456789abcdef0123456789abcdef";
    const r = run("ops-check.sh", [
      "r2-endpoint",
      `https://${acct}.eu.r2.cloudflarestorage.com`,
      `https://${acct}.r2.cloudflarestorage.com`,
    ]);
    expect(r.status).toBe(1);
    expect(r.stdout.trim().split("\n")).toEqual([
      expect.stringMatching(/^OK r2-endpoint .*EU-Jurisdiktion/),
      expect.stringMatching(/^FAIL r2-endpoint /),
    ]);
  });

  test("DSGVO-05 disk-types: a dm-crypt layer under the root file system counts as encrypted at rest", () => {
    expect(run("ops-check.sh", ["disk-types"], {}, "lvm\ncrypt\npart\ndisk\n").stdout).toMatch(/^OK disk-encryption/);
    expect(run("ops-check.sh", ["disk-types"], {}, "part\ndisk\n").stdout).toMatch(/^WARN disk-encryption/);
  });

  test("DSGVO-05 DSGVO-06 both scripts are installed and scheduled by bootstrap.sh and pass bash -n", () => {
    for (const s of ["log-retention.sh", "ops-check.sh"]) execFileSync("bash", ["-n", join(dir, s)]);
    const boot = readFileSync(join(dir, "../bootstrap.sh"), "utf8");
    expect(boot).toContain('"log-retention|45 3 * * *|log-retention.sh"');
    expect(boot).toContain('"ops-check|0 6 * * 1|ops-check.sh all"');
    expect(boot).toContain('"$ROOT/deploy/scripts/log-retention.sh" "$ROOT/deploy/scripts/ops-check.sh"');
  });
});
