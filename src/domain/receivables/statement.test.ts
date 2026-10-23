import { describe, expect, test } from "vitest";
import type { LetterCompany } from "./letter";
import { accountStatementLetter, balanceSentence, buildAccountStatement } from "./statement";

const COMPANY: LetterCompany = {
  legalForm: "gmbh",
  name: "Muster Webdesign GmbH",
  address: { street: "Musterstraße 1", postalCode: "10115", city: "Berlin", countryCode: "DE" },
  seat: "Berlin",
  contact: { name: "Max Muster", phone: "030 123456", email: "info@muster.de" },
  register: { court: "Amtsgericht Charlottenburg", type: "HRB", number: "123456 B" },
  representatives: [{ name: "Max Muster" }],
  taxNumber: "1121081508150",
  taxNumberState: "BE",
  accounts: [{ accountHolder: "Muster Webdesign GmbH", iban: "DE02120300000000202051", bic: "BYLADEM1001" }],
};

describe("customer account statement (PAY-005)", () => {
  const documents = [
    { id: "d0", kind: "invoice" as const, number: "RE-2026-0001", date: "2026-08-20", payableCents: 50_000 },
    { id: "d1", kind: "invoice" as const, number: "RE-2026-0002", date: "2026-09-01", payableCents: 119_000 },
    { id: "d2", kind: "correction" as const, number: "RK-2026-0001", date: "2026-09-10", payableCents: -11_900 },
    { id: "d3", kind: "invoice" as const, number: "RE-2026-0003", date: "2026-10-05", payableCents: 23_800 },
  ];
  const payments = [
    // before the period: RE-0001 paid in full
    pay("p0", "2026-08-30", "RE-2026-0001", 50_000),
    // RE-0002: 1.049,30 paid with 2 % Skonto on the rest (21,42 €), settles 1.071,10 = 1.190,00 − 119,00 correction
    pay("p1", "2026-09-12", "RE-2026-0002", 104_958, [{ reason: "skonto", amountCents: 2_142 }]),
    // an overpayment of 45,00 € kept as credit
    { ...pay("p2", "2026-09-12", undefined, 4_500), targetKind: "contactCredit" as const },
    // the credit is applied to RE-0003 (pair: credit −45,00, document +45,00)
    { ...pay("p3", "2026-10-06", undefined, -4_500), targetKind: "contactCredit" as const, sourceKind: "credit" },
    { ...pay("p4", "2026-10-06", "RE-2026-0003", 4_500), sourceKind: "credit" },
    // a payment on RE-0003 after the period
    pay("p5", "2026-11-02", "RE-2026-0003", 19_300),
  ];

  test("PAY-005 opening balance, chronological movements with running balance, closing balance for a period", () => {
    const s = buildAccountStatement({ from: "2026-09-01", to: "2026-10-31", documents, payments });
    expect(s.openingCents).toBe(0); // RE-0001 issued and paid before the period
    expect(s.entries.map((e) => [e.date, e.text, e.reference, e.amountCents, e.balanceCents])).toEqual([
      ["2026-09-01", "Rechnung", "RE-2026-0002", 119_000, 119_000],
      ["2026-09-10", "Rechnungskorrektur", "RK-2026-0001", -11_900, 107_100],
      ["2026-09-12", "Guthaben erhalten", "", -4_500, 102_600],
      ["2026-09-12", "Zahlung", "RE-2026-0002", -104_958, -2_358],
      ["2026-09-12", "Skonto", "RE-2026-0002", -2_142, -4_500],
      ["2026-10-05", "Rechnung", "RE-2026-0003", 23_800, 19_300],
      ["2026-10-06", "Guthaben verrechnet", "RE-2026-0003", 0, 19_300],
    ]);
    expect(s.closingCents).toBe(19_300);
    // the opening balance of the next period continues seamlessly
    const next = buildAccountStatement({ from: "2026-11-01", to: "2026-11-30", documents, payments });
    expect(next.openingCents).toBe(19_300);
    expect(next.closingCents).toBe(0);
  });

  test("PAY-005 reversals, refunds and write-offs carry their own date and sign", () => {
    const s = buildAccountStatement({
      from: "2026-09-01",
      to: "2026-09-30",
      documents: [documents[1] as (typeof documents)[number]],
      payments: [
        pay("a", "2026-09-05", "RE-2026-0002", 119_000),
        { ...pay("b", "2026-09-08", "RE-2026-0002", -119_000), reversal: true },
        {
          ...pay("c", "2026-09-20", "RE-2026-0002", 0, [{ reason: "write_off", amountCents: 119_000 }]),
          sourceKind: "adjustment",
        },
      ],
    });
    expect(s.entries.map((e) => [e.text, e.amountCents])).toEqual([
      ["Rechnung", 119_000],
      ["Zahlung", -119_000],
      ["Storno Zahlung", 119_000],
      ["Forderungsausfall", -119_000],
    ]);
    expect(s.closingCents).toBe(0);
  });

  test("PAY-005 MAIL-03 the letter: Geschäftsbrief footer, Soll/Haben/Saldo table, balance sentence, Saldenbestätigung", () => {
    const s = buildAccountStatement({ from: "2026-09-01", to: "2026-10-31", documents, payments });
    const l = accountStatementLetter({
      statement: s,
      company: COMPANY,
      recipient: { name: "Beispiel AG", customerNumber: "K-10001", address: ["Hauptstraße 5", "80331 München"] },
      date: "2026-11-03",
      confirmationRequest: true,
    });
    expect(l.title).toBe("Saldenbestätigung");
    expect(l.fileName).toBe("Kontoauszug-K-10001-2026-09-01-2026-10-31.pdf");
    expect(l.senderLine).toBe("Muster Webdesign GmbH · Musterstraße 1 · 10115 Berlin");
    expect(l.recipient).toEqual(["Beispiel AG", "Hauptstraße 5", "80331 München"]);
    expect(l.table?.rows[0]).toEqual(["01.09.2026", "Anfangssaldo", "", "", "", "0,00 €"]);
    expect(l.table?.rows[1]).toEqual(["01.09.2026", "Rechnung", "RE-2026-0002", "1.190,00 €", "", "1.190,00 €"]);
    expect(l.table?.rows.at(-1)).toEqual(["31.10.2026", "Endsaldo", "", "", "", "193,00 €"]);
    expect(l.closing[0]).toBe("Zum 31.10.2026 besteht ein offener Saldo zu unseren Gunsten von 193,00 €.");
    expect(l.closing[1]).toMatch(/^Bitte prüfen Sie den Saldo und bestätigen Sie ihn uns/);
    // § 35a GmbHG data in the footer (register, managing director)
    expect(l.footer[1].join(" ")).toContain("HRB 123456 B");
    expect(l.footer[1].join(" ")).toContain("Max Muster");
    expect(balanceSentence(-4_500, "2026-09-30")).toBe(
      "Zum 30.09.2026 besteht ein Guthaben zu Ihren Gunsten von 45,00 €.",
    );
    expect(balanceSentence(0, "2026-09-30")).toBe("Zum 30.09.2026 ist Ihr Konto bei uns ausgeglichen.");
  });
});

function pay(
  id: string,
  date: string,
  number: string | undefined,
  amountCents: number,
  differences: { reason: string; amountCents: number }[] = [],
) {
  return {
    id,
    date,
    targetKind: "salesDocument" as "salesDocument" | "contactCredit",
    number,
    amountCents,
    differences,
    reversal: false,
    sourceKind: "bank",
  };
}
