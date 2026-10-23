import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { VoucherBulkBar } from "./voucher-bulk-bar";
import { BookDialog } from "./voucher-payment";
import { VouchersList } from "./vouchers-list";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  args: {} as Record<string, unknown[]>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never);
    backend.args[name] = [...(backend.args[name] ?? []), args];
    const d = backend.data[name];
    return typeof d === "function" ? (d as (a: unknown) => unknown)(args) : d;
  },
}));
vi.mock("@/components/catalog/shared", async (orig) => {
  const actual = await orig<typeof import("@/components/catalog/shared")>();
  return {
    ...actual,
    useCan: () => true,
    useUrlState: () => ({ get: () => "", hrefWith: () => "/belege", set: vi.fn() }),
    useAuthedPaginatedQuery: (ref: unknown) => ({
      results: backend.data[getFunctionName(ref as never)] ?? [],
      status: "Exhausted",
      loadMore: vi.fn(),
    }),
  };
});
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue({ number: "BE-2026-00001" });
    return backend.mutations[name];
  },
  useAction: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue({ voucherId: "v1", index: 0 });
    return backend.mutations[name];
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const preview = (payment?: { method: string; date?: string; amountCents?: number }) => ({
  id: "v1",
  version: 3,
  errors: [],
  warnings: [] as { code: string; message: string; acknowledge: boolean }[],
  infos: [],
  effectiveTaxRule: "input_vat_deductible",
  effectiveTaxRuleLabel: "Vorsteuer abziehbar",
  totals: { netCents: 10_000, vatCents: 1900, grossCents: 11_900 },
  totalsEur: { netCents: 10_000, vatCents: 1900, grossCents: 11_900 },
  inputVatAtRisk: [],
  payment: { method: payment?.method ?? "bank", date: payment?.date ?? "2026-10-10", amountCents: 11_900 },
  corporation: false,
  cash: payment?.method === "cash" ? { balanceCents: 50_000, balanceAfterCents: 38_100 } : null,
  journal: {
    status: "lines",
    text: "Telefon",
    lines: [
      { account: "6805", debitCents: 10_000, creditCents: 0 },
      { account: "1406", debitCents: 1900, creditCents: 0 },
      { account: "3300", debitCents: 0, creditCents: 11_900 },
    ],
  },
});

beforeEach(() => {
  backend.data = {};
  backend.args = {};
  backend.mutations = {};
  vi.clearAllMocks();
});

describe("VOU-136 „Buchen“ with „Bezahlt mit“", () => {
  test("VOU-136 VOU-137 the button follows the choice; cash shows the till before/after and books in one call", async () => {
    backend.data["vouchers:preview"] = (a: { payment?: { method: string } }) => preview(a.payment);
    const onClose = vi.fn();
    renderWithIntl(
      <BookDialog id={"v1" as never} version={3} direction="expense" corporation={false} onClose={onClose} />,
    );
    expect(screen.getByRole("button", { name: "Buchen" })).toBeEnabled();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    await userEvent.click(screen.getByRole("radio", { name: "Bar bezahlt" }));
    expect(screen.getByRole("button", { name: "Buchen – bar bezahlt" })).toBeEnabled();
    expect(screen.getByTestId("cash-balance")).toHaveTextContent("500,00 € → danach 381,00 €");
    expect(screen.getByTestId("journal-preview")).toHaveTextContent("6805");
    await userEvent.click(screen.getByRole("button", { name: "Buchen – bar bezahlt" }));
    expect(backend.mutations["vouchers:finalize"]).toHaveBeenCalledWith({
      id: "v1",
      version: 3,
      payment: { method: "cash" },
    });
    expect(toast.success).toHaveBeenCalledWith("Beleg BE-2026-00001 gebucht");
  });

  test("VOU-007 ⚑ warnings must be acknowledged; errors block the button", async () => {
    backend.data["vouchers:preview"] = () => ({
      ...preview(),
      warnings: [{ code: "input_vat_at_risk", message: "Vorsteuerabzug gefährdet.", acknowledge: true }],
    });
    renderWithIntl(
      <BookDialog id={"v1" as never} version={3} direction="expense" corporation={false} onClose={vi.fn()} />,
    );
    const book = screen.getByRole("button", { name: "Buchen" });
    expect(book).toBeDisabled();
    await userEvent.click(screen.getByLabelText("Warnungen gelesen – trotzdem buchen"));
    expect(book).toBeEnabled();
    await userEvent.click(book);
    expect(backend.mutations["vouchers:finalize"]).toHaveBeenCalledWith({
      id: "v1",
      version: 3,
      acknowledgeWarnings: ["input_vat_at_risk"],
    });
  });

  test("VOU-138 VOU-010 corporations see „Vom Gesellschafter bezahlt“; income offers Bank and Bar only", async () => {
    backend.data["vouchers:preview"] = (a: { payment?: { method: string } }) => preview(a.payment);
    const { unmount } = renderWithIntl(
      <BookDialog id={"v1" as never} version={3} direction="expense" corporation onClose={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("radio", { name: "Vom Gesellschafter bezahlt" }));
    expect(screen.getByText(/Verrechnungskonto Gesellschafter/)).toBeInTheDocument();
    unmount();
    renderWithIntl(
      <BookDialog id={"v1" as never} version={3} direction="income" corporation={false} onClose={vi.fn()} />,
    );
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("value"))).toEqual(["bank", "cash"]);
  });
});

describe("VOU-100 VOU-111 Belege list", () => {
  test("VOU-100 drafts can be selected for the batch queue; tabs show the counts", async () => {
    backend.data["vouchers:counts"] = {
      all: 2,
      draft: 1,
      open: 1,
      overdue: 0,
      partially_paid: 0,
      paid: 0,
      cancelled: 0,
      unbooked: 1,
    };
    backend.data["vouchers:list"] = [
      {
        _id: "d1",
        status: "draft",
        statusLabel: "Entwurf",
        direction: "expense",
        kind: "standard",
        internalNumber: null,
        documentNumber: "RE-1",
        supplierName: "Büro Schmidt",
        documentDate: "2026-10-01",
        dueDate: null,
        overdue: false,
        currency: "EUR",
        grossCents: 11_900,
        grossEurCents: 11_900,
        openAmountCents: 11_900,
        taxRule: "input_vat_deductible",
        taxRuleLabel: "Vorsteuer abziehbar",
        hasFile: true,
        receivedAt: 0,
      },
      {
        _id: "o1",
        status: "open",
        statusLabel: "Offen",
        direction: "expense",
        kind: "standard",
        internalNumber: "BE-2026-00001",
        documentNumber: "RE-2",
        supplierName: "Telekom",
        documentDate: "2026-09-01",
        dueDate: "2026-09-15",
        overdue: true,
        currency: "EUR",
        grossCents: 5000,
        grossEurCents: 5000,
        openAmountCents: 5000,
        taxRule: "input_vat_deductible",
        taxRuleLabel: "Vorsteuer abziehbar",
        hasFile: false,
        receivedAt: 0,
      },
    ];
    renderWithIntl(<VouchersList />);
    expect(screen.getByRole("link", { name: /Unbearbeitet > 10 Tage/ })).toHaveTextContent("1");
    expect(screen.queryByTestId("open-queue")).toBeNull();
    // Only drafts are selectable.
    const boxes = screen.getAllByRole("checkbox", { name: /auswählen/ });
    expect(boxes).toHaveLength(1);
    await userEvent.click(boxes[0] as HTMLElement);
    expect(screen.getByTestId("open-queue")).toHaveAttribute("href", "/belege/warteschlange?ids=d1");
    expect(screen.getByTestId("open-queue")).toHaveTextContent("1 Beleg nacheinander bearbeiten");
    expect(screen.getByTestId("vouchers-table").querySelector("[data-status=overdue]")).not.toBeNull();
    expect(screen.getByTestId("vouchers-table")).toHaveTextContent("169,00 €");
  });
});

describe("VOU-101 bulk actions on drafts", () => {
  test("VOU-101 set account and tax rule on the selection; skipped vouchers are listed with the reason", async () => {
    const onDone = vi.fn();
    renderWithIntl(<VoucherBulkBar ids={["d1", "d2"]} onDone={onDone} />);
    backend.mutations["vouchers:bulkUpdate"] = vi.fn().mockResolvedValue({
      updated: ["d1"],
      skipped: [{ id: "d2", label: "BE-2026-00002", reason: "Nur Entwürfe können geändert werden." }],
    });
    await userEvent.click(screen.getByTestId("bulk-set"));
    const apply = screen.getByRole("button", { name: "Übernehmen" });
    expect(apply).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Konto (alle Positionen)"), "6815");
    await userEvent.selectOptions(screen.getByLabelText("Steuerregel"), "no_input_vat");
    await userEvent.click(apply);
    expect(backend.mutations["vouchers:bulkUpdate"]).toHaveBeenCalledWith({
      ids: ["d1", "d2"],
      patch: { account: "6815", taxRule: "no_input_vat" },
    });
    expect(toast.success).toHaveBeenCalledWith("1 Entwurf geändert");
    expect(toast.warning).toHaveBeenCalledWith("1 Beleg übersprungen", {
      description: "BE-2026-00002: Nur Entwürfe können geändert werden.",
    });
    expect(onDone).toHaveBeenCalled();
  });

  test("VOU-101 „Sammelbuchung“ starts the background job; delete asks first", async () => {
    renderWithIntl(<VoucherBulkBar ids={["d1"]} onDone={vi.fn()} />);
    backend.mutations["vouchers:startBulkFinalize"] = vi.fn().mockResolvedValue({ jobId: "j1" });
    backend.mutations["vouchers:bulkDelete"] = vi.fn().mockResolvedValue({ deleted: ["d1"], skipped: [] });
    await userEvent.click(screen.getByTestId("bulk-book"));
    await userEvent.click(screen.getByRole("button", { name: "Sammelbuchung starten" }));
    expect(backend.mutations["vouchers:startBulkFinalize"]).toHaveBeenCalledWith({ ids: ["d1"] });
    expect(toast.success).toHaveBeenCalledWith("Sammelbuchung gestartet – Fortschritt unter Export › Aufträge");
    await userEvent.click(screen.getByTestId("bulk-delete"));
    expect(backend.mutations["vouchers:bulkDelete"]).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Entwürfe löschen" }));
    expect(backend.mutations["vouchers:bulkDelete"]).toHaveBeenCalledWith({ ids: ["d1"] });
    expect(toast.success).toHaveBeenCalledWith("1 Entwurf gelöscht");
  });

  test("VOU-101 no bar without a selection", () => {
    const { container } = renderWithIntl(<VoucherBulkBar ids={[]} onDone={vi.fn()} />);
    expect(container.querySelector("fieldset")).toBeNull();
  });
});
