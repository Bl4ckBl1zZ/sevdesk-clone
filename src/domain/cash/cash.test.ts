import { describe, expect, test } from "vitest";
import { CASH_MESSAGES, checkCashDating } from "./dating";
import { cashMovements, cashReportCsv, projectCash } from "./movements";

const today = "2026-10-13";

describe("cash dating rules (CSH-021, EC-200)", () => {
  test("T07-146 EC-CSH-30 EC-CSH-31 today ok; 2 days back warns; 11 days back needs a reason; tomorrow is blocked", () => {
    expect(checkCashDating({ date: today, today, amountCents: 100 })).toEqual({ ok: true, value: { daysBack: 0 } });
    expect(checkCashDating({ date: "2026-10-12", today, amountCents: 100 })).toEqual({
      ok: true,
      value: { daysBack: 1 },
    });
    expect(checkCashDating({ date: "2026-10-11", today, amountCents: 100 })).toEqual({
      ok: true,
      value: { daysBack: 2, warning: CASH_MESSAGES.dailyRecording },
    });
    const late = checkCashDating({ date: "2026-10-02", today, amountCents: 100 });
    expect(late.ok ? null : late.error.message).toBe(CASH_MESSAGES.reasonRequired);
    expect(checkCashDating({ date: "2026-10-02", today, amountCents: 100, backdateReason: "Beleg verlegt" }).ok).toBe(
      true,
    );
    expect(checkCashDating({ date: "2026-10-02", today, amountCents: 100, backdateReason: "abc" }).ok).toBe(false);
    const future = checkCashDating({ date: "2026-10-14", today, amountCents: 100 });
    expect(future.ok ? null : future.error.message).toBe(CASH_MESSAGES.future);
  });

  test("T07-106 EC-CSH-06 EC-CSH-19 a date before the cash opening balance and a zero amount are blocked", () => {
    const before = checkCashDating({
      date: "2026-09-30",
      today,
      amountCents: 100,
      openingDate: "2026-10-01",
      backdateReason: "Nachtrag",
    });
    expect(before.ok ? null : before.error.message).toBe(
      "Das Datum muss zwischen dem Anfangsbestand der Kasse (01.10.2026) und heute liegen.",
    );
    const zero = checkCashDating({ date: today, today, amountCents: 0 });
    expect(zero.ok ? null : zero.error.message).toBe("Der Betrag muss größer als 0 sein.");
  });
});

describe("cash movements (CSH-020, CSH-030)", () => {
  const lines = [
    {
      date: "2026-10-01",
      seq: 1,
      debitCents: 10_000,
      creditCents: 0,
      text: "Eröffnungsbilanz",
      voucher: "Buchung 1",
      counterAccounts: ["9000"],
      entryId: "e1",
    },
    {
      date: "2026-10-09",
      seq: 4,
      debitCents: 20_000,
      creditCents: 0,
      text: "Bargeldabhebung in die Kasse",
      voucher: "Kontoauszug",
      counterAccounts: ["1360"],
      entryId: "e4",
    },
    {
      date: "2026-10-05",
      seq: 3,
      debitCents: 0,
      creditCents: 8000,
      text: "Privatentnahme aus der Kasse",
      voucher: "Eigenbeleg",
      counterAccounts: ["1800"],
      entryId: "e3",
    },
  ];

  test("CSH-020 movements in (date, seq) order with running balance", () => {
    const m = cashMovements(lines);
    expect(m.rows.map((r) => [r.date, r.inCents, r.outCents, r.balanceCents])).toEqual([
      ["2026-10-01", 10_000, 0, 10_000],
      ["2026-10-05", 0, 8000, 2000],
      ["2026-10-09", 20_000, 0, 22_000],
    ]);
    expect(m.balanceCents).toBe(22_000);
  });

  test("CSH-030 the cash report CSV carries opening and closing balance and the Gegenkonto", () => {
    const csv = cashReportCsv(cashMovements(lines).rows, "2026-10-02", "2026-10-31");
    expect(csv.split("\r\n")).toEqual([
      "﻿Datum;Beleg;Text;Einnahme;Ausgabe;Bestand;Gegenkonto",
      "02.10.2026;;Anfangsbestand;;;100,00;",
      "05.10.2026;Eigenbeleg;Privatentnahme aus der Kasse;;80,00;20,00;1800",
      "09.10.2026;Kontoauszug;Bargeldabhebung in die Kasse;200,00;;220,00;1360",
      "31.10.2026;;Endbestand;;;220,00;",
      "",
    ]);
  });

  test("CSH-026 the live projection shows the minimum balance from the planned date on (golden C2)", () => {
    const rows = [
      { date: "2026-10-01", seq: 1, debitCents: 10_000, creditCents: 0 },
      { date: "2026-10-05", seq: 2, debitCents: 0, creditCents: 8000 },
    ];
    expect(projectCash(rows, { date: "2026-10-03", amountCents: -5000 })).toEqual({
      minBalanceCents: -3000,
      minDate: "2026-10-05",
      ok: false,
    });
    expect(projectCash(rows, { date: "2026-10-06", amountCents: -2000 })).toEqual({
      minBalanceCents: 0,
      minDate: "2026-10-06",
      ok: true,
    });
  });
});
