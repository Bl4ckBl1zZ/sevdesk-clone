import { BANK_ACCOUNT, makeSnapshot } from "@test/factories/snapshot";
import { describe, expect, test } from "vitest";
import { serializeEinvoice } from "../einvoice/serialize";
import { EPC_MAX_BYTES, girocodeFor, girocodePayload } from "./girocode";

const pay = (over: object) =>
  ({ method: "transfer", dueDays: 30, bankAccount: BANK_ACCOUNT, showEpcQr: true, ...over }) as const;

describe("EPC QR / GiroCode (DOC-51)", () => {
  test("T-DOC-034 BCD/002/1/SCT, holder, IBAN, EUR1190.00, remittance exactly the number, ≤ 331 bytes; BT-83 identical", () => {
    const s = makeSnapshot();
    const payload = girocodeFor(s);
    expect(payload).toBe(
      [
        "BCD",
        "002",
        "1",
        "SCT",
        "COBADEFFXXX",
        "Muster Design GmbH",
        "DE89370400440532013000",
        "EUR1190.00",
        "",
        "",
        "RE-2026-0042",
      ].join("\n"),
    );
    expect(new TextEncoder().encode(payload ?? "").length).toBeLessThanOrEqual(EPC_MAX_BYTES);
    expect(serializeEinvoice(s, "zugferd_en16931").xml).toContain(
      "<ram:PaymentReference>RE-2026-0042</ram:PaymentReference>",
    );
    expect(serializeEinvoice(s, "xrechnung_ubl").xml).toContain("<cbc:PaymentID>RE-2026-0042</cbc:PaymentID>");
  });

  test("DOC-51 the optional prefix is part of the remittance, the printed Verwendungszweck and BT-83", () => {
    const s = makeSnapshot({ payment: pay({ paymentReferencePrefix: "RE " }) });
    expect(girocodeFor(s)?.split("\n").at(-1)).toBe("RE RE-2026-0042");
    expect(s.payment.paymentReference).toBe("RE RE-2026-0042");
  });

  test("DOC-51 no QR for non-EUR, other methods, no account, disabled QR, Storno, proforma, quotes and refunds", () => {
    expect(
      girocodeFor(makeSnapshot({ currency: "USD", fx: { rate: "1.0831", source: "bmf_monthly", date: "2026-10-01" } })),
    ).toBeNull();
    expect(girocodeFor(makeSnapshot({ payment: pay({ method: "cash" }) }))).toBeNull();
    expect(girocodeFor(makeSnapshot({ payment: { method: "transfer", dueDays: 30, showEpcQr: true } }))).toBeNull();
    expect(girocodeFor(makeSnapshot({ payment: pay({ showEpcQr: false }) }))).toBeNull();
    expect(girocodeFor(makeSnapshot({ type: "proforma", einvoice: { format: "none" } }))).toBeNull();
    expect(girocodeFor(makeSnapshot({ type: "quote", einvoice: { format: "none" } }))).toBeNull();
    const storno = makeSnapshot({
      type: "cancellation",
      original: { number: "RE-2026-0042", date: "2026-10-12" },
      lines: [
        {
          kind: "item",
          name: "Storno",
          quantityMilli: -1_000,
          unitCode: "LS",
          unitPriceMicros: 1_000_000,
          vatCategory: "S",
          vatRateBp: 1900,
        },
      ],
    });
    expect(girocodeFor(storno)).toBeNull();
  });

  test("DOC-51 reminders carry the total claim", () => {
    const s = makeSnapshot({
      type: "reminder",
      number: "MA-2026-0004",
      lines: [],
      einvoice: { format: "none" },
      reminder: {
        level: 1,
        title: "1. Mahnung",
        invoiceNumber: "RE-2026-0042",
        invoiceDate: "2026-10-12",
        invoiceDueDate: "2026-11-11",
        invoiceGrossCents: 119_000,
        paymentsReceivedCents: 0,
        openAmountCents: 119_000,
        feeCents: 500,
        interestCents: 0,
        flatFee40Cents: 0,
        newDueDate: "2026-12-29",
        totalCents: 119_500,
      },
    });
    expect(girocodeFor(s)).toContain("EUR1195.00");
  });

  test("DOC-51 payload validation: IBAN, amount range and the 331-byte limit", () => {
    const base = { name: "Muster", iban: "DE89 3704 0044 0532 0130 00", amountCents: 100, remittance: "RE-1" };
    expect(girocodePayload(base)).toMatchObject({ ok: true });
    expect(girocodePayload({ ...base, iban: "DE00123" })).toMatchObject({
      ok: false,
      error: { code: "epc_iban_invalid" },
    });
    expect(girocodePayload({ ...base, amountCents: 0 })).toMatchObject({
      ok: false,
      error: { code: "epc_amount_invalid" },
    });
    expect(girocodePayload({ ...base, amountCents: 100_000_000_000 })).toMatchObject({
      ok: false,
      error: { code: "epc_amount_invalid" },
    });
    expect(girocodePayload({ ...base, name: "Ä".repeat(70), remittance: "Ü".repeat(140) })).toMatchObject({
      ok: false,
      error: { code: "epc_too_long" },
    });
    const long = girocodePayload({ ...base, name: "N".repeat(90), remittance: "R".repeat(200) });
    expect(long.ok && long.value.split("\n")[5]).toHaveLength(70);
    expect(long.ok && long.value.split("\n")[10]).toHaveLength(140);
  });
});
