import { describe, expect, test } from "vitest";
import { lockChecklist, monthsBetween, planLock } from "./period-lock";

const clean = {
  draftsInPeriod: 0,
  pendingArtifacts: 0,
  bankDifferences: [],
  unbookedInboxItems: 0,
  unmatchedBankTransactions: 0,
  missingStatements: [],
  vouchersWithoutAttachment: 0,
  transitBalanceCents: 0,
  backdatedCash: [],
};

describe("period lock (Festschreibung)", () => {
  test("ACC-016 E-ACC-15 TST-ACC-10 locking 09 with 07–08 open locks 07–09 in one action („lückenlos“)", () => {
    const plan = planLock({
      target: "2026-09",
      fiscalYearStartMonth: 1,
      bookkeepingStartDate: "2026-07-01",
      periods: [],
    });
    expect(plan).toEqual({
      ok: true,
      value: {
        months: ["2026-07", "2026-08", "2026-09"],
        gapNotice: "Festschreibung muss lückenlos erfolgen. 07/2026 bis 08/2026 werden mit festgeschrieben.",
      },
    });
  });

  test("ACC-016 earlier months already locked: only the target month; the fiscal year start bounds the range", () => {
    const plan = planLock({
      target: "2026-03",
      fiscalYearStartMonth: 1,
      periods: [
        { period: "2026-01", status: "locked" },
        { period: "2026-02", status: "locked" },
        { period: "2025-12", status: "open" },
      ],
    });
    expect(plan).toEqual({ ok: true, value: { months: ["2026-03"] } });
    // fiscal year starting in July: locking 2026-08 covers 2026-07..08, never the previous fiscal year
    expect(planLock({ target: "2026-08", fiscalYearStartMonth: 7, periods: [] })).toMatchObject({
      ok: true,
      value: { months: ["2026-07", "2026-08"] },
    });
  });

  test("ACC-015 locks are irreversible: an already locked month cannot be locked again", () => {
    const plan = planLock({
      target: "2026-09",
      fiscalYearStartMonth: 1,
      periods: [{ period: "2026-09", status: "locked" }],
    });
    expect(plan).toMatchObject({ ok: false, error: { code: "already_locked" } });
    expect(planLock({ target: "2026-9", fiscalYearStartMonth: 1, periods: [] })).toMatchObject({
      ok: false,
      error: { code: "invalid_period" },
    });
  });

  test("ACC-017 E-ACC-16 E-ACC-17 TST-ACC-11 drafts and pending artifacts in the period are blockers", () => {
    const r = lockChecklist({ ...clean, draftsInPeriod: 2, pendingArtifacts: 1 });
    expect(r.blockers.map((b) => b.message)).toEqual([
      "Im Zeitraum gibt es 2 Entwürfe. Bitte fertigstellen oder löschen.",
      "1 Dokumente werden noch verarbeitet. Bitte warten.",
    ]);
    expect(r.ok).toBe(false);
  });

  test("ACC-017 E-ACC-33 a bank ledger balance that differs from the statement blocks the lock (2a)", () => {
    const r = lockChecklist({
      ...clean,
      bankDifferences: [{ account: "1200 Revolut EUR", date: "2026-09-30", diffCents: -1250 }],
    });
    expect(r.ok).toBe(false);
    expect(r.blockers[0]?.message).toBe(
      "Kontosaldo 1200 Revolut EUR zum 30.09.2026 weicht vom Kontoauszug ab (-12,50 €). Festschreibung nicht möglich.",
    );
  });

  test("ACC-017 E-ACC-18 warnings (3) never block: transit, unbooked items, missing statements, backdated cash", () => {
    const r = lockChecklist({
      ...clean,
      unbookedInboxItems: 3,
      unmatchedBankTransactions: 4,
      missingStatements: [{ account: "Revolut EUR", month: "2026-09" }],
      vouchersWithoutAttachment: 1,
      transitBalanceCents: 50000,
      backdatedCash: [{ label: "Bargeld eingezahlt 500,00 €", date: "2026-09-02", recordedOn: "2026-09-20" }],
    });
    expect(r.ok).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual([
      "unbooked_vouchers",
      "unmatched_bank_transactions",
      "missing_statement",
      "voucher_without_attachment",
      "transit_open",
      "backdated_cash",
    ]);
    expect(r.warnings.find((w) => w.code === "transit_open")?.message).toBe(
      "Geldtransit ist nicht ausgeglichen (500,00 €). Fehlt die Gegenbuchung?",
    );
  });

  test("ACC-015 monthsBetween enumerates calendar months across a year boundary", () => {
    expect(monthsBetween("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(monthsBetween("2026-02", "2026-01")).toEqual([]);
  });
});
