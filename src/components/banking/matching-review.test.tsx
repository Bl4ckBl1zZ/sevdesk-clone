import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { MatchingReview } from "./matching-review";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, args: unknown, enabled = true) => {
    if (!enabled) return undefined;
    const v = backend.data[getFunctionName(ref as never)];
    return typeof v === "function" ? v(args) : v;
  },
}));
vi.mock("convex/react", () => {
  const fn = (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue({ refunded: "pay1" });
    return backend.mutations[name];
  };
  return { useMutation: fn, useAction: fn };
});
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

/** A −238,00 debit „Erstattung RK-2026-0001“ and the open refund of the Rechnungskorrektur RK-2026-0001. */
const outTx = (id: string) => ({
  id,
  accountId: "acc1",
  accountName: "Revolut Business",
  bookingDate: "2026-10-15",
  amountCents: -23_800,
  currency: "EUR",
  openCents: 23_800,
  direction: "out",
  counterpartyName: "Muster GmbH",
  purpose: "Erstattung RK-2026-0001",
});
const refundCandidate = {
  kind: "single",
  score: 1,
  safe: true,
  reasons: ["number_in_purpose", "exact_amount", "name_similarity", "date_window"],
  labels: ["Rechnungsnr. im Verwendungszweck", "Betrag exakt", "Name ähnlich", "Datum passt"],
  allocations: [
    {
      target: { kind: "salesDocument", id: "rk1" },
      amountCents: 23_800,
      label: "Erstattung zu Rechnungskorrektur RK-2026-0001",
      contactName: "Muster GmbH",
      openCents: 23_800,
      dueDate: null,
      docType: "correction",
    },
  ],
};

beforeEach(() => {
  backend.mutations = {};
  backend.data = {
    "members:me": { role: "owner" },
    "matching:review": {
      suggestions: [{ tx: outTx("tx-out"), candidates: [refundCandidate] }],
      withoutSuggestion: [outTx("tx-none")],
      autoApplied: [],
    },
    "matching:openTargets": {
      documents: [],
      credits: [],
      refunds: [
        { kind: "salesDocument", id: "rk1", number: "RK-2026-0001", contactName: "Muster GmbH", openCents: 23_800 },
      ],
    },
  };
});

describe("Zuordnungen: refunds of credit corrections (F07 BNK-041, F05 PAY-033 b)", () => {
  test("T07-074 BNK-046 an outgoing debit shows „Erstattung zu Rechnungskorrektur …“; ✓ books the refund", async () => {
    const user = userEvent.setup();
    renderWithIntl(<MatchingReview />);
    const card = screen.getByTestId("match-card");
    expect(within(card).getByText("Erstattung", { selector: "span" })).toBeInTheDocument();
    const link = within(card).getByRole("link", { name: "Erstattung zu Rechnungskorrektur RK-2026-0001" });
    expect(link).toHaveAttribute("href", "/rechnungen/rk1");
    await user.click(within(card).getByRole("button", { name: "Bestätigen" }));
    expect(backend.mutations["matching:confirm"]).toHaveBeenCalledWith({
      transactionId: "tx-out",
      allocations: [{ target: { kind: "salesDocument", id: "rk1" }, amountCents: 23_800 }],
      score: 1,
      reasons: refundCandidate.reasons,
    });
    expect(toast.success).toHaveBeenCalledWith("Erstattung gebucht.");
  });

  test("T07-074 BNK-046 „Andere wählen“ on a debit offers open refunds and books without a remainder choice", async () => {
    const user = userEvent.setup();
    renderWithIntl(<MatchingReview />);
    await user.click(screen.getByRole("tab", { name: /Ohne Vorschlag/ }));
    await user.click(screen.getByRole("button", { name: "Andere wählen" }));
    const dialog = await screen.findByRole("dialog", { name: "Erstattung zuordnen" });
    expect(within(dialog).getByLabelText("Nummer der Rechnungskorrektur oder Kunde")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("radio", { name: /RK-2026-0001 · Muster GmbH/ }));
    expect(within(dialog).queryByText(/Restbetrag/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Bestätigen" }));
    expect(backend.mutations["matching:confirm"]).toHaveBeenCalledWith({
      transactionId: "tx-none",
      allocations: [{ target: { kind: "salesDocument", id: "rk1" }, amountCents: 23_800 }],
    });
  });
});
