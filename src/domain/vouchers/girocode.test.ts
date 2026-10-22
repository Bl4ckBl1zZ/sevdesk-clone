import { describe, expect, test } from "vitest";
import { voucherGirocode } from "./girocode";

const base = {
  direction: "expense" as const,
  status: "open" as const,
  currency: "EUR",
  openAmountCents: 11_900,
  supplierName: "Büro Schmidt GmbH",
  supplierIban: "DE89 3704 0044 0532 0130 00",
  documentNumber: "RE-2026-0042",
};

describe("„Mit Banking-App bezahlen“ (VOU-135, MISC-01)", () => {
  test("VOU-135 GiroCode for the open amount, the supplier IBAN and the document number as reference", () => {
    expect(voucherGirocode(base)).toBe(
      [
        "BCD",
        "002",
        "1",
        "SCT",
        "",
        "Büro Schmidt GmbH",
        "DE89370400440532013000",
        "EUR119.00",
        "",
        "",
        "RE-2026-0042",
      ].join("\n"),
    );
    // The payee of an E-Rechnung (BT-59/BT-84) wins over the supplier's IBAN; the open amount after part payments.
    const payee = voucherGirocode({
      ...base,
      status: "partially_paid",
      openAmountCents: 4000,
      payee: { name: "Factoring AG", iban: "DE02120300000000202051", bic: "BYLADEM1001" },
    });
    expect(payee?.split("\n").slice(4, 8)).toEqual([
      "BYLADEM1001",
      "Factoring AG",
      "DE02120300000000202051",
      "EUR40.00",
    ]);
  });

  test("VOU-135 no GiroCode without IBAN, for paid/draft/cancelled, income, credit notes or foreign currency", () => {
    expect(voucherGirocode({ ...base, supplierIban: undefined })).toBeNull();
    expect(voucherGirocode({ ...base, supplierIban: "DE00 0000" })).toBeNull();
    for (const status of ["draft", "paid", "cancelled"] as const)
      expect(voucherGirocode({ ...base, status })).toBeNull();
    expect(voucherGirocode({ ...base, direction: "income" })).toBeNull();
    expect(voucherGirocode({ ...base, openAmountCents: -5000 })).toBeNull();
    expect(voucherGirocode({ ...base, currency: "USD" })).toBeNull();
    // Without a document number the internal number is the reference.
    expect(
      voucherGirocode({ ...base, documentNumber: undefined, internalNumber: "BE-2026-00007" })?.split("\n")[10],
    ).toBe("BE-2026-00007");
  });
});
