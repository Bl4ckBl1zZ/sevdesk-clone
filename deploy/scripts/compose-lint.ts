/**
 * Rules for the production compose file (08 §1, §3.1; SEC-01 "reachable only inside the tailnet").
 *
 * The owner's Dokploy fork publishes every compose service that declares `ports:` or `expose:` as a Tailscale
 * Service. A stray `expose` on `backend` or `postgres` would put Convex or the database on the tailnet next to the
 * TLS edge, so the file is linted in CI (`pnpm lint:deploy`).
 */

export interface Violation {
  service: string | null;
  rule: string;
  message: string;
}

type Dict = Record<string, unknown>;

const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);

/** The single service allowed to be published, and exactly the ports it must expose (02 §4.1). */
export const EDGE_SERVICE = "caddy";
export const EDGE_PORTS = ["443", "8443"];

/** Convex backend flags that are switched on by ANY non-empty value (08 §3.1 notes). */
export const CONVEX_TRUTHY_FLAGS = ["DO_NOT_REQUIRE_SSL", "REDACT_LOGS_TO_CLIENT", "DISABLE_BEACON"];
const FALSY_LOOKING = /^(|0|false|no|off|n|f)$/i;

/** Log drivers that rotate locally (DSGVO-06: max-size/max-file; the age limit is log-retention.sh). */
export const ROTATING_LOG_DRIVERS = ["json-file", "local"];

/** Variables that must never reach production (08 §5.2: `IS_TEST` — never in production). */
export const FORBIDDEN_ENV = ["IS_TEST"];

function envOf(service: Dict): Map<string, string> {
  const env = new Map<string, string>();
  const raw = service.environment;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const s = String(entry);
      const i = s.indexOf("=");
      env.set(i === -1 ? s : s.slice(0, i), i === -1 ? "" : s.slice(i + 1));
    }
  } else if (isDict(raw)) {
    for (const [k, v] of Object.entries(raw)) env.set(k, v === null || v === undefined ? "" : String(v));
  }
  return env;
}

function portList(value: unknown): string[] {
  if (!Array.isArray(value)) return value === undefined ? [] : [String(value)];
  return value.map((p) => (isDict(p) ? String(p.target ?? "") : String(p)));
}

function imageTag(image: string): string | null {
  const at = image.indexOf("@");
  if (at !== -1) return image.slice(at + 1);
  const lastSlash = image.lastIndexOf("/");
  const colon = image.indexOf(":", lastSlash + 1);
  return colon === -1 ? null : image.slice(colon + 1);
}

export function lintCompose(doc: unknown): Violation[] {
  const out: Violation[] = [];
  const add = (service: string | null, rule: string, message: string) => out.push({ service, rule, message });

  if (!isDict(doc) || !isDict(doc.services)) {
    add(null, "structure", "compose file has no `services` mapping");
    return out;
  }
  const services = doc.services;

  for (const [name, svc] of Object.entries(services)) {
    if (!isDict(svc)) continue;
    const hasPorts = svc.ports !== undefined;
    const hasExpose = svc.expose !== undefined;

    if (name !== EDGE_SERVICE && (hasPorts || hasExpose)) {
      add(
        name,
        "only-edge-published",
        `declares ${hasPorts ? "`ports`" : "`expose`"} — the Dokploy fork would publish it to the tailnet; only \`${EDGE_SERVICE}\` may (08 §3.1)`,
      );
    }
    if (name === EDGE_SERVICE && hasPorts) {
      add(name, "edge-no-host-ports", "must use `expose`, never `ports` (would also bind host ports, 08 §1)");
    }
    if (svc.network_mode === "host") add(name, "no-host-network", "`network_mode: host` bypasses the compose network");
    if (svc.privileged === true) add(name, "no-privileged", "`privileged: true` is not allowed");
    if (svc.build !== undefined)
      add(name, "no-build", "production services use prebuilt images (CI builds them, 08 §6)");

    const image = typeof svc.image === "string" ? svc.image : "";
    if (!image) add(name, "image-required", "every service needs an `image`");
    else {
      const tag = imageTag(image);
      if (!tag || tag === "latest")
        add(name, "image-pinned", `image \`${image}\` must be pinned (no implicit/latest tag)`);
    }

    const logging = isDict(svc.logging) ? svc.logging : undefined;
    const logOptions = logging && isDict(logging.options) ? logging.options : {};
    if (
      !logging ||
      !ROTATING_LOG_DRIVERS.includes(String(logging.driver ?? "")) ||
      !logOptions["max-size"] ||
      !logOptions["max-file"]
    ) {
      add(
        name,
        "log-rotation",
        "needs `logging: *logging` (json-file/local with max-size and max-file) — technical logs rotate (DSGVO-06)",
      );
    }

    const env = envOf(svc);
    for (const flag of CONVEX_TRUTHY_FLAGS) {
      const v = env.get(flag);
      if (v !== undefined && FALSY_LOOKING.test(v.trim())) {
        add(name, "convex-truthy-flag", `${flag}=${v} — any non-empty value ENABLES it; remove the line instead`);
      }
    }
    for (const key of FORBIDDEN_ENV) {
      if (env.has(key)) add(name, "forbidden-env", `${key} must never be set in production`);
    }
  }

  const edge = services[EDGE_SERVICE];
  if (!isDict(edge)) add(EDGE_SERVICE, "edge-present", `the TLS edge service \`${EDGE_SERVICE}\` is missing`);
  else {
    const exposed = portList(edge.expose).sort();
    if (JSON.stringify(exposed) !== JSON.stringify([...EDGE_PORTS].sort())) {
      add(
        EDGE_SERVICE,
        "edge-ports",
        `must expose exactly ${EDGE_PORTS.join(" and ")} (found: ${exposed.join(", ") || "none"})`,
      );
    }
  }

  const backend = services.backend;
  const dashboard = services.dashboard;
  if (isDict(backend) && isDict(dashboard)) {
    const a = imageTag(String(backend.image ?? ""));
    const b = imageTag(String(dashboard.image ?? ""));
    if (a !== b) add("dashboard", "convex-same-sha", `dashboard tag ${b} differs from backend tag ${a} (08 §3.1)`);
  }
  return out;
}
