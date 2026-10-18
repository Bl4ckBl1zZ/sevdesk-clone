import { describe, expect, test } from "vitest";
import { actorDisplay, describeAuditEntry, recentActivity } from "./describe";

const e = (action: string, label?: string, table = "salesDocuments", id = "x1") => ({
  action,
  entity: { table, id, ...(label ? { label } : {}) },
});

describe("DASH-009 Verlauf lines from audit entries", () => {
  test("DASH-009 business actions become German sentences with the entity label", () => {
    expect(describeAuditEntry(e("document.finalize", "RE-2026-0001"))).toBe("RE-2026-0001 fertiggestellt");
    expect(describeAuditEntry(e("document.mark_sent", "RE-2026-0001"))).toBe("RE-2026-0001 als versendet markiert");
    expect(describeAuditEntry(e("document.cancel", "RE-2026-0001"))).toBe("RE-2026-0001 storniert");
    expect(describeAuditEntry(e("payment.record", "RE-2026-0001", "payments"))).toBe("Zahlung zu RE-2026-0001 erfasst");
    expect(describeAuditEntry(e("contact.create", "Muster GmbH", "contacts"))).toBe("Kontakt Muster GmbH angelegt");
    expect(describeAuditEntry(e("settings.company.update", undefined, "companyProfile"))).toBe(
      "Einstellungen geändert",
    );
  });

  test("DASH-009 draft placeholders are not shown as a label", () => {
    expect(describeAuditEntry(e("document.create_draft", "Entwurf (invoice)"))).toBe("Entwurf angelegt");
    expect(describeAuditEntry(e("document.update_draft", "Entwurf (quote)"))).toBe("Entwurf bearbeitet");
  });

  test("DASH-009 technical entries (pipeline, sign-in, integrity, auditor access) are not part of the Verlauf", () => {
    for (const a of [
      "document.artifacts_ready",
      "auth.sign_in",
      "integrity.run",
      "auditor.access",
      "journal.post",
      "notification.create",
      "unknown.thing",
      "nodot",
    ]) {
      expect(describeAuditEntry(e(a, "RE-1"))).toBeNull();
    }
  });

  test("DASH-009 recentActivity skips technical entries, drops repeats of the same act and keeps 5", () => {
    const rows = [
      { at: 10, actor: "user:u1", actorRole: "owner", ...e("payment.record", "RE-1", "payments", "p1") },
      { at: 9, actor: "user:u1", actorRole: "owner", ...e("payment.record", "RE-1", "payments", "p1") },
      { at: 8, actor: "system:documents.pipeline", ...e("document.artifacts_ready", "RE-1") },
      { at: 7, actor: "user:u1", actorRole: "owner", ...e("document.finalize", "RE-1") },
      { at: 6, actor: "api-key:k1", ...e("contact.create", "Muster GmbH", "contacts", "c1") },
      { at: 5, actor: "mcp:k2", ...e("contact.update", "Muster GmbH", "contacts", "c1") },
      { at: 4, actor: "system:cron.dunning.run", ...e("dunning.reminder.finalize", "MA-1", "salesDocuments", "m1") },
      { at: 3, actor: "user:u2", actorRole: "bookkeeper", ...e("product.create", "Beratung", "products", "pr1") },
    ];
    const r = recentActivity(rows);
    expect(r.map((x) => x.text)).toEqual([
      "Zahlung zu RE-1 erfasst",
      "RE-1 fertiggestellt",
      "Kontakt Muster GmbH angelegt",
      "Kontakt Muster GmbH geändert",
      "Mahnung MA-1 fertiggestellt",
    ]);
    expect(r[0]).toEqual({ at: 10, text: "Zahlung zu RE-1 erfasst", by: "Inhaber" });
    expect(r.map((x) => x.by)).toEqual(["Inhaber", "Inhaber", "API", "KI-Assistent (MCP)", "System"]);
  });

  test("DASH-009 actor display without personal data: role label or channel", () => {
    expect(actorDisplay("user:abc", "bookkeeper")).toBe("Buchhaltung");
    expect(actorDisplay("user:abc", undefined)).toBe("Benutzer");
    expect(actorDisplay("system:cron.integrity.verify")).toBe("System");
  });
});
