import { describe, expect, test } from "vitest";
import type { CalendarDate } from "../time/calendar-date";
import { art30Record } from "./art30";
import {
  auskunftReport,
  canTransitionRequest,
  completionIssue,
  DSGVO_MESSAGES,
  dsgvoDueDate,
  erasurePlan,
  extensionIssue,
  maskThirdPartyEmails,
  reminderStage,
  responseTemplate,
} from "./dsgvo";

const d = (s: string) => s as CalendarDate;

describe("DSGVO request register (PRV-010, E-PRV-12…15)", () => {
  test("PRV-010 E-PRV-14 the due date is one month later (last day of a shorter month), moved to the next working day", () => {
    // 31.01.2027 → 28.02.2027 is a Sunday → Monday 01.03.2027 (TST-PRV-11)
    expect(dsgvoDueDate(d("2027-01-31"), "BE")).toBe("2027-03-01");
    expect(dsgvoDueDate(d("2026-03-31"), "BE")).toBe("2026-04-30");
    // 25.11.2026 → 25.12.2026 (Weihnachten) → 28.12.2026 (Monday; 26.12. is a Saturday)
    expect(dsgvoDueDate(d("2026-11-25"), "BE")).toBe("2026-12-28");
    // extension: up to two further months from the receipt (Art. 12 Abs. 3)
    expect(dsgvoDueDate(d("2026-03-31"), "BE", 3)).toBe("2026-06-30");
  });

  test("PRV-010 E-PRV-13 an extension needs a reason, the notice date and at most two further months", () => {
    expect(extensionIssue({ months: 2, reason: "Umfangreich", noticeSentOn: "" })).toBe(DSGVO_MESSAGES.noticeMissing);
    expect(extensionIssue({ months: 2, reason: " ", noticeSentOn: "2026-04-10" })).toBe(DSGVO_MESSAGES.reasonMissing);
    expect(extensionIssue({ months: 3, reason: "x", noticeSentOn: "2026-04-10" })).toBe(
      DSGVO_MESSAGES.extensionTooLong,
    );
    expect(extensionIssue({ months: 1, reason: "Komplex", noticeSentOn: "2026-04-10" })).toBeNull();
  });

  test("PRV-010 the status machine open → in_progress → done/rejected, extended only with an extension", () => {
    expect(canTransitionRequest("open", "in_progress")).toBe(true);
    expect(canTransitionRequest("open", "rejected")).toBe(true);
    expect(canTransitionRequest("in_progress", "extended")).toBe(true);
    expect(canTransitionRequest("extended", "done")).toBe(true);
    expect(canTransitionRequest("done", "in_progress")).toBe(false);
    expect(canTransitionRequest("rejected", "done")).toBe(false);
  });

  test("PRV-010 E-PRV-15 completion needs a verified identity; a rejection needs a reason", () => {
    expect(completionIssue({ to: "done", identityVerified: false })).toBe(DSGVO_MESSAGES.identity);
    expect(completionIssue({ to: "done", identityVerified: true })).toBeNull();
    expect(completionIssue({ to: "rejected", identityVerified: false, rejectionReason: "" })).toBe(
      DSGVO_MESSAGES.rejectionReason,
    );
    expect(
      completionIssue({ to: "rejected", identityVerified: false, rejectionReason: "Identität nicht belegt" }),
    ).toBeNull();
  });

  test("PRV-010 E-PRV-12 reminders at due − 7 and due − 1 days, overdue after the due date", () => {
    expect(reminderStage(d("2026-05-10"), d("2026-05-01"))).toBe("none");
    expect(reminderStage(d("2026-05-10"), d("2026-05-03"))).toBe("due7");
    expect(reminderStage(d("2026-05-10"), d("2026-05-09"))).toBe("due1");
    expect(reminderStage(d("2026-05-10"), d("2026-05-10"))).toBe("due1");
    expect(reminderStage(d("2026-05-10"), d("2026-05-11"))).toBe("overdue");
  });
});

describe("erasure plan (PRV-011, DSGVO-02, CON-162, EC-180)", () => {
  test("DSGVO-02 CON-162 EC-180 E-PRV-09 drafts and notes go now, retained records are restricted, the purge date is the day after the longest retention", () => {
    const plan = erasurePlan({
      deletable: [
        { kind: "activity", id: "a1", label: "Telefonnotiz" },
        { kind: "draft", id: "d1", label: "Entwurf Rechnung" },
        { kind: "customerPrice", id: "p1", label: "Kundenpreis" },
      ],
      retained: [
        {
          kind: "salesDocument",
          id: "s1",
          label: "RE-2024-0001",
          retentionClass: "vouchers8",
          retentionUntil: "2032-12-31",
        },
        {
          kind: "journalEntry",
          id: "j1",
          label: "Buchung 17",
          retentionClass: "books10",
          retentionUntil: "2034-12-31",
        },
      ],
      fields: ["notes", "birthday"],
    });
    expect(plan.deleteNow.map((x) => x.id)).toEqual(["a1", "d1", "p1"]);
    expect(plan.restrict.map((x) => x.id)).toEqual(["s1", "j1"]);
    expect(plan.clearFields).toEqual(["notes", "birthday"]);
    expect(plan.byClass).toEqual({ vouchers8: "2033-01-01", books10: "2035-01-01" });
    expect(plan.scheduledPurgeAt).toBe("2035-01-01");
    expect(plan.deleteContact).toBe(false);
  });

  test("E-PRV-18 a prospect without retained records is deleted completely", () => {
    const plan = erasurePlan({ deletable: [{ kind: "activity", id: "a1", label: "x" }], retained: [], fields: [] });
    expect(plan.deleteContact).toBe(true);
    expect(plan.scheduledPurgeAt).toBeNull();
  });
});

describe("Art. 15 information and templates (PRV-013, PRV-014, DSGVO-03)", () => {
  const record = art30Record({
    controller: { name: "Muster GmbH", address: "Hauptstr. 1, 10115 Berlin", email: "info@muster.test" },
    services: [],
    today: "19.10.2026",
  });

  test("PRV-013 DSGVO-03 auskunft.pdf lists purposes, categories, recipients, retention per class, source and rights", () => {
    const report = auskunftReport({
      record,
      subject: "Erika Mustermann",
      createdAt: Date.UTC(2026, 9, 19, 10),
      counts: { Belege: 3, Zahlungen: 1 },
    });
    const text = JSON.stringify(report);
    for (const s of [
      "Auskunft nach Art. 15 DSGVO",
      "Erika Mustermann",
      "Rechnungsstellung und Angebote",
      "Zwecke",
      "Empfänger",
      "Speicherdauer",
      "Buchungsbelege (8 Jahre)",
      "Herkunft",
      "Recht auf Berichtigung (Art. 16 DSGVO)",
      "Beschwerde bei einer Aufsichtsbehörde",
      "Belege",
    ]) {
      expect(text).toContain(s);
    }
    expect(report.fileName).toBe("auskunft.pdf");
  });

  test("E-PRV-17 third-party e-mail addresses are masked in the access export", () => {
    expect(maskThirdPartyEmails("an erika@kunde.test, cc max@andere.test", ["erika@kunde.test"])).toBe(
      "an erika@kunde.test, cc m***@andere.test",
    );
  });

  test("PRV-014 EC-180 the rectification and erasure templates explain GoBD retention and the Rechnungsberichtigung", () => {
    const rect = responseTemplate("rectification", { name: "Erika Mustermann", company: "Muster GmbH" });
    expect(rect).toContain("bereits ausgestellte Rechnungen bleiben unverändert");
    expect(rect).toContain("Rechnungsberichtigung");
    const erasure = responseTemplate("erasure", {
      name: "Erika Mustermann",
      company: "Muster GmbH",
      purgeDate: "2035-01-01",
    });
    expect(erasure).toContain("Art. 17 Abs. 3 lit. b DSGVO");
    expect(erasure).toContain("01.01.2035");
    expect(erasure).toContain("gesperrt");
  });
});
