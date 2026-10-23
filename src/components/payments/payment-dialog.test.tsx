import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { PaymentDialog } from "./payment-dialog";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  previewArgs: [] as unknown[],
  record: vi.fn(),
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, args: unknown, enabled = true) => {
    const name = getFunctionName(ref as never);
    if (name === "payments:previewInvoicePayment") {
      if (!enabled) return undefined;
      backend.previewArgs.push(args);
    }
    return backend.data[name];
  },
}));
vi.mock("convex/react", () => ({ useMutation: () => backend.record }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const data = (over: Record<string, unknown> = {}) =>
  ({
    settlement: { openAmountCents: 119_000, payableCents: 119_000 },
    accounts: [
      { id: "acc1", name: "Revolut Business", isDefault: false },
      { id: "acc2", name: "Sparkasse", isDefault: true },
    ],
    today: "2026-10-16",
    skonto: { date: "2026-10-20", percentBp: 200 },
    ...over,
  }) as never;

const okPreview = (warnings: { code: string; message: string; ack: boolean }[] = []) => ({
  ok: true,
  plan: {
    warnings,
    rows: [
      {
        target: { kind: "invoice", id: "inv1" },
        differences: [
          { reason: "skonto", vatCorrection: [{ rateBp: 1_900, netCents: 2_000, vatCents: 380 }] },
          { reason: "bank_fees", vatCorrection: [{ rateBp: 0, netCents: 0, vatCents: 0 }] },
        ],
      },
    ],
  },
  postings: [
    {
      status: "lines",
      lines: [
        { account: "1800", debitCents: 116_620, creditCents: 0, taxKey: null },
        { account: "7300", debitCents: 2_380, creditCents: 0, taxKey: "3" },
        { account: "1200", debitCents: 0, creditCents: 119_000, taxKey: null },
      ],
    },
  ],
});

const props = () => ({
  documentId: "inv1" as never,
  number: "RE-2026-0042",
  onClose: vi.fn(),
  onRecorded: vi.fn(),
});

beforeEach(() => {
  backend.data = {
    "banking:unmatched": [
      {
        id: "tx1",
        direction: "in",
        currency: "EUR",
        bookingDate: "2026-10-14",
        openCents: 120_000,
        counterpartyName: "Muster GmbH",
        purpose: "RE-2026-0042",
      },
      {
        id: "tx2",
        direction: "out",
        currency: "EUR",
        bookingDate: "2026-10-13",
        openCents: 5_000,
        counterpartyName: null,
        purpose: "Miete",
      },
    ],
    "payments:previewInvoicePayment": okPreview(),
  };
  backend.previewArgs = [];
  backend.record = vi.fn().mockResolvedValue({ paymentIds: ["pay1"] });
  vi.clearAllMocks();
});

// The dialog moves the initial focus asynchronously; set the amount directly instead of racing it with keystrokes.
const setAmount = (value: string) => fireEvent.change(screen.getByLabelText("Betrag (€)"), { target: { value } });
const lastArgs = () => backend.previewArgs.at(-1) as Record<string, unknown>;

describe("„Zahlung buchen“ dialog (F05 §6.1)", () => {
  test("PAY-015 the full payment defaults to the open amount and the default account and shows the booking preview", async () => {
    const user = userEvent.setup();
    const p = props();
    renderWithIntl(<PaymentDialog {...p} data={data()} />);
    const dialog = screen.getByRole("dialog", { name: "Zahlung buchen · RE-2026-0042" });
    expect(dialog).toHaveTextContent("offen 1.190,00 €");
    expect(screen.getByLabelText("Zahlungskonto")).toHaveValue("acc2");
    expect(screen.getByLabelText("Betrag (€)")).toHaveValue("1.190,00");
    // Only incoming EUR transactions are offered.
    const tx = screen.getByLabelText("Bankumsatz");
    expect(
      within(tx)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["ohne Bankumsatz (manuell erfassen)", "14.10.2026 · 1.200,00 € · Muster GmbH"]);
    const preview = screen.getByTestId("booking-preview");
    expect(preview).toHaveTextContent("1800 1.166,20 € S");
    expect(preview).toHaveTextContent("7300 23,80 € S · 3");
    expect(preview).toHaveTextContent("1200 1.190,00 € H");
    expect(screen.getByText(/USt-Korrektur: 19 %: netto 20,00 € · USt 3,80 €/)).toBeInTheDocument();
    expect(lastArgs()).toEqual({
      documentId: "inv1",
      source: { kind: "clearing", accountId: "acc2" },
      date: "2026-10-16",
      amountCents: 119_000,
      acknowledgeWarnings: [],
    });
    await user.type(screen.getByLabelText("Notiz (optional)"), "Überweisung");
    await user.click(within(dialog).getByRole("button", { name: "Zahlung buchen" }));
    await waitFor(() =>
      expect(backend.record).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 119_000, note: "Überweisung" }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Zahlung gebucht.");
    expect(p.onRecorded).toHaveBeenCalledWith({ paymentIds: ["pay1"], cash: false });
  });

  test("PAY-021 a short payment within the period can be booked as Skonto", async () => {
    const user = userEvent.setup();
    renderWithIntl(<PaymentDialog {...props()} data={data()} />);
    setAmount("1166,20");
    const group = screen.getByRole("group", { name: "Differenz 23,80 €" });
    expect(within(group).getByRole("radio", { name: "Teilzahlung – Rest bleibt offen" })).toBeChecked();
    const skonto = within(group).getByRole("radio", { name: "Skonto (2 % bis 20.10.2026)" });
    expect(skonto).toBeEnabled();
    await user.click(skonto);
    expect(lastArgs()).toMatchObject({
      amountCents: 116_620,
      differences: [{ reason: "skonto", amountCents: 2_380 }],
    });
  });

  test("PAY-022 Skonto after the period is not selectable", async () => {
    const user = userEvent.setup();
    renderWithIntl(<PaymentDialog {...props()} data={data({ skonto: { date: "2026-10-10", percentBp: 200 } })} />);
    setAmount("1166,20");
    expect(screen.getByRole("radio", { name: "Skonto (2 % bis 10.10.2026) – Frist überschritten" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "Forderungsausfall" }));
    await user.selectOptions(screen.getByLabelText("Grund des Forderungsausfalls"), "insolvency");
    expect(lastArgs()).toMatchObject({
      differences: [{ reason: "write_off", amountCents: 2_380, subReason: "insolvency" }],
    });
    await user.click(screen.getByRole("radio", { name: "Sonstige Preisminderung" }));
    await user.type(screen.getByLabelText("Grund (mind. 5 Zeichen)"), "Mängel");
    await user.type(screen.getByLabelText("Buchungskonto"), "4730");
    expect(lastArgs()).toMatchObject({
      differences: [{ reason: "other", amountCents: 2_380, text: "Mängel", account: "4730" }],
    });
  });

  test("PAY-030 choosing a bank transaction fixes the date and offers to leave the excess unallocated", async () => {
    const user = userEvent.setup();
    renderWithIntl(<PaymentDialog {...props()} data={data()} />);
    await user.selectOptions(screen.getByLabelText("Bankumsatz"), "tx1");
    expect(screen.getByLabelText("Datum")).toBeDisabled();
    expect(screen.getByLabelText("Datum")).toHaveValue("2026-10-14");
    expect(screen.getByText("Fixiert durch den Bankumsatz (Buchungstag).")).toBeInTheDocument();
    setAmount("1200");
    const group = screen.getByRole("group", { name: "Mehrbetrag 10,00 €" });
    expect(within(group).getByRole("radio", { name: "als Guthaben des Kunden" })).toBeChecked();
    await user.click(within(group).getByRole("radio", { name: "auf dem Bankumsatz nicht zugeordnet lassen" }));
    expect(lastArgs()).toMatchObject({
      source: { kind: "bank", transactionId: "tx1" },
      date: "2026-10-14",
      amountCents: 120_000,
      excess: { mode: "unallocated" },
    });
  });

  test("EC-PAY-38 „1.234“ is read as thousands and shown back; more than 2 decimals is rejected", async () => {
    const user = userEvent.setup();
    renderWithIntl(<PaymentDialog {...props()} data={data()} />);
    const amount = screen.getByLabelText("Betrag (€)");
    setAmount("1.234");
    expect(screen.getByTestId("amount-hint")).toHaveTextContent("= 1.234,00 €");
    setAmount("12,345");
    expect(amount).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("amount-hint")).toHaveClass("text-destructive");
    expect(screen.getByRole("button", { name: "Zahlung buchen" })).toBeDisabled();
  });

  test("PAY-061 a backdated cash payment warns about daily recording and needs a reason", async () => {
    const user = userEvent.setup();
    const p = props();
    renderWithIntl(<PaymentDialog {...p} data={data()} />);
    await user.click(screen.getByRole("radio", { name: "Bar" }));
    expect(screen.queryByLabelText("Zahlungskonto")).toBeNull();
    fireEvent.change(screen.getByLabelText("Datum"), { target: { value: "2026-10-01" } });
    expect(screen.getByRole("status")).toHaveTextContent("Bareinnahmen sind täglich aufzuzeichnen");
    await user.type(screen.getByLabelText("Begründung für nachträgliche Erfassung"), "Beleg nachgereicht");
    expect(lastArgs()).toMatchObject({
      source: { kind: "cash" },
      date: "2026-10-01",
      backdateReason: "Beleg nachgereicht",
    });
    await user.click(screen.getByRole("button", { name: "Zahlung buchen" }));
    await waitFor(() => expect(p.onRecorded).toHaveBeenCalledWith({ paymentIds: ["pay1"], cash: true }));
  });

  test("PAY-015 preview warnings must be acknowledged; an invalid preview shows its error", async () => {
    const user = userEvent.setup();
    backend.data["payments:previewInvoicePayment"] = okPreview([
      { code: "contact_mismatch", message: "Der Zahler weicht vom Rechnungsempfänger ab.", ack: true },
      { code: "info", message: "Die Rechnung ist danach bezahlt.", ack: false },
    ]);
    const { unmount } = renderWithIntl(<PaymentDialog {...props()} data={data()} />);
    expect(screen.getByText("Die Rechnung ist danach bezahlt.")).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Zahlung buchen" });
    expect(confirm).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Der Zahler weicht vom Rechnungsempfänger ab." }));
    expect(lastArgs()).toMatchObject({ acknowledgeWarnings: ["contact_mismatch"] });
    expect(confirm).toBeEnabled();
    unmount();
    backend.data["payments:previewInvoicePayment"] = { ok: false, message: "Die Rechnung ist bereits bezahlt." };
    renderWithIntl(<PaymentDialog {...props()} data={data()} />);
    expect(screen.getByTestId("payment-error")).toHaveTextContent("Die Rechnung ist bereits bezahlt.");
    expect(screen.getByRole("button", { name: "Zahlung buchen" })).toBeDisabled();
  });
});
