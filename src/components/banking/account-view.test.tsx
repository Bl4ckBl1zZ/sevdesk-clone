import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { BankAccountView } from "./account-view";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown }[],
  page: { results: [] as unknown[], status: "Exhausted" as string, loadMore: (_n: number) => {} },
  params: new URLSearchParams(),
  replace: [] as string[],
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, _args: unknown, enabled = true) =>
    enabled ? backend.data[getFunctionName(ref as never)] : undefined,
}));
vi.mock("convex/react", () => {
  const fn = (ref: unknown) => async (args: unknown) => {
    const name = getFunctionName(ref as never);
    backend.calls.push({ name, args });
    return null;
  };
  return {
    useMutation: fn,
    useAction: fn,
    useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
    usePaginatedQuery: (ref: unknown, args: unknown) => {
      backend.calls.push({ name: `paginated:${getFunctionName(ref as never)}`, args });
      return backend.page;
    },
  };
});
vi.mock("next/navigation", () => ({
  useSearchParams: () => backend.params,
  usePathname: () => "/bank/acc1",
  useRouter: () => ({ replace: (href: string) => backend.replace.push(href), push: vi.fn() }),
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const tx = (id: string, over: Record<string, unknown> = {}) => ({
  _id: id,
  bookingDate: "2026-10-05",
  valueDate: null,
  amountCents: 119_000,
  currency: "EUR",
  counterpartyName: "Muster GmbH",
  counterpartyIban: null,
  purpose: "RE-2026-0042",
  status: "open",
  ignoredReason: null,
  allocatedCents: 0,
  feeCents: null,
  reversal: false,
  reversalOfId: null,
  sourceKinds: ["camt053"],
  ...over,
});

const statement = {
  id: "st1",
  periodFrom: "2026-09-01",
  periodTo: "2026-09-30",
  format: "camt053",
  statementRef: null,
  openingBalanceCents: 100_000,
  closingBalanceCents: 219_000,
  expectedClosingCents: 218_000,
  diffCents: 1_000,
  reconciled: false,
  message: "Endsaldo weicht um 10,00 € ab.",
  differences: [{ kind: "missing", detail: "Umsatz vom 12.09.2026 fehlt", amountCents: 1_000 }],
  continuity: null,
  rolledBack: false,
  uploadedAt: Date.UTC(2026, 9, 2, 10, 0),
  retentionUntil: "2036-12-31",
  hasPdf: false,
  files: [{ name: "camt-2026-09.xml", sha256: "aa", bytes: 10, kind: "data", url: "https://files/camt.xml" }],
};

const imp = {
  id: "imp1",
  at: Date.UTC(2026, 9, 2, 10, 0),
  fileName: "revolut-2026-09.csv",
  source: "revolut_csv",
  periodFrom: "2026-09-01",
  periodTo: "2026-09-30",
  counts: { inserted: 12, duplicates: 2, mergedCrossSource: 1, possibleDuplicates: 1 },
  rolledBackAt: null,
  continuityOk: true,
};

beforeEach(() => {
  backend.calls = [];
  backend.replace = [];
  backend.params = new URLSearchParams();
  backend.page = {
    results: [tx("t1"), tx("t2", { counterpartyName: null, amountCents: -5_000 })],
    status: "CanLoadMore",
    loadMore: vi.fn(),
  };
  backend.data = {
    "members:me": { role: "owner" },
    "banking:account": {
      id: "acc1",
      name: "Revolut EUR",
      currency: "EUR",
      iban: "DE89370400440532013000",
      archived: false,
    },
    "banking:possibleDuplicates": [],
    "bankFeed:pending": [
      {
        id: "p1",
        bookingDate: "2026-10-20",
        counterpartyName: "Tankstelle",
        purpose: "Karte",
        amountCents: -4_210,
        currency: "EUR",
      },
    ],
    "banking:statements": [statement],
    "banking:imports": [imp],
    "banking:transaction": null,
    "matchingRules:forTransaction": null,
  };
});

describe("BankAccountView (F07 §6)", () => {
  test("BNK-120 Umsätze tab lists the normalised rows with formatted dates and amounts; filters go to the URL", async () => {
    renderWithIntl(<BankAccountView id="acc1" />);
    expect(screen.getByRole("heading", { name: "Revolut EUR" })).toBeInTheDocument();
    expect(screen.getByText("EUR · DE89370400440532013000")).toBeInTheDocument();
    expect(screen.getAllByText("05.10.2026").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1\.190,00\s€/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("ohne Gegenpartei").length).toBeGreaterThan(0);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Richtung"), "out");
    expect(backend.replace.at(-1)).toBe("/bank/acc1?dir=out");
    await user.click(screen.getByRole("button", { name: "Weitere laden" }));
    expect(backend.page.loadMore).toHaveBeenCalledWith(50);
  });

  test("BNK-111 pending feed rows are shown in the separate „Vorgemerkt (nicht gebucht)“ group", () => {
    backend.params = new URLSearchParams("status=open&dir=in&from=2026-10-01&to=2026-10-31&q=Muster");
    renderWithIntl(<BankAccountView id="acc1" />);
    expect(screen.getByText("Vorgemerkt (nicht gebucht) (1)")).toBeInTheDocument();
    expect(screen.getByText(/20\.10\.2026 · Tankstelle/)).toBeInTheDocument();
    const listCall = backend.calls.find((c) => c.name === "paginated:banking:transactions");
    expect(listCall?.args).toEqual({
      accountId: "acc1",
      status: "open",
      direction: "in",
      from: "2026-10-01",
      to: "2026-10-31",
      q: "Muster",
    });
  });

  test("BNK-120 empty selection shows the empty state; unknown account shows the not-found alert", () => {
    backend.page = { results: [], status: "Exhausted", loadMore: vi.fn() };
    const { unmount } = renderWithIntl(<BankAccountView id="acc1" />);
    expect(screen.getByText("Keine Umsätze für diese Auswahl.")).toBeInTheDocument();
    unmount();
    backend.data["banking:account"] = null;
    renderWithIntl(<BankAccountView id="acc1" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Das Bankkonto wurde nicht gefunden.");
  });

  test("BNK-035 Kontoauszüge tab shows balances, the difference and attaches the signed PDF (BNK-030)", async () => {
    backend.params = new URLSearchParams("tab=statements");
    renderWithIntl(<BankAccountView id="acc1" />);
    expect(screen.getByText("01.09.2026 – 30.09.2026")).toBeInTheDocument();
    expect(screen.getByText("nicht abgestimmt")).toBeInTheDocument();
    expect(screen.getByText(/2\.190,00\s€/)).toBeInTheDocument();
    expect(screen.getByText("Endsaldo weicht um 10,00 € ab.")).toBeInTheDocument();
    expect(screen.getByText(/Umsatz vom 12\.09\.2026 fehlt/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Datei: camt-2026-09.xml" })).toHaveAttribute(
      "href",
      "https://files/camt.xml",
    );
    expect(screen.getByText(/aufzubewahren bis 31\.12\.2036/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Signiertes PDF anhängen" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Anhängen" })).toBeDisabled();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ storageId: "s1" }) });
    vi.stubGlobal("fetch", fetchMock);
    await user.upload(
      within(dialog).getByLabelText("PDF-Kontoauszug"),
      new File(["%PDF"], "auszug.pdf", { type: "application/pdf" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Anhängen" }));
    expect(backend.calls.find((c) => c.name === "banking:attachStatementPdf")?.args).toEqual({
      statementId: "st1",
      storageId: "s1",
      name: "auszug.pdf",
    });
    vi.unstubAllGlobals();
  });

  test("BNK-036 Importe tab: counts and „Import zurücknehmen“ needs a reason", async () => {
    backend.params = new URLSearchParams("tab=imports");
    renderWithIntl(<BankAccountView id="acc1" />);
    expect(screen.getByText("revolut-2026-09.csv")).toBeInTheDocument();
    expect(screen.getByText(/12 neu, 3 vorhanden, 1 mögliche Dubletten/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Import zurücknehmen" }));
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Import zurücknehmen" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Grund"), "falsches Konto");
    await user.click(confirm);
    expect(backend.calls.find((c) => c.name === "banking:rollback")?.args).toEqual({
      importId: "imp1",
      reason: "falsches Konto",
    });
  });

  test("BNK-036 a viewer sees imports and statements without write buttons", () => {
    backend.data["members:me"] = { role: "viewer" };
    backend.data["banking:imports"] = [
      imp,
      { ...imp, id: "imp2", fileName: null, rolledBackAt: Date.UTC(2026, 9, 3, 8, 0) },
    ];
    backend.params = new URLSearchParams("tab=imports");
    renderWithIntl(<BankAccountView id="acc1" />);
    expect(screen.queryByRole("button", { name: "Import zurücknehmen" })).toBeNull();
    expect(screen.getByText(/Zurückgenommen am/)).toBeInTheDocument();
  });

  test("BNK-030 empty archives show their empty states", () => {
    backend.data["banking:statements"] = [];
    backend.params = new URLSearchParams("tab=statements");
    const { unmount } = renderWithIntl(<BankAccountView id="acc1" />);
    expect(screen.getByText("Noch keine Kontoauszüge archiviert.")).toBeInTheDocument();
    unmount();
    backend.data["banking:imports"] = [];
    backend.params = new URLSearchParams("tab=imports");
    renderWithIntl(<BankAccountView id="acc1" />);
    expect(screen.getByText("Noch keine Importe.")).toBeInTheDocument();
  });
});
