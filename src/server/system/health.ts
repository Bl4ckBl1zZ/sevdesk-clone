import "server-only";
import { clockSkewCheck } from "@/domain/system/clock";
import {
  type EinvoiceToolsVersions,
  einvoiceToolsCheck,
  HEALTH_CACHE_TTL_MS,
  type HealthCheck,
} from "@/domain/system/health";
import { measureClockOffset } from "./ntp";

export interface HealthReport {
  at: number;
  checks: HealthCheck[];
  einvoiceTools: EinvoiceToolsVersions | null;
  clockOffsetMs: number | null;
}

export interface HealthDeps {
  fetch: typeof fetch;
  clockOffset: () => Promise<number | null>;
  now: () => number;
  env: NodeJS.ProcessEnv;
}

const defaultDeps = (): HealthDeps => ({
  fetch,
  clockOffset: () => measureClockOffset(),
  now: Date.now,
  env: process.env,
});

async function timed(deps: HealthDeps, url: string): Promise<{ status: number; body: unknown; ms: number } | null> {
  const start = deps.now();
  try {
    const res = await deps.fetch(url, { cache: "no-store", signal: AbortSignal.timeout(3_000) });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // plain text (Convex /version)
    }
    return { status: res.status, body, ms: deps.now() - start };
  } catch {
    return null;
  }
}

/**
 * F01 SET-131: Convex, einvoice-tools and clock skew from the web server. Cloudflare Email, R2 and the access
 * probes run as Convex actions on the system/security pages (their credentials live in the Convex env).
 */
export async function runHealthChecks(deps: HealthDeps = defaultDeps()): Promise<HealthReport> {
  const checks: HealthCheck[] = [];
  const convexUrl = deps.env.CONVEX_URL_INTERNAL ?? deps.env.NEXT_PUBLIC_CONVEX_URL;
  if (convexUrl) {
    const r = await timed(deps, `${convexUrl.replace(/\/$/, "")}/version`);
    checks.push(
      r && r.status === 200
        ? {
            id: "convex",
            label: "Datenbank (Convex)",
            status: "ok",
            latencyMs: r.ms,
            detail: `Backend ${String(r.body).slice(0, 60)}`,
          }
        : {
            id: "convex",
            label: "Datenbank (Convex)",
            status: "error",
            detail: r ? `HTTP ${r.status}` : "Nicht erreichbar.",
          },
    );
  } else {
    checks.push({ id: "convex", label: "Datenbank (Convex)", status: "error", detail: "CONVEX_URL_INTERNAL fehlt." });
  }
  let einvoiceTools: EinvoiceToolsVersions | null = null;
  const toolsUrl = deps.env.EINVOICE_TOOLS_URL;
  if (toolsUrl) {
    const r = await timed(deps, `${toolsUrl.replace(/\/$/, "")}/health`);
    const evaluated = einvoiceToolsCheck(r?.status ?? null, r?.body ?? null, r?.ms ?? null);
    checks.push(evaluated.check);
    einvoiceTools = evaluated.versions;
  } else {
    checks.push({
      id: "einvoice-tools",
      label: "E-Rechnung-Validator",
      status: "unknown",
      detail: "EINVOICE_TOOLS_URL nicht gesetzt.",
    });
  }
  const offset = await deps.clockOffset();
  checks.push({ id: "clock", label: "Uhrzeit (NTP)", ...clockSkewCheck(offset) });
  return { at: deps.now(), checks, einvoiceTools, clockOffsetMs: offset };
}

let cache:
  | { report: HealthReport; promise?: undefined }
  | { report?: undefined; promise: Promise<HealthReport> }
  | null = null;

/** Cached for 60 s (SET-131); concurrent callers share one run. */
export async function cachedHealth(deps: HealthDeps = defaultDeps()): Promise<HealthReport> {
  if (cache?.report && deps.now() - cache.report.at < HEALTH_CACHE_TTL_MS) return cache.report;
  if (cache?.promise) return cache.promise;
  const promise = runHealthChecks(deps).then((report) => {
    cache = { report };
    return report;
  });
  cache = { promise };
  return promise;
}

export function resetHealthCache(): void {
  cache = null;
}
