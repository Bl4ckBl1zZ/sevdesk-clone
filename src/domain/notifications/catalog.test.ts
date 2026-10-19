import { describe, expect, test } from "vitest";
import {
  channelsFor,
  checkChannelChange,
  dedupeKeyFor,
  escalationDue,
  kindDef,
  NOTIFICATION_KINDS,
  NTF02_MESSAGE,
  notificationMail,
  ntfyMessage,
  ntfyPriority,
  purgeDue,
} from "./catalog";

const DAY = 24 * 60 * 60 * 1000;

describe("notification catalog (F12 §4.8, NTF-001…006)", () => {
  test("NTF-002 the §4.8 kinds carry their default severity and channels", () => {
    expect(NOTIFICATION_KINDS["integrity.failed"]).toMatchObject({
      severity: "critical",
      channels: { inApp: true, email: true, ntfy: true },
    });
    expect(NOTIFICATION_KINDS["backup.stale"]).toMatchObject({
      severity: "error",
      channels: { email: true, ntfy: true },
    });
    expect(NOTIFICATION_KINDS["deadline.ustva"]).toMatchObject({
      severity: "warning",
      channels: { inApp: true, email: false, ntfy: true, digest: true },
    });
    expect(NOTIFICATION_KINDS["threshold.ku"].channels).toEqual({
      inApp: true,
      email: false,
      ntfy: false,
      digest: true,
    });
    expect(NOTIFICATION_KINDS["payment.received"]).toMatchObject({
      severity: "info",
      channels: { inApp: true, ntfy: false },
    });
    expect(kindDef("artifacts_blocked")?.severity).toBe("error");
    expect(kindDef("exported_not_marked")).toBeNull();
    expect(channelsFor("exported_not_marked", "info")).toEqual({
      inApp: true,
      email: false,
      ntfy: false,
      digest: false,
    });
  });

  test("NTF-002 critical kinds cannot be disabled for in-app and e-mail (E-NTF-02); others follow the matrix", () => {
    const off = { inApp: false, email: false, ntfy: false, digest: false };
    expect(checkChannelChange("integrity.failed", off)).toEqual({ ok: false, error: NTF02_MESSAGE });
    expect(NTF02_MESSAGE).toBe("Kritische Meldungen können nicht abbestellt werden.");
    expect(checkChannelChange("integrity.failed", { ...off, inApp: true, email: true })).toEqual({ ok: true });
    expect(checkChannelChange("backup.stale", off)).toEqual({ ok: true });
    expect(checkChannelChange("gibt.es.nicht", off).ok).toBe(false);
    // a tampered matrix row still cannot silence a critical kind
    expect(channelsFor("integrity.failed", "critical", { "integrity.failed": off })).toMatchObject({
      inApp: true,
      email: true,
      ntfy: false,
    });
    expect(channelsFor("backup.stale", "error", { "backup.stale": off })).toEqual(off);
  });

  test("NTF-001 the dedupe key is kind + entity + day", () => {
    expect(dedupeKeyFor("payment.received", { table: "payments", id: "p1" }, "2026-10-19")).toBe(
      "payment.received|payments:p1|2026-10-19",
    );
    expect(dedupeKeyFor("backup.stale", undefined, "2026-10-19")).toBe("backup.stale|-|2026-10-19");
  });

  test("NTF-006 an unresolved error is escalated once after 24 h; NTF-001 read notifications are purged after 90 days", () => {
    const n = { severity: "error" as const, createdAt: 0 };
    expect(escalationDue(n, DAY - 1)).toBe(false);
    expect(escalationDue(n, DAY)).toBe(true);
    expect(escalationDue({ ...n, escalatedAt: DAY }, 2 * DAY)).toBe(false);
    expect(escalationDue({ ...n, resolvedAt: 10 }, 2 * DAY)).toBe(false);
    expect(escalationDue({ ...n, severity: "warning" }, 2 * DAY)).toBe(false);
    expect(purgeDue({}, 1000 * DAY)).toBe(false);
    expect(purgeDue({ readAt: 0 }, 89 * DAY)).toBe(false);
    expect(purgeDue({ readAt: 0 }, 90 * DAY)).toBe(true);
  });

  test("NTF-004 DSGVO-05 ntfy payloads are data-minimal by default and use the priority mapping", () => {
    expect([ntfyPriority("critical"), ntfyPriority("error"), ntfyPriority("warning")]).toEqual([5, 4, 3]);
    const accepted = {
      kind: "quote.accepted",
      severity: "info" as const,
      title: "Angebot AN-1001 von Müller GmbH über 1.190,00 € angenommen",
      body: "Müller GmbH hat angenommen.",
      link: "/angebote/abc",
    };
    const minimal = ntfyMessage(accepted, { topic: "firma", sendDetails: false, appUrl: "https://app.example.org" });
    expect(minimal).toEqual({
      topic: "firma",
      title: "Angebot angenommen – Details in der App",
      message: "Angebot angenommen – Details in der App",
      priority: 3,
      click: "https://app.example.org/angebote/abc",
    });
    expect(JSON.stringify(minimal)).not.toMatch(/Müller|1\.190/);
    const detailed = ntfyMessage(accepted, { topic: "firma", sendDetails: true });
    expect(detailed.title).toContain("Müller GmbH");
    expect(detailed.click).toBeUndefined();
  });

  test("NTF-003 the e-mail has the subject „[{Firma}] {Titel}“, a minimal body and the app link", () => {
    const mail = notificationMail(
      {
        kind: "integrity.failed",
        severity: "critical",
        title: "Integritätsprüfung fehlgeschlagen: seq 17",
        link: "/einstellungen/system/integritaet",
      },
      { companyName: "Muster GmbH", sendDetails: false, appUrl: "https://app.example.org/" },
    );
    expect(mail.subject).toBe("[Muster GmbH] Integritätsprüfung fehlgeschlagen – Details in der App");
    expect(mail.text).toContain("Öffnen: https://app.example.org/einstellungen/system/integritaet");
    expect(mail.text).not.toContain("seq 17");
  });
});
