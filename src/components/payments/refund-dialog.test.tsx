import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { PaymentsSection } from "./payments-section";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  previews: [] as unknown[],
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, args: unknown, enabled = true) => {
    if (!enabled) return undefined;
    const name = getFunctionName(ref as never);
    if (name === "payments:previewCorrectionRefund") backend.previews.push(args);
    const v = backend.data[name];
    return typeof v === "function" ? v(args) : v;
  },
}));
vi.mock("convex/react", () => {
  const fn = (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue({ paymentId: "pay1", date: "2026-10-16", warnings: [] });
    return backend.mutations[name];
  };
  return { useMutation: fn, useAction: fn };
});
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

/** RK-2026-0001: credit correction −238,00, nothing absorbed by the invoice → 238,00 to refund. */
const correction = (openAmountCents: number) => ({
  today: "2026-10-16",
  settlement: {
    payableCents: -23_800,
    receivedCents: 0,
    settledCents: 0,
    openAmountCents,
    paymentStatus: openAmountCents === 0 ? "paid" : "open",
  },
  displayStatus: { token: "refund_open", label: "Erstattung offen" },
  overdue: false,
  skonto: null,
  creditBalanceCents: 0,
  accounts: [{ id: "acc1", name: "Revolut Business", isDefault: true }],
  payments: [],
});

beforeEach(() => {
  backend.data = {
    "members:me": { role: "owner" },
    "payments:forDocument": correction(-23_800),
    "banking:unmatched": [
      {
        id: "tx-out",
        direction: "out",
        currency: "EUR",
        bookingDate: "2026-10-15",
        openCents: 23_800,
        counterpartyName: "Muster GmbH",
        purpose: "Erstattung RK-2026-0001",
      },
      {
        id: "tx-in",
        direction: "in",
        currency: "EUR",
        bookingDate: "2026-10-15",
        openCents: 50_000,
        counterpartyName: "Andere AG",
        purpose: "RE-2026-0002",
      },
    ],
    "payments:previewCorrectionRefund": (a: { amountCents: number }) => ({
      ok: true,
      date: "2026-10-16",
      warnings: [],
      openRefundCents: 23_800,
      openAfterCents: -23_800 + a.amountCents,
    }),
  };
  backend.mutations = {};
  backend.previews = [];
});

const renderSection = () =>
  renderWithIntl(<PaymentsSection documentId={"doc1" as never} number="RK-2026-0001" />);

describe("„Erstattung erfassen“ on a Rechnungskorrektur (PAY-033 b)", () => {
  test("PAY-033 T05-053 an open refund offers „Erstattung erfassen“ (no „Zahlung buchen“) and refunds by bank transaction", async () => {
    const user = userEvent.setup();
    renderSection();
    expect(screen.queryByTestId("record-payment")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Erstattung erfassen" }));
    const dialog = within(screen.getByTestId("refund-dialog"));
    expect(screen.getByText(/^offene Erstattung 238,00\s€$/)).toBeTruthy();
    expect((dialog.getByLabelText("Betrag (€)") as HTMLInputElement).value).toBe("238,00");
    // Only outgoing transactions are offered.
    const tx = dialog.getByLabelText("Bankumsatz (Ausgang)") as HTMLSelectElement;
    expect([...tx.options].map((o) => o.value)).toEqual(["", "tx-out"]);
    await user.selectOptions(tx, "tx-out");
    expect(dialog.getByTestId("refund-open-after").textContent).toContain("0,00");
    await user.click(screen.getByRole("button", { name: "Erstattung buchen" }));
    await waitFor(() =>
      expect(backend.mutations["payments:refundCorrection"]).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: "doc1",
          amountCents: 23_800,
          source: { kind: "bank", transactionId: "tx-out" },
          date: "2026-10-15",
        }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Erstattung gebucht.");
  });

  test("PAY-062 EC-PAY-28 „Bar erstattet“ refunds from the till and offers the Quittung afterwards", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole("button", { name: "Erstattung erfassen" }));
    await user.click(screen.getByRole("radio", { name: "Bar erstattet" }));
    expect(screen.queryByLabelText("Bankumsatz (Ausgang)")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Erstattung buchen" }));
    await waitFor(() =>
      expect(backend.mutations["payments:refundCorrection"]).toHaveBeenCalledWith(
        expect.objectContaining({ source: { kind: "cash" }, amountCents: 23_800 }),
      ),
    );
    expect(await screen.findByText("Barzahlung gebucht.")).toBeTruthy();
  });

  test("PAY-033 EC-PAY-33 a refund above the open refund shows the German error and cannot be booked", async () => {
    const user = userEvent.setup();
    backend.data["payments:previewCorrectionRefund"] = (a: { amountCents: number }) =>
      a.amountCents > 23_800
        ? { ok: false, message: "Die Erstattung übersteigt den offenen Erstattungsbetrag.", reason: "REFUND_EXCEEDS" }
        : { ok: true, date: "2026-10-16", warnings: [], openRefundCents: 23_800, openAfterCents: 0 };
    renderSection();
    await user.click(screen.getByRole("button", { name: "Erstattung erfassen" }));
    const amount = screen.getByLabelText("Betrag (€)");
    await user.clear(amount);
    await user.type(amount, "300,00");
    expect((await screen.findByTestId("refund-error")).textContent).toContain("übersteigt");
    expect((screen.getByRole("button", { name: "Erstattung buchen" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("PAY-033 a fully refunded correction (open 0) offers neither action", () => {
    backend.data["payments:forDocument"] = correction(0);
    renderSection();
    expect(screen.queryByTestId("record-refund")).toBeNull();
    expect(screen.queryByTestId("record-payment")).toBeNull();
  });

  test("PAY-033 a viewer sees the open refund but no „Erstattung erfassen“", () => {
    backend.data["members:me"] = { role: "viewer" };
    renderSection();
    expect(screen.getByTestId("open-amount").textContent).toContain("238,00");
    expect(screen.queryByTestId("record-refund")).toBeNull();
  });
});
