import { describe, expect, test } from "vitest";
import { chartAccounts } from "../rules/accounting";
import { contactSchema, emptyContactForm } from "../schemas/contacts";
import type { CalendarDate } from "../time/calendar-date";
import { type DatevRunInput, runDatevExport } from "./run";

const accounts = (() => {
  const r = chartAccounts("SKR03", "2026-01-01" as CalendarDate);
  return r.ok ? r.value.map((a) => ({ n: a.number, auto: a.automaticVatAccount === true })) : [];
})();

const input = (useCollectiveDebtor: boolean): DatevRunInput => ({
  from: "2026-10-01",
  to: "2026-10-31",
  mode: "new",
  scope: ["revenue"],
  settings: {
    consultantNumber: 1234567,
    clientNumber: 12345,
    accountLength: 4,
    formatVersion: 13,
    personalAccounts: true,
    collectiveDebtorAccount: "69999",
    companyName: "Muster Handwerk GmbH",
  },
  years: [{ from: "2026-10-01", to: "2026-10-31", fiscalYearStart: "2026-01-01", chart: "SKR03", accounts }],
  lockedMonths: [],
  previous: [],
  entries: [
    {
      id: "e1",
      seq: 1,
      date: "2026-10-05",
      text: "Rechnung e1",
      source: { kind: "salesDocument", id: "doc-e1" },
      lines: [
        { account: "1400", role: "receivable", debitCents: 11_900, creditCents: 0, contactId: "c1" },
        { account: "8400", role: "revenue.domestic.19", debitCents: 0, creditCents: 10_000, taxKey: "USt19" },
        { account: "1776", role: "vat.output.19", debitCents: 0, creditCents: 1_900 },
      ],
    },
  ],
  belege: { "doc-e1": { belegfeld1: "RE-2026-0001", dueDate: "2026-10-19", internalId: "doc-e1" } },
  contacts: [{ id: "c1", kind: "person", number: "K-0001", displayName: "Erika Beispiel", useCollectiveDebtor }],
  docs: [],
  usedAccounts: [],
  accepted: false,
  createdAt: Date.UTC(2026, 10, 2, 9, 0, 0),
});

describe("CON-103 Sammeldebitor", () => {
  test("CON-103 the contact option is stored from the form", () => {
    const v = contactSchema.parse({
      ...emptyContactForm(),
      kind: "person",
      firstName: "Erika",
      lastName: "Beispiel",
      useCollectiveDebtor: true,
    });
    expect(v.useCollectiveDebtor).toBe(true);
  });

  test("CON-103 DATEV-02 a contact with „Sammeldebitor verwenden“ is booked on the collective debtor account, no own account is assigned", async () => {
    const own = await runDatevExport(input(false));
    expect(own.needsAccount).toEqual([{ contactId: "c1", kind: "debtor" }]);
    const collective = await runDatevExport(input(true));
    expect(collective.needsAccount).toEqual([]);
    const csv = new TextDecoder("windows-1252").decode(collective.files["EXTF_Buchungsstapel_20261001_20261031.csv"]);
    expect(csv.split("\r\n")[2]).toMatch(/^119,00;"S";"EUR";;;;69999;8400;/);
  });
});
