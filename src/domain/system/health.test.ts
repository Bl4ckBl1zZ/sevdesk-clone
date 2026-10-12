import { describe, expect, test } from "vitest";
import {
  certificateCheck,
  einvoiceToolsCheck,
  HEALTH_CACHE_TTL_MS,
  overallStatus,
  publicHealthBody,
  restoreDrillStatus,
} from "./health";

const NOW = Date.UTC(2026, 9, 12, 10);
const DAY = 86_400_000;

describe("SET-131 health checks", () => {
  test("SET-131 results are cached for 60 s; the public body stays minimal (status + version)", () => {
    expect(HEALTH_CACHE_TTL_MS).toBe(60_000);
    expect(publicHealthBody([{ id: "convex", label: "Convex", status: "ok" }], "1.2.3")).toEqual({
      status: "ok",
      version: "1.2.3",
    });
    expect(
      publicHealthBody(
        [{ id: "convex", label: "Convex", status: "error", detail: "intern: 10.0.0.3 refused" }],
        "1.2.3",
      ),
    ).toEqual({ status: "degraded", version: "1.2.3" });
  });

  test("SET-131 overall status: any error → error, any warning → warning, unknown alone does not degrade", () => {
    expect(overallStatus([{ status: "ok" }, { status: "unknown" }])).toBe("ok");
    expect(overallStatus([{ status: "ok" }, { status: "warning" }])).toBe("warning");
    expect(overallStatus([{ status: "warning" }, { status: "error" }])).toBe("error");
  });

  test("SET-130 SET-131 einvoice-tools: versions from /health (KoSIT, XRechnung bundle, Mustang); 503 is an error", () => {
    const body = {
      status: "ok",
      version: "2026-08-31-1",
      kosit: { status: "up", version: "1.5.2" },
      xrechnungConfig: "2026-07-31",
      mustang: "2.16.4",
    };
    expect(einvoiceToolsCheck(200, body, 35)).toEqual({
      check: {
        id: "einvoice-tools",
        label: "E-Rechnung-Validator",
        status: "ok",
        latencyMs: 35,
        detail: "KoSIT 1.5.2 · XRechnung-Konfiguration 2026-07-31 · Mustang 2.16.4",
      },
      versions: { tools: "2026-08-31-1", kosit: "1.5.2", xrechnungConfig: "2026-07-31", mustang: "2.16.4" },
    });
    expect(einvoiceToolsCheck(503, { ...body, kosit: { status: "down", version: "1.5.2" } }, 12).check).toMatchObject({
      status: "error",
      detail: "KoSIT-Validator nicht bereit.",
    });
    expect(einvoiceToolsCheck(null, null, null).check).toMatchObject({ status: "error", detail: "Nicht erreichbar." });
  });

  test("SET-131 EC-185 the wildcard certificate must be valid for more than 14 days", () => {
    expect(certificateCheck(NOW + 30 * DAY, NOW)).toMatchObject({
      status: "ok",
      detail: "Gültig bis 11.11.2026 (30 Tage).",
    });
    expect(certificateCheck(NOW + 10 * DAY, NOW)).toMatchObject({ status: "warning" });
    expect(certificateCheck(NOW - DAY, NOW)).toMatchObject({ status: "error", detail: "Zertifikat abgelaufen." });
    expect(certificateCheck(null, NOW)).toMatchObject({ status: "unknown" });
  });
});

describe("SET-135 SEC-05 restore drill reminder", () => {
  test("SET-135 SEC-05 a restore drill is due 31 days after the last one (or when none was recorded)", () => {
    expect(restoreDrillStatus(undefined, "2026-10-12")).toMatchObject({
      due: true,
      message: "Noch keine Wiederherstellungsprobe erfasst.",
    });
    expect(restoreDrillStatus("2026-09-20", "2026-10-12")).toMatchObject({ due: false, nextDueOn: "2026-10-21" });
    expect(restoreDrillStatus("2026-09-10", "2026-10-12")).toMatchObject({
      due: true,
      message: "Letzte Wiederherstellungsprobe am 10.09.2026 — die monatliche Probe ist fällig.",
    });
  });
});
