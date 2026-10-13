import { describe, expect, test } from "vitest";
import { inStatementPeriod, reconcileStatement } from "./reconcile";
import { statementTodos } from "./todos";

const OCT = {
  periodFrom: "2026-10-01",
  periodTo: "2026-10-31",
  periodStartUtc: "2026-10-01T00:00:00Z",
  periodEndUtc: "2026-10-31T23:59:59Z",
  openingBalanceCents: 100_000,
  closingBalanceCents: 90_000,
  currency: "EUR",
};

describe("statement reconciliation (BNK-030)", () => {
  test("T07-041 EC-156 closing equals opening + booked rows of the period → reconciled", () => {
    const r = reconcileStatement({
      statement: OCT,
      fileRowIds: ["a", "b"],
      missing: [],
      rows: [
        { id: "a", amountCents: -15_000, bookingDate: "2026-10-05" },
        { id: "b", amountCents: 5000, bookingDate: "2026-10-20" },
        { id: "z", amountCents: 999, bookingDate: "2026-11-02" },
      ],
    });
    expect(r).toEqual({ reconciled: true, expectedClosingCents: 90_000, diffCents: 0, differences: [] });
  });

  test("T07-041 EC-BNK-41 a missing transaction produces a difference list and the German message", () => {
    const r = reconcileStatement({
      statement: OCT,
      fileRowIds: ["a", "b"],
      missing: [{ line: 12, amountCents: 5000, detail: "20.10.2026 Beta AG (mögliche Dublette)" }],
      rows: [
        { id: "a", amountCents: -15_000, bookingDate: "2026-10-05" },
        { id: "x", amountCents: -2000, bookingDate: "2026-10-09" },
      ],
    });
    expect(r.reconciled).toBe(false);
    expect(r.diffCents).toBe(7000);
    expect(r.differences).toEqual([
      { kind: "missing", detail: "Zeile 12: 20.10.2026 Beta AG (mögliche Dublette)", amountCents: 5000 },
      { kind: "extra", detail: "09.10.2026 nicht im Kontoauszug enthalten", transactionId: "x", amountCents: -2000 },
    ]);
    expect(r.message).toBe(
      "Kontoauszug Oktober 2026 stimmt nicht mit den Umsätzen überein: Differenz 70,00 € (2 Abweichungen).",
    );
  });

  test("T07-042 EC-155 the period end is compared on the UTC instant: 2026-10-31T23:30Z belongs to October", () => {
    const row = { id: "h", amountCents: -2380, bookingDate: "2026-11-01", bookedAtRaw: "2026-10-31T23:30:00Z" };
    expect(inStatementPeriod(row, OCT)).toBe(true);
    expect(inStatementPeriod({ ...row, bookedAtRaw: "2026-11-01T00:00:00Z" }, OCT)).toBe(false);
    expect(inStatementPeriod({ id: "d", amountCents: 1, bookingDate: "2026-10-31" }, OCT)).toBe(true);
  });

  test("BNK-035 a statement without closing balance cannot be reconciled („Saldo nicht prüfbar“)", () => {
    const { closingBalanceCents: _c, ...noClosing } = OCT;
    const r = reconcileStatement({ statement: noClosing, fileRowIds: [], missing: [], rows: [] });
    expect(r).toMatchObject({ reconciled: false, message: "Saldo nicht prüfbar" });
  });
});

describe("monthly statement to-do (BNK-030, EC-156)", () => {
  const accounts = [
    { id: "eur", name: "Revolut EUR", kind: "bank" as const, startDate: "2026-09-01" },
    { id: "usd", name: "Revolut USD", kind: "bank" as const, startDate: "2026-10-01" },
    { id: "clr", name: "Verrechnung", kind: "clearing" as const, startDate: "2026-01-01" },
  ];
  const sept = { accountId: "eur", periodFrom: "2026-09-01", periodTo: "2026-09-30", hasPdf: true };

  test("T07-040 EC-BNK-40 on 2026-11-03 a to-do for October per currency account; nothing before the 3rd", () => {
    expect(statementTodos(accounts, [sept], "2026-11-02").filter((t) => t.month === "2026-10")).toEqual([]);
    const todos = statementTodos(accounts, [sept], "2026-11-03");
    expect(todos).toEqual([
      {
        accountId: "eur",
        month: "2026-10",
        kind: "statement_missing",
        severity: "info",
        title: "Kontoauszug Oktober 2026 importieren (CAMT.053 + PDF signiert)",
      },
      {
        accountId: "usd",
        month: "2026-10",
        kind: "statement_missing",
        severity: "info",
        title: "Kontoauszug Oktober 2026 importieren (CAMT.053 + PDF signiert)",
      },
    ]);
  });

  test("T07-040 EC-BNK-40 after the 10th the to-do escalates to a warning", () => {
    const todos = statementTodos(accounts, [sept], "2026-11-11");
    expect(todos[0]).toMatchObject({ severity: "warning", title: "Kontoauszug Oktober 2026 für Revolut EUR fehlt." });
  });

  test("T07-054 EC-BNK-52 an imported statement without the signed PDF → „PDF-Kontoauszug fehlt“", () => {
    const oct = { accountId: "eur", periodFrom: "2026-10-01", periodTo: "2026-10-31", hasPdf: false };
    const usd = { accountId: "usd", periodFrom: "2026-10-01", periodTo: "2026-10-31", hasPdf: true };
    expect(statementTodos(accounts, [sept, oct, usd], "2026-11-05")).toEqual([
      {
        accountId: "eur",
        month: "2026-10",
        kind: "pdf_missing",
        severity: "warning",
        title: "Für Oktober 2026 fehlt der signierte PDF-Kontoauszug.",
      },
    ]);
  });

  test("EC-156 partial coverage of a month still counts as missing; rolled-back statements do not count", () => {
    const half = { accountId: "usd", periodFrom: "2026-10-01", periodTo: "2026-10-15", hasPdf: true };
    const rolled = {
      accountId: "eur",
      periodFrom: "2026-10-01",
      periodTo: "2026-10-31",
      hasPdf: true,
      rolledBack: true,
    };
    const todos = statementTodos(accounts, [sept, half, rolled], "2026-11-05");
    expect(todos.map((t) => [t.accountId, t.kind])).toEqual([
      ["eur", "statement_missing"],
      ["usd", "statement_missing"],
    ]);
  });
});
