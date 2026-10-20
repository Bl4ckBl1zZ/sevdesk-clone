import { describe, expect, test } from "vitest";
import type { AssetDepreciationEvent, AssetDisposalEvent } from "./events";
import { type PostingContext, postEvent } from "./post";

const CTX: PostingContext = {
  taxationMethod: "soll",
  legalForm: "einzelunternehmen",
  ustvaPeriod: [{ year: 2026, period: "monthly" }],
};

const afa = (over: Partial<AssetDepreciationEvent> = {}): AssetDepreciationEvent => ({
  kind: "asset_depreciation",
  assetId: "asset1",
  inventoryNumber: "AV-00001",
  name: "Notebook",
  period: "2026-03",
  date: "2026-03-31",
  amountCents: 10_000,
  assetAccount: "0420",
  afaRole: "afa.tangible",
  ...over,
});

const disposal = (over: Partial<AssetDisposalEvent> = {}): AssetDisposalEvent => ({
  kind: "asset_disposal",
  assetId: "asset1",
  inventoryNumber: "AV-00001",
  name: "Notebook",
  date: "2026-06-15",
  disposalKind: "sale",
  assetAccount: "0420",
  rbwCents: 300_000,
  ...over,
});

const posting = (e: AssetDepreciationEvent | AssetDisposalEvent, ctx = CTX) => {
  const r = postEvent(e, ctx);
  if (!r.ok) throw new Error(r.error.message);
  if (r.value.kind !== "entry") throw new Error("no entry");
  return r.value.posting;
};

describe("AST-009 D1–D3 AfA postings", () => {
  test("AST-009 D1 monthly AfA: S afa.* · H asset account, source per (asset, period), externally dated", () => {
    const p = posting(afa());
    expect(p.lines).toEqual([
      { role: "afa.tangible", debitCents: 10_000, creditCents: 0 },
      { account: "0420", debitCents: 0, creditCents: 10_000 },
    ]);
    expect(p.source).toEqual({ kind: "asset_depreciation", id: "asset1:2026-03" });
    expect(p.explanation).toBe("D1");
    expect(p.dating).toBe("external");
    expect(p.text).toBe("AfA 03/2026 AV-00001 Notebook");
  });

  test("AST-007 D2 GWG and AST-008 D3 pool explanations", () => {
    expect(posting(afa({ afaRole: "afa.gwg", assetAccount: "0480" })).explanation).toBe("D2");
    expect(posting(afa({ afaRole: "afa.pool", assetAccount: "0485" })).explanation).toBe("D3");
  });

  test("AST-009 zero AfA posts nothing", () => {
    const r = postEvent(afa({ amountCents: 0 }), CTX);
    expect(r.ok && r.value.kind).toBe("none");
  });
});

describe("AST-010 D4–D7 disposal postings (EC-176)", () => {
  test("AST-010 TST-AST-07 EC-176 sale at book value: RBW 3,000 € to disposal.rbw.loss (D5)", () => {
    const p = posting(disposal({ gain: false }));
    expect(p.explanation).toBe("D5");
    expect(p.lines).toEqual([
      { role: "disposal.rbw.loss", debitCents: 300_000, creditCents: 0 },
      { account: "0420", debitCents: 0, creditCents: 300_000 },
    ]);
    expect(p.source).toEqual({ kind: "asset_depreciation", id: "asset1:disposal" });
  });

  test("AST-010 D4 sale with gain and D6 scrap", () => {
    expect(posting(disposal({ gain: true })).lines[0]).toEqual({
      role: "disposal.rbw.gain",
      debitCents: 300_000,
      creditCents: 0,
    });
    expect(posting(disposal({ disposalKind: "scrap" })).explanation).toBe("D6");
  });

  test("AST-010 D7 withdrawal: Wertabgabe at Teilwert with 19 % VAT (Kz 81) and RBW", () => {
    const p = posting(
      disposal({ disposalKind: "withdrawal", withdrawal: { teilwertCents: 100_000, vatCents: 19_000 } }),
    );
    expect(p.explanation).toBe("D7");
    expect(p.lines).toEqual([
      { role: "private.withdrawal", debitCents: 119_000, creditCents: 0 },
      { role: "revenue.withdrawal.19", debitCents: 0, creditCents: 100_000, taxKey: "USt19" },
      { role: "vat.output.19", debitCents: 0, creditCents: 19_000, taxPointDate: "2026-06-15", taxPeriod: "2026-06" },
      { role: "disposal.rbw.loss", debitCents: 300_000, creditCents: 0 },
      { account: "0420", debitCents: 0, creditCents: 300_000 },
    ]);
  });

  test("AST-010 D7 withdrawal by a corporation is blocked (E-ACC-30)", () => {
    const r = postEvent(disposal({ disposalKind: "withdrawal", withdrawal: { teilwertCents: 1, vatCents: 0 } }), {
      ...CTX,
      legalForm: "gmbh",
    });
    expect(!r.ok && r.error.code).toBe("private_withdrawal_corporation");
  });

  test("AST-010 a fully written-off asset scrapped posts nothing", () => {
    const r = postEvent(disposal({ disposalKind: "scrap", rbwCents: 0 }), CTX);
    expect(r.ok && r.value.kind).toBe("none");
  });
});
