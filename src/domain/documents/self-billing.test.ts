import { BUYERS, makeContact, makeContext, makeDraft, TODAY } from "@test/factories/documents";
import { makeSnapshot, SELLERS, BUYERS as SNAPSHOT_BUYERS } from "@test/factories/snapshot";
import { describe, expect, test } from "vitest";
import { invoiceTypeCode } from "../einvoice/type-code";
import { seedRange } from "../numbering/format";
import { lookupNoteText } from "../rules/note-texts";
import { DOC_TYPE_LABEL_DE } from "./doc-types";
import {
  agreementIssues,
  agreementValidOn,
  OBJECTION_MESSAGES,
  objectionIssue,
  selfBillingAgreementMissingMessage,
  selfBillingVoucherInput,
} from "./self-billing";
import { validateDocument } from "./validate";

const AGREEMENT = { agreedOn: "2026-01-02", scope: "Provisionsabrechnungen", validFrom: "2026-01-01" };
const codes = (agreement?: typeof AGREEMENT & { validTo?: string }) =>
  validateDocument(
    makeDraft({ type: "self_billing", documentDate: TODAY }),
    makeContext({ contact: makeContact(agreement ? { selfBillingAgreement: agreement } : {}) }),
  ).findings;

describe("self-billing Gutschrift (F04 §4.9, INV-16; UST-11, UST-33)", () => {
  test("INV-16 UST-33 T-EC-103 EC-DOC-103 without a valid agreement a Gutschrift is blocked with the § 14 Abs. 2 message", () => {
    const missing = codes().find((f) => f.code === "self_billing_agreement_missing");
    expect(missing).toMatchObject({
      severity: "E",
      rule: "UST-33",
      message: `Mit ${BUYERS.b2b.name} ist keine gültige Gutschriftsvereinbarung hinterlegt (§ 14 Abs. 2 UStG).`,
    });
    expect(codes(AGREEMENT).some((f) => f.code === "self_billing_agreement_missing")).toBe(false);
    // expired before the document date
    expect(
      codes({ ...AGREEMENT, validTo: "2026-06-30" }).some((f) => f.code === "self_billing_agreement_missing"),
    ).toBe(true);
    // other types are not affected
    const inv = validateDocument(makeDraft({ type: "invoice" }), makeContext()).findings;
    expect(inv.some((f) => f.code === "self_billing_agreement_missing")).toBe(false);
  });

  test("INV-16 an agreement is valid from validFrom (and its signing) to validTo inclusive and needs a scope", () => {
    expect(agreementValidOn(AGREEMENT, "2026-01-01")).toBe(false); // agreed on 02.01.
    expect(agreementValidOn(AGREEMENT, "2026-01-02")).toBe(true);
    expect(agreementValidOn({ ...AGREEMENT, validTo: "2026-12-31" }, "2026-12-31")).toBe(true);
    expect(agreementValidOn({ ...AGREEMENT, validTo: "2026-12-31" }, "2027-01-01")).toBe(false);
    expect(agreementValidOn({ ...AGREEMENT, scope: " " }, "2026-05-01")).toBe(false);
    expect(agreementValidOn(undefined, "2026-05-01")).toBe(false);
    expect(agreementIssues({ ...AGREEMENT, scope: "", validTo: "2025-12-31" })).toEqual([
      "Das Enddatum liegt vor dem Beginn.",
      "Bitte den Umfang der Vereinbarung beschreiben (z. B. Provisionsabrechnungen).",
    ]);
    expect(selfBillingAgreementMissingMessage("Agentur Nord")).toBe(
      "Mit Agentur Nord ist keine gültige Gutschriftsvereinbarung hinterlegt (§ 14 Abs. 2 UStG).",
    );
  });

  test("UST-11 title „Gutschrift“, TypeCode 389, own GS- range and the § 14 Abs. 2 Satz 2 note", () => {
    expect(DOC_TYPE_LABEL_DE.self_billing).toBe("Gutschrift");
    expect(invoiceTypeCode({ type: "self_billing" })).toBe("389");
    expect(seedRange("self_billing")).toMatchObject({ format: "GS-{YYYY}-{####}", docTypes: ["self_billing"] });
    const note = lookupNoteText("sb_info", TODAY);
    expect(note.ok && note.value.value.de).toBe(
      "Gutschrift (Abrechnung durch den Leistungsempfänger, § 14 Abs. 2 Satz 2 UStG).",
    );
    expect(makeSnapshot({ type: "self_billing" }).notes.map((n) => n.id)).toContain("sb_info");
  });

  test("INV-16 the purchase voucher: one net line per VAT group, stated gross, supplier data of the seller block", () => {
    const s = makeSnapshot({
      type: "self_billing",
      number: "GS-2026-0001",
      seller: SELLERS.agency,
      buyer: SNAPSHOT_BUYERS.b2b,
    });
    const v = selfBillingVoucherInput(s, "3100");
    expect(v).toMatchObject({
      direction: "expense",
      supplierName: "Agentur Nord GmbH",
      supplierVatId: "DE136695976",
      supplierAddress: "Speicherstadt 4, 20457 Hamburg",
      documentNumber: "GS-2026-0001",
      priceMode: "net",
      statedTotals: { grossCents: 119_000 },
    });
    expect(v.lines).toEqual([
      {
        account: "3100",
        description: "Gutschrift GS-2026-0001 – Beratung Webdesign",
        amountCents: 100_000,
        vatRateBp: 1900,
        vatCents: 19_000,
      },
    ]);
  });

  test("INV-16 a Widerspruch needs a finalised Gutschrift, a date between the document date and today, and a text", () => {
    const base = { type: "self_billing", status: "finalized", documentDate: "2026-10-01", today: "2026-10-12" };
    expect(objectionIssue({ ...base, date: "2026-10-05", text: "Provision zu hoch" })).toBeNull();
    expect(objectionIssue({ ...base, status: "sent", date: "2026-10-12", text: "x" })).toBeNull();
    expect(objectionIssue({ ...base, type: "invoice", date: "2026-10-05", text: "x" })).toBe(OBJECTION_MESSAGES.type);
    expect(objectionIssue({ ...base, status: "cancelled", date: "2026-10-05", text: "x" })).toBe(
      OBJECTION_MESSAGES.status,
    );
    expect(objectionIssue({ ...base, date: "2026-09-30", text: "x" })).toBe(OBJECTION_MESSAGES.date);
    expect(objectionIssue({ ...base, date: "2026-10-13", text: "x" })).toBe(OBJECTION_MESSAGES.date);
    expect(objectionIssue({ ...base, date: "2026-10-05", text: "  " })).toBe(OBJECTION_MESSAGES.text);
  });
});
