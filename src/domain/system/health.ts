/**
 * Health and system status (F01 SET-130/131/135). Pure evaluation; the probes run in src/server/health.ts (web) and
 * in Convex actions. GET /api/health exposes only `{ status, version }` (02 §11); details are shown to signed-in
 * members on /einstellungen/system.
 */
import { addDays, type CalendarDate, formatGermanDate, toEpochDay } from "../time/calendar-date";

export type CheckStatus = "ok" | "warning" | "error" | "unknown";

export interface HealthCheck {
  id: string;
  label: string;
  status: CheckStatus;
  latencyMs?: number;
  detail?: string;
}

export const HEALTH_CACHE_TTL_MS = 60_000;

export function overallStatus(checks: readonly { status: CheckStatus }[]): "ok" | "warning" | "error" {
  if (checks.some((c) => c.status === "error")) return "error";
  if (checks.some((c) => c.status === "warning")) return "warning";
  return "ok";
}

/** 02 §11: the public body never contains details (hosts, errors, versions of components). */
export function publicHealthBody(
  checks: readonly HealthCheck[],
  version: string,
): { status: "ok" | "degraded"; version: string } {
  return { status: overallStatus(checks) === "error" ? "degraded" : "ok", version };
}

export interface EinvoiceToolsVersions {
  tools: string;
  kosit: string;
  xrechnungConfig: string;
  mustang: string;
}

/** einvoice-tools `GET /health` (services/einvoice-tools/src/server.ts) → check + versions for SET-130. */
export function einvoiceToolsCheck(
  httpStatus: number | null,
  body: unknown,
  latencyMs: number | null,
): { check: HealthCheck; versions: EinvoiceToolsVersions | null } {
  const base = { id: "einvoice-tools", label: "E-Rechnung-Validator" };
  if (httpStatus === null || typeof body !== "object" || body === null) {
    return { check: { ...base, status: "error", detail: "Nicht erreichbar." }, versions: null };
  }
  const b = body as {
    version?: string;
    kosit?: { status?: string; version?: string };
    xrechnungConfig?: string;
    mustang?: string;
  };
  const versions = {
    tools: b.version ?? "?",
    kosit: b.kosit?.version ?? "?",
    xrechnungConfig: b.xrechnungConfig ?? "?",
    mustang: b.mustang ?? "?",
  };
  const latency = latencyMs === null ? {} : { latencyMs };
  if (httpStatus !== 200 || b.kosit?.status !== "up") {
    return { check: { ...base, status: "error", ...latency, detail: "KoSIT-Validator nicht bereit." }, versions };
  }
  return {
    check: {
      ...base,
      status: "ok",
      ...latency,
      detail: `KoSIT ${versions.kosit} · XRechnung-Konfiguration ${versions.xrechnungConfig} · Mustang ${versions.mustang}`,
    },
    versions,
  };
}

const DAY_MS = 86_400_000;
export const CERT_MIN_DAYS = 14;

/** EC-185: wildcard certificate validity (> 14 days). `validTo`/`now` in ms. */
export function certificateCheck(validTo: number | null, now: number): HealthCheck {
  const base = { id: "certificate", label: "Wildcard-Zertifikat" };
  if (validTo === null) return { ...base, status: "unknown", detail: "Nur auf dem Server prüfbar." };
  const days = Math.floor((validTo - now) / DAY_MS);
  if (days < 0) return { ...base, status: "error", detail: "Zertifikat abgelaufen." };
  const until = new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Berlin",
  }).format(validTo);
  if (days <= CERT_MIN_DAYS) {
    return { ...base, status: "warning", detail: `Läuft am ${until} ab (${days} Tage). Erneuerung prüfen.` };
  }
  return { ...base, status: "ok", detail: `Gültig bis ${until} (${days} Tage).` };
}

export const RESTORE_DRILL_INTERVAL_DAYS = 31;

/** SET-135 / SEC-05: monthly restore drill reminder. */
export function restoreDrillStatus(
  lastDrillOn: string | undefined,
  today: string,
): { due: boolean; nextDueOn: string | null; message: string } {
  if (!lastDrillOn) return { due: true, nextDueOn: null, message: "Noch keine Wiederherstellungsprobe erfasst." };
  const next = addDays(lastDrillOn as CalendarDate, RESTORE_DRILL_INTERVAL_DAYS);
  const due = toEpochDay(today as CalendarDate) >= toEpochDay(next);
  return {
    due,
    nextDueOn: next,
    message: due
      ? `Letzte Wiederherstellungsprobe am ${formatGermanDate(lastDrillOn as CalendarDate)} — die monatliche Probe ist fällig.`
      : `Letzte Wiederherstellungsprobe am ${formatGermanDate(lastDrillOn as CalendarDate)}; nächste bis ${formatGermanDate(next)}.`,
  };
}
