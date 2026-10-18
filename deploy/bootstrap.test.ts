import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * deploy/bootstrap.sh in public edge mode (08 §12), run against a stub `dokploy` CLI: every call is logged, read-only
 * lookups answer from canned JSON, and the script runs in its default dry-run mode (mutations are only printed).
 */
const ROOT = join(import.meta.dirname, "..");
const ZONE = "zone-8u9";
const SECRET_TOKENS = ["CF-API-TOKEN-must-never-print", "TUNNEL-TOKEN-must-never-print"];

interface Stub {
  tunnelStatus?: string;
  composeDomains?: string[];
  extraEnv?: string[];
}

function setup(stub: Stub = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bootstrap-"));
  const answers: Record<string, unknown> = {
    "settings get-dokploy-version": "0.41.1",
    "server all": [{ serverId: "srv1", name: "Proxmox PVE", ipAddress: "100.0.0.1" }],
    "server one": { serverId: "srv1", tunnelStatus: stub.tunnelStatus ?? "healthy", tunnelToken: SECRET_TOKENS[1] },
    "cloudflare get-config": {
      config: { apiToken: SECRET_TOKENS[0] },
      zones: [
        { cloudflareZoneId: "other", zoneName: "example.org" },
        { cloudflareZoneId: ZONE, zoneName: "example.test" },
      ],
    },
    "destination all": [{ destinationId: "dst1", name: "Cloudflare R2 (dokploy)" }],
    "project all": stub.composeDomains
      ? [
          {
            name: "rechnungen",
            projectId: "p1",
            environments: [
              { name: "production", environmentId: "e1", compose: [{ name: "rechnungen", composeId: "c1" }] },
            ],
          },
        ]
      : [],
    "compose one": {
      composeId: "c1",
      appName: "rechnungen-abc",
      domains: (stub.composeDomains ?? []).map((host) => ({ host })),
    },
    "registry all": [],
  };
  for (const [key, value] of Object.entries(answers)) {
    writeFileSync(join(dir, `${key.replace(" ", "_")}.json`), JSON.stringify(value));
  }
  const stubPath = join(dir, "dokploy");
  writeFileSync(
    stubPath,
    `#!/usr/bin/env bash
echo "$*" >> "${dir}/calls.log"
case "$1" in --version) echo stub; exit 0;; esac
for a in "$@"; do [[ "$a" == "--help" ]] && exit 0; done
f="${dir}/$1_$2.json"
[[ -f "$f" ]] && cat "$f" || echo '{}'
`,
  );
  chmodSync(stubPath, 0o755);
  const envFile = join(dir, "env");
  writeFileSync(
    envFile,
    [
      "EDGE_MODE=public",
      "CLOUDFLARE_ZONE_NAME=example.test",
      "BASE_DOMAIN=example.test",
      "OWNER_EMAIL=owner@example.test",
      "IMAGE_REGISTRY=ghcr.io/owner",
      "INSTANCE_NAME=rechnungen",
      `INSTANCE_SECRET=${"a".repeat(64)}`,
      "PG_PASSWORD=pg",
      "APP_ENCRYPTION_KEY=k",
      'JWT_PRIVATE_KEY_PEM="-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----"',
      "CONVEX_DASH_BASIC_AUTH='$2a$14$abc'",
      "CADDY_TAG=sha",
      "WEB_TAG=sha",
      "EIT_TAG=sha",
      ...(stub.extraEnv ?? []),
    ].join("\n"),
  );
  chmodSync(envFile, 0o600);
  const run = (...args: string[]) => {
    const r = spawnSync("bash", [join(ROOT, "deploy/bootstrap.sh"), "--env-file", envFile, ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    let calls = "";
    try {
      calls = readFileSync(join(dir, "calls.log"), "utf8");
    } catch {}
    return { ...r, out: `${r.stdout}\n${r.stderr}`, calls };
  };
  return { run };
}

describe("bootstrap.sh public edge mode (08 §12)", () => {
  test("SEC-01 dry run: no Tailscale lookups, public compose, one Dokploy domain per host → caddy:80 on the zone", () => {
    const r = setup().run("--skip", "compose,convex,backups");
    expect(r.status, r.out).toBe(0);
    expect(r.calls).not.toMatch(/^tailscale/m);
    expect(r.out).toContain(`cloudflare zone example.test = ${ZONE}`);
    for (const host of ["app", "api", "convex", "convex-site", "convex-dash"]) {
      expect(r.out).toMatch(
        new RegExp(
          `dokploy domain create --host ${host}\\.example\\.test --path / --port 80 --serviceName caddy --domainType compose --composeId .+ --certificateType none --cloudflareZoneId ${ZONE} --json`,
        ),
      );
    }
    expect(r.out).not.toMatch(/--https/);
    expect(r.out).not.toMatch(/sync-dns/);
  });

  test("SEC-01 public mode uploads docker-compose.public.yml and keeps DNS/ACME secrets out of the compose env", () => {
    const r = setup().run("--skip", "convex,backups");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("compose file deploy/compose/docker-compose.public.yml");
    const vars = r.out.match(/variables: (.*)/)?.[1] ?? "";
    expect(vars).toContain("CONVEX_DASH_BASIC_AUTH");
    expect(vars).not.toMatch(/CLOUDFLARE_DNS_API_TOKEN|ACME_EMAIL/);
  });

  test("SEC-01 existing domains are not created again (idempotent)", () => {
    const r = setup({ composeDomains: ["app.example.test", "api.example.test"] }).run("--only", "domains");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("domain app.example.test exists");
    expect(r.out.match(/dokploy domain create/g)?.length).toBe(3);
    expect(r.out).toContain("--composeId c1");
  });

  test("SEC-01 an unhealthy Cloudflare tunnel aborts an --apply run before anything is changed", () => {
    const r = setup({ tunnelStatus: "error" }).run("--apply", "--only", "preflight,project");
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/Cloudflare tunnel of "Proxmox PVE" is not healthy/);
    expect(r.calls).not.toMatch(/project create/);
  });

  test("SEC-06 token fields of the Dokploy server and Cloudflare config are never printed", () => {
    const r = setup().run("--skip", "convex,backups");
    for (const secret of SECRET_TOKENS) expect(r.out).not.toContain(secret);
  });
});

describe("bootstrap convex step (08 §5 step 5)", () => {
  test("SET-130 the Convex env (JWKS, SERVER_JWKS, BASE_DOMAIN …) is set before `convex deploy`", () => {
    const pem = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString()
      .trim()
      .replace(/\n/g, "\\n");
    const r = setup({
      extraEnv: [
        "CONVEX_SELF_HOSTED_ADMIN_KEY='rechnungen|abc'",
        "BETTER_AUTH_SECRET=s",
        `JWT_PRIVATE_KEY_PEM="${pem}"`,
      ],
    }).run("--only", "convex");
    expect(r.status).toBe(0);
    const lines = r.out.split("\n");
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    const deploy = at("npx convex deploy --yes");
    expect(deploy).toBeGreaterThan(-1);
    for (const name of [
      "SERVER_JWKS",
      "SITE_URL",
      "BASE_DOMAIN",
      "PASSKEY_RP_ID",
      "OWNER_EMAIL",
      "BETTER_AUTH_SECRET",
    ]) {
      const set = at(`npx convex env set ${name} `);
      expect(set, name).toBeGreaterThan(-1);
      expect(set, name).toBeLessThan(deploy);
    }
    // auth.config.ts reads JWKS at push time too → the static Better Auth key set is generated before the push.
    const jwks = at("scripts/generate-jwks.ts better-auth --set-convex");
    expect(jwks).toBeGreaterThan(-1);
    expect(jwks).toBeLessThan(deploy);
    expect(r.out).not.toContain("auth:rotateKeys");
  });
});
