import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { ChartOfAccounts } from "./chart-of-accounts";
import { JournalViewer } from "./journal-viewer";
import { ManualEntryEditor } from "./manual-entry-editor";
import { OpeningBalanceWizard } from "./opening-balance-wizard";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  paginatedArgs: [] as unknown[],
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never);
    if (name === "accounting:searchJournal") backend.paginatedArgs.push(args);
    return backend.data[name];
  },
  useAuthedPaginatedQuery: (ref: unknown, args: unknown) => {
    backend.paginatedArgs.push(args);
    return { results: backend.data[getFunctionName(ref as never)] ?? [], status: "Exhausted", loadMore: vi.fn() };
  },
}));
vi.mock("convex/react", () => ({
  useConvex: () => ({ query: vi.fn().mockResolvedValue([]) }),
  useMutation: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue({ status: "posted", seq: 1 });
    return backend.mutations[name];
  },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/banking/shared", () => ({ uploadFile: vi.fn().mockResolvedValue("storage1") }));

const entry = {
  id: "e1",
  seq: 1,
  date: "2026-03-10",
  period: "2026-03",
  text: "Rechnung RE-1001",
  source: { kind: "salesDocument", id: "d1", label: "Verkaufsbeleg" },
  ruleVersion: "posting-2026.1",
  roleMappingVersion: "roles-2026.2",
  explanation: "S1",
  explanationText: "Rechnung (Soll-Versteuerung): Forderung an Erlöse und Umsatzsteuer.",
  totalCents: 119000,
  lines: [
    {
      account: "1400",
      accountName: "Forderungen aus L+L",
      role: "receivables",
      roleLabel: "Forderungen",
      debitCents: 119000,
      creditCents: 0,
    },
    {
      account: "8400",
      accountName: "Erlöse 19 % USt",
      role: "revenue.19",
      roleLabel: "Erlöse 19 % USt",
      debitCents: 0,
      creditCents: 100000,
      taxKey: "USt19",
    },
    {
      account: "1776",
      accountName: "Umsatzsteuer 19 %",
      role: "vat.output.19",
      roleLabel: "USt 19 %",
      debitCents: 0,
      creditCents: 19000,
      taxPointDate: "2026-03-10",
    },
  ],
  reversedBySeq: 2,
  recordedAt: Date.UTC(2026, 2, 10, 9, 0),
  actor: "user:owner",
  locked: false,
};

beforeEach(() => {
  backend.mutations = {};
  backend.paginatedArgs = [];
  toast.success.mockReset();
  toast.error.mockReset();
  backend.data = {
    "accounting:listJournal": [entry],
    "accounting:searchJournal": { page: [entry], total: 1, offset: 0, limit: 50, totalCents: 119000 },
    "accounting:chartOfAccounts": {
      fiscalYear: 2026,
      from: "2026-01-01",
      to: "2026-12-31",
      chart: "SKR03",
      journalEntries: true,
      accounts: [
        {
          number: "1000",
          name: "Kasse",
          type: "asset",
          automaticVatAccount: false,
          euerKey: "NONE",
          bwaGroup: "NONE",
          verified: true,
          debitCents: 0,
          creditCents: 0,
          balanceCents: 0,
          used: false,
          roles: ["cash"],
        },
        {
          number: "1200",
          name: "Bank – Revolut",
          type: "bank",
          automaticVatAccount: false,
          euerKey: "NONE",
          bwaGroup: "NONE",
          verified: true,
          debitCents: 50000,
          creditCents: 0,
          balanceCents: 50000,
          used: true,
          roles: [],
          incomplete: true,
        },
        {
          number: "8400",
          name: "Erlöse 19 % USt",
          type: "revenue",
          automaticVatAccount: true,
          euerKey: "BE.UMSATZ",
          bwaGroup: "UMSATZ",
          verified: true,
          debitCents: 0,
          creditCents: 100000,
          balanceCents: -100000,
          used: true,
          roles: ["revenue.19"],
        },
        {
          number: "8100",
          name: "Steuerfreie Umsätze",
          type: "revenue",
          automaticVatAccount: false,
          euerKey: "BE.UMSATZ",
          bwaGroup: "UMSATZ",
          verified: false,
          debitCents: 0,
          creditCents: 0,
          balanceCents: 0,
          used: false,
          roles: [],
        },
      ],
      roles: [
        {
          role: "revenue.19",
          label: "Erlöse 19 % USt",
          account: "8400",
          accountName: "Erlöse 19 % USt",
          source: "seed",
          uncertain: false,
          unmapped: false,
        },
        {
          role: "revenue.zero_pv",
          label: "Erlöse 0 % (Photovoltaik)",
          account: null,
          accountName: null,
          source: "seed",
          uncertain: false,
          unmapped: true,
        },
        {
          role: "vat.prior_year",
          label: "USt Vorjahr",
          account: "1790",
          accountName: "USt Vorjahr",
          source: "seed",
          uncertain: true,
          unmapped: false,
        },
      ],
    },
    "accounting:openingBalanceStatus": {
      fiscalYear: 2026,
      date: "2026-01-01",
      bookkeepingStartDate: null,
      canChangeBookkeepingStart: true,
      cash: { seq: 1, totalCents: 25000 },
      banks: [
        {
          id: "b1",
          name: "Revolut EUR",
          iban: "DE89370400440532013000",
          currency: "EUR",
          ledgerAccount: "1200",
          posted: null,
        },
      ],
      receivables: null,
      openingItems: [],
    },
  };
});

describe("Journal (F08 §6)", () => {
  test("ACC-001 ACC-003 lists entries and opens the side sheet with lines and „Warum dieses Konto?“", async () => {
    renderWithIntl(<JournalViewer />);
    const table = screen.getByRole("table", { name: "Buchungsjournal" });
    expect(within(table).getByText("10.03.2026")).toBeInTheDocument();
    expect(within(table).getByText("1.190,00 €")).toBeInTheDocument();
    await userEvent.click(within(table).getByRole("button", { name: "Buchung 1 öffnen" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("heading", { name: "Warum dieses Konto?" })).toBeInTheDocument();
    expect(within(sheet).getByText(entry.explanationText)).toBeInTheDocument();
    expect(within(sheet).getByText("Storniert durch Nr. 2")).toBeInTheDocument();
    expect(within(sheet).getByText(/posting-2026\.1/)).toBeInTheDocument();
    expect(within(sheet).getByText(/Steuerzeitpunkt 10\.03\.2026/)).toBeInTheDocument();
    // read-only: no edit or delete actions anywhere
    expect(screen.queryByRole("button", { name: /Bearbeiten|Löschen/ })).toBeNull();
  });

  test("ACC-025 the month, source and amount filters are passed to the search query", async () => {
    renderWithIntl(<JournalViewer />);
    const month = screen.getByLabelText("Monat");
    await userEvent.type(month, "2026-03");
    expect(backend.paginatedArgs.at(-1)).toEqual({ from: "2026-03-01", to: "2026-03-31", limit: 50 });
    await userEvent.selectOptions(screen.getByLabelText("Herkunft"), "manual");
    await userEvent.type(screen.getByLabelText("Betrag ab (€)"), "100");
    await userEvent.click(screen.getByRole("checkbox", { name: "Nur Nachbuchungen" }));
    expect(backend.paginatedArgs.at(-1)).toEqual({
      from: "2026-03-01",
      to: "2026-03-31",
      sourceKind: "manual",
      minCents: 10_000,
      late: true,
      limit: 50,
    });
    expect(screen.getByText("1 Buchung · Summe 1.190,00 €")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buchungsjournal (CSV)" })).toBeInTheDocument();
  });

  test("ACC-011 „Manuelle Buchung“ and „Gegenbuchung“ appear only with write access and only for manual entries", async () => {
    const manual = { ...entry, id: "e9", seq: 9, source: { kind: "manual", id: "m1", label: "Manuelle Buchung" } };
    const { reversedBySeq: _r, ...open } = manual;
    backend.data["accounting:searchJournal"] = { page: [open], total: 1, offset: 0, limit: 50, totalCents: 119000 };
    const { unmount } = renderWithIntl(<JournalViewer />);
    expect(screen.queryByRole("link", { name: "Manuelle Buchung" })).toBeNull();
    await userEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "Buchung 9 öffnen" }));
    expect(within(await screen.findByRole("dialog")).queryByRole("button", { name: "Gegenbuchung" })).toBeNull();
    unmount();

    renderWithIntl(<JournalViewer canWrite />);
    expect(screen.getByRole("link", { name: "Manuelle Buchung" })).toHaveAttribute("href", "/buchhaltung/journal/neu");
    await userEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "Buchung 9 öffnen" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Gegenbuchung" }));
    const dialog = await screen.findByRole("dialog", { name: "Gegenbuchung zu Buchung 9" });
    await userEvent.type(within(dialog).getByLabelText("Grund"), "Falsches Konto");
    await userEvent.click(within(dialog).getByRole("button", { name: "Gegenbuchung buchen" }));
    expect(backend.mutations["manualEntries:reverse"]).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: "e9", reason: "Falsches Konto" }),
    );
  });
});

describe("Manuelle Buchung (F08 §6 /buchhaltung/journal/neu)", () => {
  test("ACC-011 E-ACC-01 E-ACC-02 live balance, net/VAT preview and booking only with a Beleg", async () => {
    backend.data["manualEntries:templates"] = [];
    backend.data["lookups:listCostCenters"] = [];
    backend.data["contacts:options"] = [];
    const roles = (backend.data["accounting:chartOfAccounts"] as { roles: unknown[] }).roles;
    roles.push({ role: "vat.output.19", label: "USt 19 %", account: "1776", source: "seed", uncertain: false });
    renderWithIntl(<ManualEntryEditor />);
    expect(screen.getByText("Manuelle Buchungen bitte am Desktop erfassen.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Buchungstext"), "Bareinnahme");
    await userEvent.type(screen.getByLabelText("Konto Zeile 1"), "1200");
    await userEvent.type(screen.getByLabelText("Soll Zeile 1"), "119");
    await userEvent.type(screen.getByLabelText("Konto Zeile 2"), "8400");
    await userEvent.type(screen.getByLabelText("Haben Zeile 2"), "100");
    expect(screen.getByText("Soll 119,00 € · Haben 100,00 € · Differenz 19,00 €")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Haben Zeile 2"));
    await userEvent.type(screen.getByLabelText("Haben Zeile 2"), "119");
    await userEvent.selectOptions(screen.getByLabelText("Steuerschlüssel Zeile 2"), "USt19");
    expect(screen.getByText("Soll 119,00 € · Haben 119,00 € · Differenz 0,00 €")).toBeInTheDocument();
    const preview = screen.getByRole("table", { name: "Vorschau der Journalzeilen" });
    expect(within(preview).getByText("100,00 €")).toBeInTheDocument();
    expect(within(preview).getByText("19,00 €")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Buchen" });
    expect(submit).toBeDisabled();
    await userEvent.upload(
      screen.getByLabelText(/Beleg hierher ziehen/),
      new File(["%PDF"], "quittung.pdf", { type: "application/pdf" }),
    );
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    expect(backend.mutations["manualEntries:create"]).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Bareinnahme",
        lines: [
          { account: "1200", debitCents: 11_900, creditCents: 0 },
          { account: "8400", debitCents: 0, creditCents: 11_900, taxKey: "USt19" },
        ],
        attachments: [{ storageId: "storage1", name: "quittung.pdf" }],
      }),
    );
  });
});

describe("Eigene Konten (F08 ACC-009)", () => {
  test("ACC-009 create a custom account and archive a used account (write access only)", async () => {
    const { unmount } = renderWithIntl(<ChartOfAccounts isOwner={false} />);
    expect(screen.queryByRole("button", { name: "Konto anlegen" })).toBeNull();
    unmount();
    renderWithIntl(<ChartOfAccounts isOwner={false} canWrite />);
    await userEvent.click(screen.getByRole("button", { name: "Konto anlegen" }));
    const dialog = await screen.findByRole("dialog", { name: "Eigenes Sachkonto anlegen" });
    await userEvent.type(within(dialog).getByLabelText("Kontonummer (4-stellig)"), "4999");
    await userEvent.type(within(dialog).getByLabelText("Bezeichnung"), "Software-Abos");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(backend.mutations["accounting:createAccount"]).toHaveBeenCalledWith({
      number: "4999",
      name: "Software-Abos",
      type: "expense",
    });
    backend.mutations["accounting:removeAccount"] = vi.fn().mockResolvedValue({ action: "archive" });
    const table = screen.getByRole("table", { name: "Konten" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(within(table).getByRole("button", { name: "Konto 8400 entfernen" }));
    const confirm = await screen.findByRole("dialog", { name: "Konto 8400 entfernen" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Archivieren" }));
    expect(backend.mutations["accounting:removeAccount"]).toHaveBeenCalledWith({ number: "8400" });
    expect(toast.success).toHaveBeenCalledWith("Konto archiviert.");
  });
});

describe("Kontenplan (F08 §6)", () => {
  test("ACC-007 shows accounts with balances, the ⚠ for unverified accounts and filters to used accounts", async () => {
    renderWithIntl(<ChartOfAccounts isOwner={false} />);
    expect(screen.getByText("Kontenrahmen SKR03 · Wirtschaftsjahr 01.01.2026 – 31.12.2026")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Konten" });
    expect(within(table).getByText("−1.000,00 €")).toBeInTheDocument();
    expect(within(table).getAllByText(/⚠ ungeprüft/)).toHaveLength(1);
    await userEvent.click(screen.getByLabelText("Nur bebuchte Konten"));
    expect(within(table).queryByText("Kasse")).toBeNull();
  });

  test("ACC-027 a bank ledger balance with unjournalised transactions is labelled „unvollständig (P1)“", () => {
    renderWithIntl(<ChartOfAccounts isOwner={false} />);
    expect(screen.getAllByText("unvollständig (P1)").length).toBeGreaterThan(0);
  });

  test("ACC-008 TST-ACC-39 the roles tab flags unmapped and uncertain roles; only the owner may assign", async () => {
    const { unmount } = renderWithIntl(<ChartOfAccounts isOwner={false} />);
    await userEvent.click(screen.getByRole("tab", { name: /Rollen & Standardkonten/ }));
    const list = screen.getByRole("list", { name: "Rollen und Standardkonten" });
    expect(within(list).getByText("nicht zugeordnet")).toBeInTheDocument();
    expect(within(list).getByText("⚠ prüfen")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Konto zuordnen/ })).toBeNull();
    unmount();

    renderWithIntl(<ChartOfAccounts isOwner />);
    await userEvent.click(screen.getByRole("tab", { name: /Rollen & Standardkonten/ }));
    await userEvent.click(screen.getByRole("button", { name: /Konto zuordnen.*Photovoltaik/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(dialog).getByLabelText("Konto"), "8100");
    await userEvent.clear(within(dialog).getByLabelText("Gültig ab"));
    await userEvent.type(within(dialog).getByLabelText("Gültig ab"), "2026-01-01");
    await userEvent.type(within(dialog).getByLabelText("Begründung oder Quelle"), "PV-Nullsatz geprüft");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(backend.mutations["accounting:setRoleMapping"]).toHaveBeenCalledWith({
      role: "revenue.zero_pv",
      account: "8100",
      validFrom: "2026-01-01",
      sourceText: "PV-Nullsatz geprüft",
    });
  });
});

describe("Eröffnungsbilanz (F08 §6)", () => {
  test("ACC-013 posted parts show their entry; a bank balance is parsed from German input and posted once", async () => {
    renderWithIntl(<OpeningBalanceWizard canPost isOwner />);
    expect(screen.getByText("Gebucht (Nr. 1, 250,00 €)")).toBeInTheDocument();
    const input = screen.getByLabelText("Anfangssaldo Revolut EUR");
    await userEvent.type(input, "abc");
    await userEvent.click(screen.getByRole("button", { name: "Anfangssaldo Revolut EUR buchen" }));
    expect(screen.getByText("Bitte einen gültigen Betrag eingeben, z. B. 1.234,56.")).toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, "2.500,10");
    await userEvent.click(screen.getByRole("button", { name: "Anfangssaldo Revolut EUR buchen" }));
    expect(backend.mutations["accounting:postOpeningBalancePart"]).toHaveBeenCalledWith({
      fiscalYear: 2026,
      part: { kind: "bank", bankAccountId: "b1", amountCents: 250010 },
    });
    expect(toast.success).toHaveBeenCalledWith("Eröffnungsbuchung erstellt.");
  });

  test("ACC-013 TST-ACC-09 open receivables (one Ist with not-yet-due VAT) are posted as one part", async () => {
    renderWithIntl(<OpeningBalanceWizard canPost isOwner />);
    await userEvent.click(screen.getByRole("button", { name: "Forderung hinzufügen" }));
    const item = screen.getByRole("group", { name: "Forderung 1" });
    await userEvent.type(within(item).getByLabelText("Rechnungsnr."), "SD-1002");
    await userEvent.type(within(item).getByLabelText("Kunde"), "Kunde B");
    await userEvent.type(within(item).getByLabelText("Rechnungsdatum"), "2025-12-20");
    await userEvent.type(within(item).getByLabelText("Brutto"), "595,00");
    await userEvent.selectOptions(within(item).getByLabelText("Umsatzsteuer"), "ist");
    await userEvent.type(within(item).getByLabelText("Enthaltene, noch nicht abgeführte USt"), "95,00");
    await userEvent.click(screen.getByRole("button", { name: "Offene Forderungen buchen" }));
    expect(backend.mutations["accounting:postOpeningBalancePart"]).toHaveBeenCalledWith({
      fiscalYear: 2026,
      part: {
        kind: "receivables",
        items: [
          {
            number: "SD-1002",
            counterpartyName: "Kunde B",
            documentDate: "2025-12-20",
            grossCents: 59500,
            openCents: 59500,
            taxedAs: "ist",
            notDueVat: [{ rateBp: 1900, vatCents: 9500 }],
          },
        ],
      },
    });
  });

  test("ACC-014 ACC-008 viewers see the values read-only; the Buchungsbeginn is editable for the owner until the first posting", async () => {
    renderWithIntl(<OpeningBalanceWizard canPost={false} isOwner={false} />);
    expect(screen.queryByRole("button", { name: /buchen/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Übernehmen" })).toBeNull();
    expect(screen.getByText("Nicht gesetzt – die Buchhaltung beginnt mit dem Wirtschaftsjahr.")).toBeInTheDocument();
  });

  test("ACC-014 E-ACC-14 the owner sets the Buchungsbeginn", async () => {
    renderWithIntl(<OpeningBalanceWizard canPost isOwner />);
    await userEvent.type(screen.getByLabelText("Buchungsbeginn"), "2026-04-01");
    await userEvent.click(screen.getByRole("button", { name: "Übernehmen" }));
    expect(backend.mutations["accounting:setBookkeepingStartDate"]).toHaveBeenCalledWith({ date: "2026-04-01" });
  });
});
