import { describe, expect, test } from "vitest";
import type { VoucherBookedEvent, VoucherPaidEvent } from "./events";
import { checkBalanced, type PostingContext, postEvent, type RoleLine, reversalPosting } from "./post";

const CTX: PostingContext = { taxationMethod: "soll", legalForm: "einzelunternehmen", ustvaPeriod: [] };
const booked = (over: Partial<VoucherBookedEvent> = {}): VoucherBookedEvent => ({
  kind: "voucher_booked",
  voucherId: "v1",
  number: "BE-2026-00001",
  direction: "expense",
  voucherKind: "standard",
  taxRule: "input_vat_deductible",
  companyIsKu: false,
  date: "2026-03-10",
  supplyDate: { kind: "date", date: "2026-03-05" },
  receivedDate: "2026-03-10",
  lines: [{ account: "6815", netCents: 10_000, vatCents: 1900, vatRateBp: 1900 }],
  ...over,
});
const paid = (over: Partial<VoucherPaidEvent> = {}): VoucherPaidEvent => ({
  kind: "voucher_paid",
  paymentId: "p1",
  date: "2026-03-20",
  direction: "expense",
  means: { kind: "bank_account", bankAccountId: "b1" },
  amountCents: 11_900,
  voucher: { id: "v1", number: "BE-2026-00001" },
  inputVatDeducted: true,
  ...over,
});

function linesOf(e: VoucherBookedEvent | VoucherPaidEvent, ctx: PostingContext = CTX): RoleLine[] {
  const r = postEvent(e, ctx);
  if (!r.ok || r.value.kind !== "entry") throw new Error(JSON.stringify(r));
  expect(checkBalanced(r.value.posting.lines).ok).toBe(true);
  return r.value.posting.lines;
}
const sum = (lines: RoleLine[], pick: (l: RoleLine) => boolean, side: "debitCents" | "creditCents" = "debitCents") =>
  lines.filter(pick).reduce((s, l) => s + l[side], 0);

describe("voucher postings (F08 §4.2.3, F06 VOU-020…027)", () => {
  test("VOU-020 input VAT on the chosen account; tax point = max(supply end, receipt date) (§ 15 UStG)", () => {
    const lines = linesOf(booked({ receivedDate: "2026-04-02" }));
    expect(lines.find((l) => l.account === "6815")).toMatchObject({ debitCents: 10_000, taxKey: "VSt19" });
    expect(lines.find((l) => l.role === "vat.input.19")).toMatchObject({
      debitCents: 1900,
      taxPointDate: "2026-04-02",
    });
    const r = postEvent(booked(), CTX);
    expect(r.ok && r.value.kind === "entry" && r.value.posting.source).toEqual({ kind: "voucher", id: "v1" });
  });

  test("VOU-021 no_input_vat: gross to expense, no VAT line", () => {
    const lines = linesOf(booked({ taxRule: "no_input_vat" }));
    expect(lines.filter((l) => l.role?.startsWith("vat."))).toEqual([]);
    expect(lines.find((l) => l.account === "6815")?.debitCents).toBe(11_900);
  });

  test("VOU-027 private share: expense and VAT reduced by the share (half-up), the share goes to Privatentnahmen", () => {
    const lines = linesOf(
      booked({
        lines: [{ account: "6805", netCents: 3333, vatCents: 633, vatRateBp: 1900, nonDeductibleShareBp: 2500 }],
      }),
    );
    // 3333 × 25 % = 833,25 → 833; 633 × 25 % = 158,25 → 158
    expect(lines.find((l) => l.account === "6805")?.debitCents).toBe(2500);
    expect(lines.find((l) => l.role === "vat.input.19")?.debitCents).toBe(475);
    expect(lines.find((l) => l.role === "private.withdrawal")?.debitCents).toBe(991);
    // Corporations: the share goes to the shareholder clearing account (ACC-028).
    const corp = linesOf(
      booked({
        lines: [{ account: "6805", netCents: 1000, vatCents: 190, vatRateBp: 1900, nonDeductibleShareBp: 1000 }],
      }),
      { ...CTX, legalForm: "gmbh" },
    );
    expect(corp.find((l) => l.role === "shareholder.clearing")?.debitCents).toBe(119);
  });

  test("VOU-061 MISC-05 Bewirtung: 30 % non-deductible of every line incl. the tip, input VAT 100 %", () => {
    const lines = linesOf(
      booked({
        voucherKind: "bewirtung",
        bewirtungOccasion: "geschaeftlich",
        lines: [
          { account: "6640", netCents: 10_000, vatCents: 700, vatRateBp: 700 },
          { account: "6640", netCents: 5000, vatCents: 950, vatRateBp: 1900 },
          { account: "6640", netCents: 1000, vatCents: 0, vatRateBp: 0 },
        ],
      }),
    );
    expect(sum(lines, (l) => l.role === "expense.entertainment")).toBe(11_200);
    expect(sum(lines, (l) => l.role === "expense.entertainment.nd")).toBe(4800);
    expect(sum(lines, (l) => l.role?.startsWith("vat.input") ?? false)).toBe(1650);
  });

  test("VOU-022 RC EU tax point is the end of the supply month; non-EU and igE use the invoice rules", () => {
    const rc = linesOf(
      booked({
        taxRule: "reverse_charge_eu",
        supplyDate: { kind: "date", date: "2026-02-20" },
        lines: [{ account: "5923", netCents: 100_000, vatCents: 0, vatRateBp: 1900, selfAssessedVatCents: 19_000 }],
      }),
    );
    expect(rc.find((l) => l.role === "vat.output.13b.19")?.taxPointDate).toBe("2026-02-28");
    // §13b at 7 % has no shipped role → blocked (F08-Q1).
    const r = postEvent(
      booked({
        taxRule: "reverse_charge_eu",
        lines: [{ account: "5923", netCents: 100, vatCents: 0, vatRateBp: 700, selfAssessedVatCents: 7 }],
      }),
      CTX,
    );
    expect(!r.ok && r.error.code).toBe("rate_not_supported");
  });

  test("VOU-065 GWG and Sammelposten lines post to the asset roles; an „asset“ line keeps the chosen fixed-asset account", () => {
    const lines = linesOf(
      booked({
        voucherKind: "asset",
        lines: [
          { account: "0650", netCents: 60_000, vatCents: 11_400, vatRateBp: 1900, assetDecision: "gwg" },
          { account: "0650", netCents: 90_000, vatCents: 17_100, vatRateBp: 1900, assetDecision: "pool" },
          { account: "0650", netCents: 150_000, vatCents: 28_500, vatRateBp: 1900, assetDecision: "asset" },
        ],
      }),
    );
    expect(lines.find((l) => l.role === "asset.gwg")?.debitCents).toBe(60_000);
    expect(lines.find((l) => l.role === "asset.pool")?.debitCents).toBe(90_000);
    expect(lines.find((l) => l.account === "0650")?.debitCents).toBe(150_000);
  });

  test("VOU-008 a correction reversal keeps the original date and tax points; a cancel (VOU-009) is dated today", () => {
    const orig = postEvent(booked(), CTX);
    if (!orig.ok || orig.value.kind !== "entry") throw new Error("not posted");
    const corr = reversalPosting(
      {
        kind: "voucher_reversed",
        voucherId: "v1",
        number: "BE-2026-00001",
        date: "2026-03-10",
        reason: "Konto",
        mode: "correction",
      },
      orig.value.posting,
      CTX,
    );
    expect(corr.explanation).toBe("V-correction");
    expect(corr.lines.find((l) => l.role === "vat.input.19")).toMatchObject({
      creditCents: 1900,
      taxPointDate: "2026-03-10",
    });
    const cancel = reversalPosting(
      {
        kind: "voucher_reversed",
        voucherId: "v1",
        number: "BE-2026-00001",
        date: "2026-05-04",
        reason: "Doppelt",
        mode: "cancel",
      },
      orig.value.posting,
      CTX,
    );
    expect(cancel.explanation).toBe("V-storno");
    expect(cancel.date).toBe("2026-05-04");
  });
});

describe("voucher payments (VOU-131, VOU-132, VOU-137, VOU-138)", () => {
  test("VOU-131 bank payment: S payable · H bank; source is the payment", () => {
    const r = postEvent(paid(), CTX);
    expect(r.ok && r.value.kind === "entry" && r.value.posting.explanation).toBe("V2");
    expect(r.ok && r.value.kind === "entry" && r.value.posting.source).toEqual({ kind: "payment", id: "p1" });
  });

  test("VOU-132 UST-32 Skonto received corrects input VAT per rate; the correction must add up to the difference", () => {
    const lines = linesOf(
      paid({
        amountCents: 11_662,
        differences: [
          { reason: "skonto", amountCents: 238, vatCorrection: [{ rateBp: 1900, netCents: 200, vatCents: 38 }] },
        ],
      }),
    );
    expect(lines.find((l) => l.role === "vat.input.19")?.creditCents).toBe(38);
    const bad = postEvent(
      paid({
        amountCents: 11_662,
        differences: [
          { reason: "skonto", amountCents: 238, vatCorrection: [{ rateBp: 1900, netCents: 200, vatCents: 30 }] },
        ],
      }),
      CTX,
    );
    expect(!bad.ok && bad.error.message).toBe("Die Umsatzsteuerkorrektur ergibt nicht den Differenzbetrag.");
    const other = postEvent(paid({ amountCents: 11_800, differences: [{ reason: "other", amountCents: 100 }] }), CTX);
    expect(!other.ok && other.error.message).toBe("Für „Sonstige Differenz“ ist ein Konto anzugeben.");
  });

  test("VOU-137 CSH-022 cash payment credits the till; VOU-138 CSH-023 private payment is a Privateinlage", () => {
    expect(linesOf(paid({ means: { kind: "cash" } })).find((l) => l.role === "cash")?.creditCents).toBe(11_900);
    expect(linesOf(paid({ means: { kind: "private" } })).find((l) => l.role === "private.deposit")?.creditCents).toBe(
      11_900,
    );
    const income = postEvent(paid({ direction: "income", means: { kind: "private" } }), CTX);
    expect(!income.ok && income.error.message).toBe("Einnahmen können nicht privat bezahlt werden.");
  });
});

describe("ACC-023 foreign-currency vouchers", () => {
  const fx = {
    currency: "USD",
    grossFxCents: 12_852,
    fxRate: { rate: "1.08", source: "ecb_daily" as const, date: "2026-03-10" },
  };

  test("ACC-023 the EUR posting keeps currency, source amount and rate on the open item (expense and income)", () => {
    const lines = linesOf(booked({ fx }));
    const payable = lines.find((l) => l.role === "payable");
    expect(payable).toMatchObject({ creditCents: 11_900, currency: "USD", amountFx: 12_852, fxRate: fx.fxRate });
    expect(lines.filter((l) => l.currency !== undefined)).toHaveLength(1);
    const income = linesOf(
      booked({
        direction: "income",
        taxRule: "output_vat",
        fx,
        lines: [{ account: "8400", netCents: 10_000, vatCents: 1900, vatRateBp: 1900 }],
      }),
    );
    expect(income.find((l) => l.role === "receivable")).toMatchObject({
      debitCents: 11_900,
      currency: "USD",
      amountFx: 12_852,
    });
  });

  test("ACC-023 EUR vouchers carry no FX fields; mirrored reversals keep them", () => {
    expect(linesOf(booked()).some((l) => l.currency !== undefined)).toBe(false);
    const lines = linesOf(booked({ fx }));
    const back = reversalPosting(
      {
        kind: "voucher_reversed",
        voucherId: "v1",
        number: "BE-2026-00001",
        date: "2026-04-01",
        reason: "x",
        mode: "cancel",
      },
      { lines, text: "Beleg" },
      CTX,
    );
    expect(back.lines.find((l) => l.role === "payable")).toMatchObject({
      debitCents: 11_900,
      amountFx: 12_852,
      currency: "USD",
    });
  });
});

describe("ACC-019 cost centres on voucher postings", () => {
  test("ACC-019 a voucher line's cost centre is carried onto its expense/revenue journal line (DATEV KOST1), not onto VAT or the open item", () => {
    const lines = linesOf(
      booked({
        lines: [
          { account: "6815", netCents: 10_000, vatCents: 1900, vatRateBp: 1900, costCenterId: "kst1" },
          { account: "6805", netCents: 5000, vatCents: 950, vatRateBp: 1900 },
        ],
      }),
    );
    expect(lines.find((l) => l.account === "6815")).toMatchObject({ debitCents: 10_000, costCenterId: "kst1" });
    expect(lines.find((l) => l.account === "6805")?.costCenterId).toBeUndefined();
    const other = lines.filter((l) => l.role?.startsWith("vat.") || l.role === "payable");
    expect(other.length).toBeGreaterThan(0);
    expect(other.every((l) => l.costCenterId === undefined)).toBe(true);
    // income voucher: the revenue line keeps the cost centre
    const income = linesOf(
      booked({
        direction: "income",
        taxRule: "output_vat",
        lines: [{ account: "8400", netCents: 10_000, vatCents: 1900, vatRateBp: 1900, costCenterId: "kst2" }],
      }),
    );
    expect(income.find((l) => l.account === "8400")).toMatchObject({ creditCents: 10_000, costCenterId: "kst2" });
    // Bewirtung: both the deductible and the non-deductible part keep the cost centre
    const bew = linesOf(
      booked({
        voucherKind: "bewirtung",
        lines: [{ account: "6640", netCents: 10_000, vatCents: 1900, vatRateBp: 1900, costCenterId: "kst1" }],
      }),
    );
    const ent = bew.filter((l) => l.role?.startsWith("expense.entertainment"));
    expect(ent).toHaveLength(2);
    expect(ent.every((l) => l.costCenterId === "kst1")).toBe(true);
  });
});
