import { describe, expect, test } from "vitest";
import { differenceWire } from "../schemas/api/payments";
import {
  allocationsForInvoice,
  DIFFERENCE_REASONS,
  limitationDate,
  type PaymentInput,
  type PlanContext,
  planPayment,
  type SourceFacts,
  type TargetFacts,
  targetKey,
  unacknowledged,
} from "./plan";

const TODAY = "2026-10-13";
const INV: TargetFacts = {
  ref: { kind: "salesDocument", id: "inv1" },
  contactId: "c1",
  number: "RE-2026-0001",
  docType: "invoice",
  status: "sent",
  paymentStatus: "open",
  currency: "EUR",
  documentDate: "2026-10-09",
  dueDate: "2026-11-08",
  payableCents: 119000,
  openAmountCents: 119000,
  groups: [{ category: "S", rateBp: 1900, grossCents: 119000 }],
  skonto: { percentBp: 200, deadline: "2026-10-23", agreedCents: 2380 },
  taxedAs: "soll",
  methodOnDate: "soll",
};
const INV2: TargetFacts = { ...INV, ref: { kind: "salesDocument", id: "inv2" }, number: "RE-2026-0002" };

function ctx(over: Partial<PlanContext> = {}, targets: TargetFacts[] = [INV, INV2], source?: SourceFacts): PlanContext {
  const credit: TargetFacts = {
    ref: { kind: "contactCredit", id: "c1" },
    currency: "EUR",
    payableCents: 0,
    openAmountCents: 0,
    creditBalanceCents: 4500,
  };
  return {
    today: TODAY,
    closedPeriods: new Set(),
    source: source ?? { kind: "clearing", clearing: { currency: "EUR" } },
    targets: new Map([...targets, credit].map((t) => [targetKey(t.ref), t])),
    ...over,
  };
}
const pay = (amountCents: number, over: Partial<PaymentInput> = {}): PaymentInput => ({
  source: { kind: "clearing", accountId: "acc" },
  date: TODAY,
  allocations: [{ target: INV.ref, amountCents }],
  ...over,
});
const errorOf = (r: ReturnType<typeof planPayment>) => (r.ok ? null : r.error);

describe("planPayment (F05 §4.1, PAY-010 ff.)", () => {
  test("T05-010 PAY-010 full payment: one row settling the open amount", () => {
    const r = planPayment(pay(119000), ctx());
    expect(r.ok && r.value).toMatchObject({
      date: TODAY,
      totalCents: 119000,
      rows: [{ amountCents: 119000, settlesCents: 119000, openAfterCents: 0, contactId: "c1" }],
    });
  });

  test("T05-011 PAY-012 partial payment leaves the remainder open", () => {
    const r = planPayment(pay(50000), ctx());
    expect(r.ok && r.value.rows[0]?.openAfterCents).toBe(69000);
  });

  test("PAY-028 „partial“ and „collective“ are no selectable difference reasons; both are expressed without a difference", () => {
    expect(DIFFERENCE_REASONS).not.toContain("partial");
    expect(DIFFERENCE_REASONS).not.toContain("collective");
    for (const reason of ["partial", "collective"]) {
      expect(differenceWire.safeParse({ reason, amount_cents: 100 }).success, reason).toBe(false);
    }
    expect(differenceWire.safeParse({ reason: "skonto", amount_cents: 100 }).success).toBe(true);
    // a partial payment = no difference at all; the remainder stays open
    const partial = planPayment(pay(50000), ctx());
    expect(partial.ok && partial.value.rows[0]).toMatchObject({ differences: [], openAfterCents: 69000 });
    // a combined payment = several allocations from one source, still without a difference
    const combined = planPayment(
      pay(238000, {
        allocations: [
          { target: INV.ref, amountCents: 119000 },
          { target: INV2.ref, amountCents: 119000 },
        ],
      }),
      ctx(),
    );
    expect(combined.ok && combined.value.rows.map((r) => r.differences.length)).toEqual([0, 0]);
  });

  test("T05-012 PAY-013 Sammelzahlung from one bank transaction over two invoices", () => {
    const bank: SourceFacts = {
      kind: "bank",
      bank: { bookingDate: "2026-10-12", amountCents: 238000, allocatedCents: 0, currency: "EUR", status: "open" },
    };
    const r = planPayment(
      {
        source: { kind: "bank", transactionId: "tx" },
        date: "2026-10-13",
        allocations: [
          { target: INV.ref, amountCents: 119000 },
          { target: INV2.ref, amountCents: 119000 },
        ],
      },
      ctx({}, undefined, bank),
    );
    // PAY-010 bank source: the booking date is fixed
    expect(r.ok && r.value).toMatchObject({ date: "2026-10-12", totalCents: 238000, unallocatedCents: 0 });
  });

  test("T05-013 EC-PAY-01 EC-120 RI-09 1.300,00 on a 1.190,00 invoice without excess resolution → exact message", () => {
    expect(errorOf(planPayment(pay(130000), ctx()))).toEqual({
      code: "excess",
      message:
        "Der Betrag übersteigt den offenen Betrag um 110,00 €. Bitte den Mehrbetrag zuordnen (weitere Rechnung, Mahngebühren/Zinsen, Guthaben).",
      params: { excessCents: 11000 },
    });
  });

  test("T05-014 EC-PAY-02 allocations above the transaction amount are rejected", () => {
    const bank: SourceFacts = {
      kind: "bank",
      bank: { bookingDate: "2026-10-12", amountCents: 150000, allocatedCents: 0, currency: "EUR", status: "open" },
    };
    const r = planPayment(
      {
        source: { kind: "bank", transactionId: "tx" },
        date: TODAY,
        allocations: [
          { target: INV.ref, amountCents: 100000 },
          { target: INV2.ref, amountCents: 60000 },
        ],
      },
      ctx({}, undefined, bank),
    );
    expect(errorOf(r)?.message).toBe(
      "Die Zuordnungen (1.600,00 €) übersteigen den verfügbaren Betrag der Zahlung (1.500,00 €).",
    );
  });

  test("EC-PAY-03 GOBD-02 a transaction allocated meanwhile by another client fails the re-check with „neu laden“", () => {
    // Client B planned against the full 1.190,00; client A has allocated all of it in the meantime.
    const bank = (allocatedCents: number): SourceFacts => ({
      kind: "bank",
      bank: {
        bookingDate: "2026-10-12",
        amountCents: 119000,
        allocatedCents,
        currency: "EUR",
        status: allocatedCents === 0 ? "open" : allocatedCents === 119000 ? "matched" : "partially_matched",
      },
    });
    const input: PaymentInput = {
      source: { kind: "bank", transactionId: "tx" },
      date: TODAY,
      allocations: [{ target: INV.ref, amountCents: 119000 }],
    };
    expect(planPayment(input, ctx({}, undefined, bank(0))).ok).toBe(true);
    expect(errorOf(planPayment(input, ctx({}, undefined, bank(119000))))).toEqual({
      code: "concurrent_allocation",
      message: "Diese Bankbuchung wurde soeben anderweitig zugeordnet. Bitte neu laden.",
    });
    // a partially matched transaction keeps the informative EC-PAY-02 message
    expect(errorOf(planPayment(input, ctx({}, undefined, bank(100000))))?.message).toBe(
      "Die Zuordnungen (1.190,00\u00a0€) übersteigen den verfügbaren Betrag der Zahlung (190,00\u00a0€).",
    );
  });

  test("EC-PAY-43 AO-04 a cash receipt without an invoice („Barverkauf“) is impossible", () => {
    const msg =
      "Bareinnahmen ohne Rechnung sind nicht vorgesehen (keine Kassenfunktion). Bitte zuerst eine Rechnung erstellen.";
    const cash = (allocations: PaymentInput["allocations"]) =>
      planPayment({ source: { kind: "cash" }, date: TODAY, allocations }, ctx({}, [INV], { kind: "cash" }));
    expect(errorOf(cash([]))).toEqual({ code: "cash_without_invoice", message: msg });
    // only a credit balance, no issued document
    expect(errorOf(cash([{ target: { kind: "contactCredit", id: "c1" }, amountCents: 5000 }]))).toEqual({
      code: "cash_without_invoice",
      message: msg,
    });
    expect(cash([{ target: INV.ref, amountCents: 5000 }]).ok).toBe(true);
  });

  test("T05-016 EC-PAY-04 a draft is rejected", () => {
    expect(errorOf(planPayment(pay(100), ctx({}, [{ ...INV, status: "draft" }])))?.message).toBe(
      "Zahlungen können nur auf fertiggestellte Rechnungen gebucht werden.",
    );
  });

  test("T05-017 EC-PAY-05 a cancelled invoice and the Stornorechnung itself are rejected with the credit hint", () => {
    const hint =
      "Die Rechnung ist storniert. Bitte die Zahlung der neuen Rechnung zuordnen oder als Guthaben des Kunden erfassen.";
    expect(errorOf(planPayment(pay(100), ctx({}, [{ ...INV, status: "cancelled" }])))).toEqual({
      code: "cancelled",
      message: hint,
    });
    expect(errorOf(planPayment(pay(100), ctx({}, [{ ...INV, docType: "cancellation" }])))).toEqual({
      code: "cancelled",
      message: hint,
    });
  });

  test("T05-018 EC-PAY-06 EC-PAY-07 future date rejected; before the invoice date → ⚑ warning", () => {
    expect(errorOf(planPayment(pay(100, { date: "2026-10-14" }), ctx()))?.message).toBe(
      "Das Zahlungsdatum darf nicht in der Zukunft liegen.",
    );
    const r = planPayment(pay(100, { date: "2026-10-01" }), ctx());
    expect(r.ok && r.value.warnings).toEqual([
      {
        code: "before_document_date",
        message: "Das Zahlungsdatum liegt vor dem Rechnungsdatum (Vorauszahlung). Bitte prüfen.",
        ack: true,
      },
    ]);
    if (r.ok) {
      expect(unacknowledged(r.value)).toHaveLength(1);
      expect(unacknowledged(r.value, ["before_document_date"])).toHaveLength(0);
    }
  });

  test("T05-019 EC-PAY-08 PAY-045 payment dated in a locked period → period_locked; bank sources move instead", () => {
    const locked = ctx({ closedPeriods: new Set(["2026-09"]) });
    expect(errorOf(planPayment(pay(100, { date: "2026-09-30" }), locked))).toEqual({
      code: "period_locked",
      message: "Der Zeitraum 09/2026 ist festgeschrieben. Bitte ein Datum in einem offenen Zeitraum wählen.",
      params: { period: "2026-09" },
    });
  });

  test("T05-034 T05-035 EC-PAY-09/11 Skonto checks; the remainder may stay open (partial)", () => {
    const skonto = (date: string, cents: number, facts = INV) =>
      planPayment(
        pay(119000 - cents, {
          date,
          allocations: [
            { target: INV.ref, amountCents: 119000 - cents, differences: [{ reason: "skonto", amountCents: cents }] },
          ],
        }),
        ctx({}, [facts]),
      );
    const ok = skonto("2026-10-13", 2380);
    expect(ok.ok && ok.value.rows[0]?.differences).toEqual([
      { reason: "skonto", amountCents: 2380, vatCorrection: [{ rateBp: 1900, netCents: 2000, vatCents: 380 }] },
    ]);
    expect(errorOf(skonto("2026-10-13", 3000))?.code).toBe("skonto_not_allowed");
    expect(errorOf(skonto("2026-10-13", 100, { ...INV, skonto: null }))?.code).toBe("no_skonto_terms");
    expect(
      errorOf(skonto("2026-10-13", 100, { ...INV, groups: [{ category: "KU", rateBp: 0, grossCents: 119000 }] }))?.code,
    ).toBe("skonto_without_vat_rate");
  });

  test("T05-034 EC-122 E-TAX-14 late Skonto accepted only as `other` Kulanz with reason and VAT correction", () => {
    const r = planPayment(
      pay(116620, {
        allocations: [
          {
            target: INV.ref,
            amountCents: 116620,
            differences: [
              {
                reason: "other",
                amountCents: 2380,
                account: "8736",
                text: "Kulanz-Preisminderung (Skonto nach Fristablauf)",
              },
            ],
          },
        ],
      }),
      ctx({ today: "2026-11-01" }),
    );
    expect(r.ok && r.value.rows[0]?.differences[0]?.vatCorrection).toEqual([
      { rateBp: 1900, netCents: 2000, vatCents: 380 },
    ]);
  });

  test("T05-037 T05-038 PAY-020 PAY-023 EC-PAY-10 bank fees (no VAT) + Skonto on one allocation; EC-PAY-10 above 25,00 €", () => {
    const r = planPayment(
      pay(116270, {
        allocations: [
          {
            target: INV.ref,
            amountCents: 116270,
            differences: [
              { reason: "skonto", amountCents: 2380 },
              { reason: "bank_fees", amountCents: 350 },
            ],
          },
        ],
      }),
      ctx(),
    );
    expect(r.ok && r.value.rows[0]).toMatchObject({ settlesCents: 119000, openAfterCents: 0 });
    const high = planPayment(
      pay(116000, {
        allocations: [
          { target: INV.ref, amountCents: 116000, differences: [{ reason: "bank_fees", amountCents: 3000 }] },
        ],
      }),
      ctx(),
    );
    // EC-PAY-10: allowed, but ⚑ (must be acknowledged); exactly 25,00 € does not warn
    expect(high.ok && high.value.warnings.map((w) => [w.code, w.ack])).toEqual([["bank_fees_high", true]]);
    const edge = planPayment(
      pay(116500, {
        allocations: [
          { target: INV.ref, amountCents: 116500, differences: [{ reason: "bank_fees", amountCents: 2500 }] },
        ],
      }),
      ctx(),
    );
    expect(edge.ok && edge.value.warnings).toEqual([]);
    expect(high.ok && high.value.warnings[0]?.message).toBe(
      "Ungewöhnlich hohe Bankgebühren (30,00 €). Bitte prüfen, ob es sich um eine Teilzahlung handelt.",
    );
  });

  test("T05-040 T05-041 T05-042 PAY-025 EC-PAY-14 EC-PAY-15 EC-PAY-16 write-off: sub-reason required, statute_barred only after limitation, Ist info", () => {
    const wo = (sub?: "insolvency" | "statute_barred", facts = INV, today = TODAY) =>
      planPayment(
        {
          source: { kind: "adjustment" },
          date: today,
          allocations: [
            {
              target: INV.ref,
              amountCents: 0,
              differences: [{ reason: "write_off", amountCents: 119000, ...(sub ? { subReason: sub } : {}) }],
            },
          ],
        },
        ctx({ today }, [facts]),
      );
    expect(errorOf(wo())?.message).toBe(
      "Bitte den Grund des Forderungsausfalls angeben (Insolvenz, uneinbringlich, verjährt, Verzicht).",
    );
    expect(errorOf(wo("statute_barred"))?.message).toBe("Die Forderung ist erst am 31.12.2029 verjährt.");
    const ok = wo("insolvency");
    expect(ok.ok && ok.value.rows[0]?.differences[0]?.vatCorrection).toEqual([
      { rateBp: 1900, netCents: 100000, vatCents: 19000 },
    ]);
    expect(ok.ok && ok.value.totalCents).toBe(0);
    const ist = wo("insolvency", { ...INV, taxedAs: "ist", methodOnDate: "ist" });
    expect(ist.ok && ist.value.warnings.map((w) => [w.code, w.ack])).toEqual([["write_off_ist", false]]);
    expect(ist.ok && ist.value.warnings[0]?.message).toBe(
      "Bei Ist-Versteuerung wurde die Umsatzsteuer noch nicht abgeführt – es erfolgt keine USt-Korrektur.",
    );
    expect(wo("statute_barred", { ...INV, dueDate: "2022-06-01" }).ok).toBe(true);
    expect(limitationDate("2023-03-01")).toBe("2026-12-31");
  });

  test("T05-044 EC-PAY-17 taxation method changed since the invoice → warning naming the invoice's method", () => {
    const r = planPayment(
      pay(116620, {
        allocations: [{ target: INV.ref, amountCents: 116620, differences: [{ reason: "skonto", amountCents: 2380 }] }],
      }),
      ctx({}, [{ ...INV, taxedAs: "soll", methodOnDate: "ist" }]),
    );
    expect(r.ok && r.value.warnings[0]?.message).toBe(
      "Besteuerungsart hat sich seit der Rechnung geändert. Die USt-Korrektur folgt der Versteuerung der Rechnung (Soll-Versteuerung).",
    );
  });

  test("T05-045 EC-PAY-39 `other` without reason or account is rejected", () => {
    const r = planPayment(
      pay(100000, {
        allocations: [
          { target: INV.ref, amountCents: 100000, differences: [{ reason: "other", amountCents: 100, text: "x" }] },
        ],
      }),
      ctx(),
    );
    expect(errorOf(r)?.message).toBe("Bitte Grund (mind. 5 Zeichen) und Buchungskonto für die Differenz angeben.");
  });

  test("T05-043 EC-PAY-18 payment on a written-off invoice only through the recovery wizard", () => {
    const wo = { ...INV, paymentStatus: "written_off" };
    expect(errorOf(planPayment(pay(100), ctx({}, [wo])))?.code).toBe("written_off");
    expect(planPayment(pay(100), ctx({ allowWrittenOff: true }, [{ ...wo, openAmountCents: 59500 }])).ok).toBe(true);
  });

  test("T05-052 EC-PAY-32 applying credit: pair balances, within the balance, same contact only", () => {
    const apply = (credit: number, inv = INV) =>
      planPayment(
        {
          source: { kind: "credit" },
          date: TODAY,
          allocations: [
            { target: { kind: "contactCredit", id: "c1" }, amountCents: -credit },
            { target: inv.ref, amountCents: credit },
          ],
        },
        ctx({}, [inv]),
      );
    expect(apply(4500).ok && apply(4500)).toMatchObject({ value: { totalCents: 0 } });
    expect(errorOf(apply(5000))?.message).toBe("Das Guthaben (45,00 €) reicht nicht aus.");
    expect(errorOf(apply(4500, { ...INV, contactId: "c2" }))?.message).toBe(
      "Guthaben kann nur auf Rechnungen desselben Kontakts angewendet werden.",
    );
  });

  test("T05-162 PAY-061 EC-PAY-46/47 cash dating: > 1 day ⚑ warning, > 10 days reason required", () => {
    const cash = (date: string, backdateReason?: string) =>
      planPayment(
        {
          source: { kind: "cash" },
          date,
          allocations: [{ target: INV.ref, amountCents: 1000 }],
          ...(backdateReason ? { backdateReason } : {}),
        },
        ctx({}, [{ ...INV, documentDate: "2026-09-01" }], { kind: "cash" }),
      );
    expect(cash(TODAY).ok && cash(TODAY)).toMatchObject({ value: { warnings: [] } });
    const two = cash("2026-10-11");
    expect(two.ok && two.value.warnings[0]).toEqual({
      code: "cash_daily_recording",
      message:
        "Bareinnahmen sind täglich aufzuzeichnen (§ 146 Abs. 1 S. 2 AO). Das Zahlungsdatum liegt 2 Tage zurück – bitte prüfen.",
      ack: true,
    });
    expect(errorOf(cash("2026-10-02"))?.message).toBe(
      "Die Barzahlung liegt mehr als 10 Tage zurück. Bitte begründen, warum sie erst jetzt erfasst wird.",
    );
    expect(cash("2026-10-02", "Kasse erst heute gezählt").ok).toBe(true);
  });

  test("T05-164 EC-PAY-49 private source on a sales document; EC-CSH-35 cash only in EUR", () => {
    expect(errorOf(planPayment(pay(100, { source: { kind: "private" } }), ctx()))?.message).toBe(
      "‚Privat bezahlt‘ ist nur bei Eingangsbelegen möglich.",
    );
    expect(
      errorOf(
        planPayment(pay(100, { source: { kind: "cash" } }), ctx({}, [{ ...INV, currency: "USD" }], { kind: "cash" })),
      )?.message,
    ).toBe("Barzahlungen sind nur in EUR möglich.");
  });

  test("T05-068 EC-PAY-37 zero or negative amounts are rejected", () => {
    expect(errorOf(planPayment(pay(0), ctx()))?.message).toBe("Der Betrag muss größer als 0 sein.");
    expect(errorOf(planPayment(pay(-5), ctx()))?.code).toBe("amount_positive");
  });

  test("PAY-024 fees/interest only up to the amounts claimed in a reminder", () => {
    const withFees = (claimed: number) =>
      planPayment(
        pay(120700, {
          allocations: [
            { target: INV.ref, amountCents: 120700, differences: [{ reason: "dunning_fees", amountCents: -1700 }] },
          ],
        }),
        ctx({}, [{ ...INV, claimedFeesCents: claimed }]),
      );
    expect(withFees(1700).ok).toBe(true);
    expect(errorOf(withFees(0))?.code).toBe("fees_exceed_claim");
  });
});

describe("single-invoice shape and excess resolution (PAY-030)", () => {
  const invoice = { id: "inv1", contactId: "c1", openAmountCents: 119000 };
  test("T05-050 PAY-030 c overpayment → credit balance row", () => {
    const r = allocationsForInvoice({ invoice, sourceKind: "bank", amountCents: 123500, excess: { mode: "credit" } });
    expect(r.ok && r.value).toEqual([
      { target: { kind: "salesDocument", id: "inv1" }, amountCents: 119000 },
      { target: { kind: "contactCredit", id: "c1" }, amountCents: 4500 },
    ]);
  });

  test("T05-164 EC-PAY-50 cash excess cannot stay unallocated; bank excess can (d)", () => {
    const cash = allocationsForInvoice({
      invoice,
      sourceKind: "cash",
      amountCents: 120000,
      excess: { mode: "unallocated" },
    });
    expect(cash.ok ? null : cash.error.message).toBe(
      "Ein Mehrbetrag aus einer Barzahlung muss zugeordnet werden (weitere Rechnung, Mahngebühren/Zinsen oder Guthaben).",
    );
    const bank = allocationsForInvoice({
      invoice,
      sourceKind: "bank",
      amountCents: 120000,
      excess: { mode: "unallocated" },
    });
    expect(bank.ok && bank.value).toEqual([{ target: { kind: "salesDocument", id: "inv1" }, amountCents: 119000 }]);
  });

  test("PAY-030 a/b excess to further invoices or to claimed fees", () => {
    const more = allocationsForInvoice({
      invoice,
      sourceKind: "clearing",
      amountCents: 129000,
      excess: { mode: "allocate", allocations: [{ invoiceId: "inv2", amountCents: 10000 }] },
    });
    expect(more.ok && more.value[1]).toEqual({ target: { kind: "salesDocument", id: "inv2" }, amountCents: 10000 });
    const fees = allocationsForInvoice({
      invoice: { ...invoice, claimedFeesCents: 500, claimedInterestCents: 1200 },
      sourceKind: "bank",
      amountCents: 120700,
      excess: { mode: "fees" },
    });
    expect(fees.ok && fees.value[0]?.differences).toEqual([
      { reason: "dunning_fees", amountCents: -500 },
      { reason: "default_interest", amountCents: -1200 },
    ]);
    expect(allocationsForInvoice({ invoice, sourceKind: "bank", amountCents: 120000 }).ok).toBe(false);
  });
});

describe("foreign-currency payments (PAY-018, MISC-08)", () => {
  // USD invoice 1.190,00 USD at „1 EUR = 1.19 USD“ → 1.000,00 € at invoice
  const USD: TargetFacts = { ...INV, currency: "USD", fxRateToEur: "1.19", skonto: null };
  const fx = (amountCents: number, eurAmountCents?: number, facts: TargetFacts = USD) =>
    planPayment(
      pay(amountCents, {
        allocations: [{ target: INV.ref, amountCents, ...(eurAmountCents !== undefined ? { eurAmountCents } : {}) }],
      }),
      ctx({}, [facts]),
    );

  test("EC-PAY-22 a payment on a foreign-currency invoice without the EUR amount received is rejected", () => {
    expect(errorOf(fx(119000))).toEqual({
      code: "fx_missing",
      message: "Bitte den tatsächlich erhaltenen Euro-Betrag angeben (Fremdwährung).",
    });
    expect(errorOf(fx(119000, 0))?.code).toBe("amount_positive");
  });

  test("EC-PAY-23 PAY-018 the EUR difference to the value at invoice is an FX gain/loss (never Skonto), rounded once on the EUR side", () => {
    const loss = fx(119000, 98000);
    expect(loss.ok && loss.value.rows[0]).toMatchObject({
      amountCents: 119000,
      settlesCents: 119000,
      openAfterCents: 0,
      differences: [],
      eurAmountCents: 98000,
      eurAtInvoiceCents: 100000,
      fxDifferenceCents: 2000, // + = loss
    });
    expect(loss.ok && loss.value.warnings).toEqual([
      { code: "fx_difference", message: "Kursdifferenz: 20,00\u00a0€ (Kursverlust)", ack: false },
    ]);
    const gain = fx(119000, 101050);
    expect(gain.ok && gain.value.rows[0]?.fxDifferenceCents).toBe(-1050);
    expect(gain.ok && gain.value.warnings[0]?.message).toBe("Kursdifferenz: 10,50\u00a0€ (Kursgewinn)");
    const none = fx(119000, 100000);
    expect(none.ok && [none.value.rows[0]?.fxDifferenceCents, none.value.warnings]).toEqual([0, []]);
    // partial payments: the EUR value at invoice is taken cumulatively, so the last payment absorbs the rounding
    // 0,01 USD → 0,0084 € → 0,01 €; the rest 1.189,99 USD → 1.000,00 − 0,01 = 999,99 €
    const first = fx(1, 1);
    expect(first.ok && first.value.rows[0]?.eurAtInvoiceCents).toBe(1);
    const rest = fx(118999, 99999, { ...USD, openAmountCents: 118999 });
    expect(rest.ok && rest.value.rows[0]?.eurAtInvoiceCents).toBe(99999);
  });

  test("PAY-018 P1: differences (Skonto, fees, write-off) are not offered on a foreign-currency payment", () => {
    const r = planPayment(
      pay(116620, {
        allocations: [
          {
            target: INV.ref,
            amountCents: 116620,
            eurAmountCents: 98000,
            differences: [{ reason: "bank_fees", amountCents: 2380 }],
          },
        ],
      }),
      ctx({}, [USD]),
    );
    expect(errorOf(r)).toEqual({
      code: "differences_not_allowed",
      message:
        "Differenzen (Skonto, Gebühren, Ausbuchung) sind bei Zahlungen in Fremdwährung noch nicht möglich. Bitte den Zahlbetrag ohne Differenz erfassen; der Rest bleibt offen.",
    });
  });

  test("EC-CSH-35 cash on a foreign-currency invoice stays impossible; an invoice without a rate is deferred", () => {
    expect(errorOf(planPayment(pay(100, { source: { kind: "cash" } }), ctx({}, [USD], { kind: "cash" })))?.code).toBe(
      "cash_eur_only",
    );
    const { fxRateToEur: _, ...noRate } = USD;
    expect(errorOf(fx(100, 84, noRate))?.code).toBe("fx_deferred");
  });
});
