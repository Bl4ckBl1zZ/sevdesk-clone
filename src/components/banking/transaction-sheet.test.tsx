import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { TransactionSheet } from "./transaction-sheet";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown }[],
  push: [] as string[],
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, _args: unknown, enabled = true) =>
    enabled ? backend.data[getFunctionName(ref as never)] : undefined,
}));
vi.mock("convex/react", () => {
  const fn = (ref: unknown) => async (args: unknown) => {
    const name = getFunctionName(ref as never);
    backend.calls.push({ name, args });
    return name === "matchingRules:createVoucherFromTransaction" ? "v1" : null;
  };
  return { useMutation: fn, useAction: fn };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (href: string) => backend.push.push(href), replace: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const detail = (over: Record<string, unknown> = {}) => ({
  _id: "t1",
  bookingDate: "2026-10-05",
  valueDate: "2026-10-06",
  amountCents: -23_800,
  currency: "EUR",
  counterpartyName: "Büro AG",
  counterpartyIban: "DE02120300000000202051",
  purpose: "Miete Oktober",
  status: "open",
  ignoredReason: null,
  allocatedCents: 0,
  feeCents: 150,
  reversal: false,
  reversalOfId: null,
  sourceKinds: ["camt053"],
  reference: null,
  endToEndId: "E2E-4711",
  bankTransactionCode: "PMNT-ICDT-STDO",
  sources: [{ kind: "camt053", at: Date.UTC(2026, 9, 6, 8, 0), reference: "ENTRY-1" }],
  revisions: [
    {
      sourceKind: "enable_banking",
      applied: false,
      changedFields: ["purpose"],
      at: Date.UTC(2026, 9, 7, 8, 0),
      line: null,
    },
  ],
  postings: [
    {
      id: "je1",
      seq: 17,
      date: "2026-10-05",
      text: "Privatentnahme",
      explanation: "",
      reversal: true,
      lines: [
        { account: "1800", debitCents: 23_800, creditCents: 0 },
        { account: "1200", debitCents: 0, creditCents: 23_800 },
      ],
    },
  ],
  eigenbelege: [{ name: "Eigenbeleg-17.pdf", sha256: "bb", url: "https://files/eb.pdf" }],
  link: null,
  original: { id: "t0", bookingDate: "2026-09-30", amountCents: 23_800, purpose: "x" },
  reversalCandidates: [{ originalId: "t0", label: "30.09.2026 · 238,00 € · Büro AG" }],
  taxPayment: null,
  ...over,
});

beforeEach(() => {
  backend.calls = [];
  backend.push = [];
  backend.data = {
    "members:me": { role: "owner" },
    "banking:transaction": detail(),
    "matchingRules:forTransaction": { name: "Miete" },
  };
});

describe("TransactionSheet (F07 §6)", () => {
  test("BNK-113 shows booked data, postings, Eigenbelege, sources and the unapplied revision", () => {
    renderWithIntl(<TransactionSheet id={"t1" as never} currency="EUR" onClose={() => {}} />);
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText("Büro AG")).toBeInTheDocument();
    expect(within(sheet).getByText("Miete Oktober")).toBeInTheDocument();
    expect(within(sheet).getByText("DE02120300000000202051")).toBeInTheDocument();
    expect(within(sheet).getByText("06.10.2026")).toBeInTheDocument();
    expect(within(sheet).getByText("E2E-4711")).toBeInTheDocument();
    expect(within(sheet).getByText(/1,50\s€/)).toBeInTheDocument();
    expect(within(sheet).getByText("Regel: Miete")).toBeInTheDocument();
    expect(within(sheet).getByText("Buchung 17 · 05.10.2026")).toBeInTheDocument();
    expect(within(sheet).getByText(/S 1800 238,00\s€ · H 1200 238,00\s€/)).toBeInTheDocument();
    expect(within(sheet).getByRole("link", { name: "Eigenbeleg-17.pdf" })).toHaveAttribute(
      "href",
      "https://files/eb.pdf",
    );
    expect(within(sheet).getByText(/CAMT\.053 · .* · ENTRY-1/)).toBeInTheDocument();
    expect(within(sheet).getByText(/Abweichende Lieferung der Bank \(purpose\)/)).toBeInTheDocument();
  });

  test("BNK-060 „Privat“ books with the shareholder note for corporations", async () => {
    renderWithIntl(<TransactionSheet id={"t1" as never} currency="EUR" onClose={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Privat" }));
    expect(screen.getByText(/Wird als Privatentnahme gebucht\./)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Gesellschafter"), "Erika Muster");
    await user.click(screen.getByRole("button", { name: "Privat buchen" }));
    expect(backend.calls.find((c) => c.name === "banking:mark")?.args).toEqual({
      transactionId: "t1",
      as: "private",
      shareholder: { name: "Erika Muster", note: "" },
    });
  });

  test("BNK-062 „Darlehen“ sends the principal/interest split of an outgoing rate", async () => {
    renderWithIntl(<TransactionSheet id={"t1" as never} currency="EUR" onClose={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Darlehen" }));
    await user.type(screen.getByLabelText("Tilgung (€)"), "200,00");
    await user.type(screen.getByLabelText("Zinsen (€)"), "38,00");
    await user.click(screen.getByRole("button", { name: "Darlehen buchen" }));
    expect(backend.calls.find((c) => c.name === "banking:mark")?.args).toEqual({
      transactionId: "t1",
      as: "loan",
      loan: { principalCents: 20_000, interestCents: 3_800 },
    });
  });

  test("BNK-063 „Ignorieren“ as neutralised pair links the counter-entry", async () => {
    renderWithIntl(<TransactionSheet id={"t1" as never} currency="EUR" onClose={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Ignorieren" }));
    const dialog = screen.getByRole("dialog", { name: "Umsatz ignorieren" });
    const reason = within(dialog).getByLabelText("Grund") as HTMLSelectElement;
    const pair = [...reason.options].find((o) => o.value === "neutralised_pair");
    expect(pair).toBeDefined();
    await user.selectOptions(reason, "neutralised_pair");
    await user.selectOptions(within(dialog).getByLabelText("Gegenbuchung"), "t0");
    await user.click(within(dialog).getByRole("button", { name: "Ignorieren" }));
    expect(backend.calls.find((c) => c.name === "banking:mark")?.args).toEqual({
      transactionId: "t1",
      as: "ignored",
      reason: "neutralised_pair",
      linkId: "t0",
    });
  });

  test("BNK-121 a reversal candidate is linked; BNK-065 „+ Neuer Beleg“ opens the voucher draft", async () => {
    renderWithIntl(<TransactionSheet id={"t1" as never} currency="EUR" onClose={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Als Rückbuchung verknüpfen" }));
    expect(backend.calls.find((c) => c.name === "banking:linkReversalTo")?.args).toEqual({
      counterId: "t1",
      originalId: "t0",
    });
    await user.click(screen.getByRole("button", { name: "+ Neuer Beleg" }));
    expect(backend.calls.find((c) => c.name === "matchingRules:createVoucherFromTransaction")?.args).toEqual({
      transactionId: "t1",
    });
    expect(backend.push).toEqual(["/belege/v1"]);
  });

  test("BNK-122 a marked row only offers „Markierung aufheben“ with a reason (Generalumkehr)", async () => {
    backend.data["banking:transaction"] = detail({ status: "private", reversalCandidates: [], ignoredReason: null });
    renderWithIntl(<TransactionSheet id={"t1" as never} currency="EUR" onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Privat" })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Markierung aufheben" }));
    const confirm = screen.getByRole("button", { name: "Aufheben" });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText("Grund"), "Versehen beim Markieren");
    await user.click(confirm);
    expect(backend.calls.find((c) => c.name === "banking:unmark")?.args).toEqual({
      transactionId: "t1",
      reason: "Versehen beim Markieren",
    });
  });

  test("BNK-063 a viewer sees the details but no marking actions", () => {
    backend.data["members:me"] = { role: "viewer" };
    renderWithIntl(<TransactionSheet id={"t1" as never} currency="EUR" onClose={() => {}} />);
    expect(screen.getByText("Miete Oktober")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Aktionen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Neuer Beleg" })).toBeNull();
  });
});
