import { BUYERS, makeContact, makeContext, makeDraft, serviceLine } from "@test/factories/documents";
import { describe, expect, test } from "vitest";
import { buildSnapshot } from "./build-snapshot";
import {
  buildSnapshotInput,
  dueDateFor,
  htmlToPlainText,
  numberPeriodOf,
  retentionClassFor,
  retentionUntil,
} from "./finalize";
import { validateDocument } from "./validate";

function finalSnapshot(draft = makeDraft(), ctx = makeContext(), number = "RE-2026-0042", documentDate = "2026-10-12") {
  const v = validateDocument(draft, ctx);
  const input = buildSnapshotInput(draft, ctx, v.resolved, {
    number,
    documentDate,
    layoutVersionId: "layout-v1",
    plan: v.einvoice,
  });
  const s = buildSnapshot(input);
  if (!s.ok) throw new Error(s.error.code);
  return s.value;
}

describe("finalisation helpers (F04 §4.6)", () => {
  test("DOC-40 T-DOC-026 invoices keep 8 years, quotes 6 years, until 31.12.", () => {
    expect(retentionClassFor("invoice")).toBe("vouchers8");
    expect(retentionUntil("invoice", "2026-03-15")).toBe("2034-12-31");
    expect(retentionClassFor("quote")).toBe("letters6");
    expect(retentionUntil("quote", "2026-03-15")).toBe("2032-12-31");
  });

  test("DOC-50 due date = document date + due days; DOC-25 the period key is the Berlin document month", () => {
    expect(dueDateFor("2026-10-12", 14)).toBe("2026-10-26");
    expect(dueDateFor("2026-12-31", 0)).toBe("2026-12-31");
    expect(numberPeriodOf("2026-10-12")).toBe("2026-10");
  });

  test("DOC-27 the snapshot is built from the resolved draft: rates with rule rows, frozen buyer and seller", () => {
    const s = finalSnapshot();
    expect(s.number).toBe("RE-2026-0042");
    expect(s.documentDate).toBe("2026-10-12");
    expect(s.dueDate).toBe("2026-10-26");
    expect(s.taxCase).toBe("domestic");
    expect(s.totals.grossCents).toBe(113_050);
    expect(s.lines[0]).toMatchObject({ vatCategory: "S", vatRateBp: 1900, vatRuleRowId: "standard@2021-01-01" });
    expect(s.ruleVersions["vat:standard"]).toBe("standard@2021-01-01");
    expect(s.seller.kleinunternehmer).toBe(false);
    expect(s.seller.vatAccounting).toBe("soll");
    expect(s.buyer.name).toBe("Beispiel Kunde GmbH");
    expect(s.einvoice).toEqual({ format: "zugferd_en16931", decision: "PDF_NEEDS_CONSENT" });
  });

  test("DOC-21 T-DOC-016 „Leistungsdatum = Rechnungsdatum“ is resolved to the document date", () => {
    const s = finalSnapshot(makeDraft({ supplyDateMode: "document_date", supplyDate: undefined }));
    expect(s.supplyDate).toEqual({ kind: "date", date: "2026-10-12" });
    expect(s.supplyDateIsDocumentDate).toBe(true);
  });

  test("DOC-17 SET-084 placeholders are resolved and frozen as plain text", () => {
    const s = finalSnapshot(
      makeDraft({
        subject: "{{document.typeLabel}} {{document.number}}",
        headText: "<p>Guten Tag {{contact.name}},</p><p>vielen Dank &amp; viele Grüße</p>",
      }),
    );
    expect(s.texts.subject).toBe("Rechnung RE-2026-0042");
    expect(s.texts.headText).toBe("Guten Tag Beispiel Kunde GmbH,\nvielen Dank & viele Grüße");
    expect(htmlToPlainText("<ul><li>a</li><li>b</li></ul>")).toBe("• a\n• b");
  });

  test("KU-02 INV-24 a KU invoice freezes the KU seller flag, category KU and no VAT", () => {
    const ctx = makeContext({}, { kleinunternehmer: [{ validFrom: "2025-01-01", isKU: true }], priorYearTurnover: [] });
    const s = finalSnapshot(makeDraft(), ctx);
    expect(s.seller.kleinunternehmer).toBe(true);
    expect(s.taxCase).toBe("kleinunternehmer");
    expect(s.totals.vatCents).toBe(0);
    expect(s.notes.map((n) => n.id)).toContain("ku_note_19");
    expect(s.einvoice.format).toBe("none");
  });

  test("UST-22 INV-29 a §13b invoice carries the rc_13b note and the buyer register number", () => {
    const ctx = makeContext({ contact: makeContact({ buyer: BUYERS.construction, vatId: undefined }) });
    const s = finalSnapshot(
      makeDraft({ lines: [serviceLine({ name: "Elektroinstallation Neubau", reverseCharge13b: "construction" })] }),
      ctx,
    );
    expect(s.taxCase).toBe("reverse_charge_13b");
    expect(s.lines[0]).toMatchObject({ vatCategory: "AE", vatRateBp: 0 });
    expect(s.notes.map((n) => n.id)).toContain("rc_13b");
    expect(s.buyer.registerNumber).toBe("HRB 724111");
  });
});
