import { describe, expect, test } from "vitest";
import {
  BWA_GROUPS,
  CHARTS_LIST,
  chartAccounts,
  EUER_KEYS,
  lookupChart,
  ROLE_MAPPING_ROWS,
  seededAccount,
} from "../rules/accounting";
import { calendarDate } from "../time/calendar-date";
import { type ResolveContext, resolveLines, resolveRole, roleMappingView } from "./resolve";
import { parseRole, roleLabel, STATIC_ROLES, UNCERTAIN_ROLES, UNSURE_ROLES } from "./roles";

const d = calendarDate("2026-06-30");
const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({
  chart: "SKR03",
  date: d,
  overrides: [],
  bankAccounts: [{ id: "bank1", ledgerAccount: "1200" }],
  ...over,
});

describe("chart seed and role mapping (ACC-007, ACC-008, DATEV-02)", () => {
  test("TST-ACC-08 ACC-007 every mapped role resolves to a seeded account with EÜR key and BWA group in both charts", () => {
    for (const chart of CHARTS_LIST) {
      for (const row of ROLE_MAPPING_ROWS) {
        const number = row[chart];
        if (number === null) continue;
        const account = seededAccount(chart, d, number);
        expect(account, `${chart} ${row.role} → ${number}`).not.toBeNull();
        expect(EUER_KEYS).toContain(account?.euerKey);
        expect(BWA_GROUPS).toContain(account?.bwaGroup);
      }
      const accounts = chartAccounts(chart, d);
      expect(accounts.ok).toBe(true);
      const list = accounts.ok ? accounts.value : [];
      expect(new Set(list.map((a) => a.number)).size).toBe(list.length);
      for (const a of list) {
        expect(a.number, a.name).toMatch(/^\d{4}$/);
        expect(EUER_KEYS).toContain(a.euerKey);
        expect(BWA_GROUPS).toContain(a.bwaGroup);
      }
    }
  });

  test("DATEV-02 the shipped defaults match F08 §4.1.1 (SKR03 default; spot checks incl. ⚠ rows)", () => {
    const at = (role: string) => ROLE_MAPPING_ROWS.find((r) => r.role === role);
    expect(at("receivable")).toMatchObject({ SKR03: "1400", SKR04: "1200" });
    expect(at("cash")).toMatchObject({ SKR03: "1000", SKR04: "1600" });
    expect(at("revenue.domestic.19")).toMatchObject({ SKR03: "8400", SKR04: "4400" });
    expect(at("revenue.ku")).toMatchObject({ SKR03: "8195", SKR04: "4185" });
    expect(at("vat.output.notdue.19")).toMatchObject({ SKR03: "1766", SKR04: "3816", uncertain: true });
    expect(at("private.withdrawal")).toMatchObject({ SKR03: "1800", SKR04: "2100" });
    expect(UNSURE_ROLES).toEqual(["vat.input.notyet", "shareholder.clearing", "revenue.zero_pv"]);
    expect(UNCERTAIN_ROLES).toContain("income.other_nontaxable");
    expect(seededAccount("SKR03", d, "8400")?.automaticVatAccount).toBe(true);
    expect(lookupChart("SKR03", calendarDate("2019-12-31")).ok).toBe(false);
  });

  test("ACC-008 roles are static names or bank.<accountId>; labels are German", () => {
    expect(parseRole("receivable")).toEqual({ kind: "static", role: "receivable" });
    expect(parseRole("bank.k57abc")).toEqual({ kind: "bank", bankAccountId: "k57abc", fx: false });
    expect(parseRole("bank.k57abc.fx")).toEqual({ kind: "bank", bankAccountId: "k57abc", fx: true });
    expect(parseRole("nonsense").kind).toBe("unknown");
    expect(roleLabel("bank.x")).toBe("Bankkonto");
    expect(roleLabel("bank.x.fx")).toBe("Fremdwährungskonto");
    expect(roleLabel("cash")).toBe("Kasse");
    expect(roleLabel("zzz")).toBe("zzz");
    for (const role of STATIC_ROLES) expect(roleLabel(role), role).not.toBe(role);
  });
});

describe("role resolution (ACC-008)", () => {
  test("ACC-008 roles resolve per chart; bank roles use the bank account's ledger account", () => {
    const r = resolveLines(
      [
        { role: "bank.bank1", debitCents: 100, creditCents: 0 },
        { role: "receivable", debitCents: 0, creditCents: 100, contactId: "c1" },
      ],
      ctx({ chart: "SKR04", bankAccounts: [{ id: "bank1", ledgerAccount: "1800" }] }),
    );
    expect(r.ok && r.value).toEqual({
      lines: [
        { role: "bank.bank1", account: "1800", debitCents: 100, creditCents: 0 },
        { role: "receivable", account: "1200", debitCents: 0, creditCents: 100, contactId: "c1" },
      ],
      roleMappingVersion: "roles-2026.2",
    });
  });

  test("TST-ACC-39 an UNSURE role blocks the posting until the owner maps it; the override wins from its validFrom", () => {
    const line = [
      { role: "receivable", debitCents: 100, creditCents: 0 },
      { role: "revenue.zero_pv", debitCents: 0, creditCents: 100 },
    ];
    const blocked = resolveLines(line, ctx());
    expect(!blocked.ok && blocked.error).toMatchObject({
      code: "role_unmapped",
      message:
        "Für „Erlöse 0 % (§ 12 Abs. 3 UStG, Photovoltaik)“ ist noch kein Konto zugeordnet. Bitte unter Buchhaltung → Konten → Rollen ein Konto anlegen oder zuordnen.",
    });
    const override = {
      chart: "SKR03" as const,
      role: "revenue.zero_pv",
      account: "8100",
      validFrom: "2026-01-01",
      mappingVersion: "override-1",
    };
    const mapped = resolveLines(line, ctx({ overrides: [override] }));
    expect(mapped.ok && mapped.value.lines[1]?.account).toBe("8100");
    expect(mapped.ok && mapped.value.roleMappingVersion).toBe("roles-2026.2+override-1");
    const notYet = resolveLines(line, ctx({ overrides: [{ ...override, validFrom: "2026-07-01" }] }));
    expect(notYet.ok).toBe(false);
    const otherChart = resolveLines(line, ctx({ overrides: [{ ...override, chart: "SKR04" }] }));
    expect(otherChart.ok).toBe(false);
    const later = { ...override, account: "8120", mappingVersion: "override-2", validFrom: "2026-03-01" };
    const r2 = resolveLines(line, ctx({ overrides: [override, later] }));
    expect(r2.ok && r2.value.lines[1]?.account).toBe("8120");
  });

  test("E-ACC-06 unknown/archived accounts and unknown roles are refused", () => {
    const unknownBank = resolveRole("bank.nope", ctx());
    expect(!unknownBank.ok && unknownBank.error.code).toBe("account_unknown");
    const archived = resolveRole(
      "bank.bank1",
      ctx({ bankAccounts: [{ id: "bank1", ledgerAccount: "1200", archived: true }] }),
    );
    expect(!archived.ok && archived.error.message).toBe("Konto 1200 ist archiviert und kann nicht bebucht werden.");
    expect(resolveRole("weird.role", ctx()).ok).toBe(false);
    const badAccount = resolveLines(
      [
        { account: "4711", debitCents: 1, creditCents: 0 },
        { role: "receivable", debitCents: 0, creditCents: 1 },
      ],
      ctx(),
    );
    expect(!badAccount.ok && badAccount.error.message).toBe("Konto 4711 ist im Kontenrahmen SKR03 nicht vorhanden.");
    const noTarget = resolveLines([{ debitCents: 1, creditCents: 0 }], ctx());
    expect(noTarget.ok).toBe(false);
    const tooEarly = resolveLines(
      [{ role: "receivable", debitCents: 1, creditCents: 0 }],
      ctx({ date: calendarDate("2019-01-01") }),
    );
    expect(!tooEarly.ok && tooEarly.error.code).toBe("rule_missing");
  });

  test("ACC-008 „Rollen & Standardkonten“ view marks ⚠ rows, unmapped UNSURE rows and overrides", () => {
    const view = roleMappingView(
      ctx({
        overrides: [
          {
            chart: "SKR03",
            role: "shareholder.clearing",
            account: "0880",
            validFrom: "2026-01-01",
            mappingVersion: "override-1",
            sourceText: "Gesellschafter A",
          },
        ],
      }),
    );
    expect(view.find((v) => v.role === "revenue.zero_pv")).toMatchObject({ unmapped: true, account: null });
    expect(view.find((v) => v.role === "vat.output.notdue.19")).toMatchObject({ uncertain: true, account: "1766" });
    expect(view.find((v) => v.role === "shareholder.clearing")).toMatchObject({
      source: "override",
      account: "0880",
      accountName: "Variables Kapital",
      sourceText: "Gesellschafter A",
    });
    expect(view.length).toBe(STATIC_ROLES.length);
  });
});
