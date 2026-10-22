import { screen, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { ContactReceivables } from "./contact-receivables";

const backend = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("@/components/dunning/contact-dunning-card", () => ({
  ContactDunningCard: ({ contactId }: { contactId: string }) => <div data-testid="dunning-card">{contactId}</div>,
}));

beforeEach(() => {
  backend.data = {
    "payments:contactReceivables": {
      items: [
        {
          kind: "salesDocument",
          id: "d1",
          number: "RE-2026-0007",
          contactId: "c1",
          contactName: "Muster GmbH",
          documentDate: "2026-09-01",
          dueDate: "2026-09-15",
          payableCents: 119_000,
          currency: "EUR",
          paidCents: 50_000,
          openCents: 69_000,
          daysOverdue: 27,
          overdue: true,
          bucket: "1-30",
        },
      ],
      totals: { openCents: 69_000, overdueCents: 69_000, dueWithin7Cents: 0 },
      creditCents: 1_500,
      averageDaysToPay: 12,
      paidInvoices: 3,
      behaviour: { averageDaysToPay: 14, lateShareBp: 3333, invoices: 3, from: "2025-10-24" },
      truncated: false,
      payments: [
        {
          paymentId: "p1",
          date: "2026-10-01",
          number: "RE-2026-0007",
          targetKind: "salesDocument",
          targetId: "d1",
          amountCents: 50_000,
          differencesCents: 0,
          currency: "EUR",
          source: "bank",
          reversed: false,
          reversal: false,
        },
        {
          paymentId: "p2",
          date: "2026-09-20",
          number: null,
          targetKind: "contactCredit",
          targetId: "c1",
          amountCents: 1_500,
          differencesCents: 0,
          currency: "EUR",
          source: "clearing",
          reversed: true,
          reversal: false,
        },
      ],
    },
  };
});

describe("ContactReceivables (PAY-004)", () => {
  test("PAY-004 shows open items, credit, average days to pay, payment history and the dunning cases", () => {
    renderWithIntl(<ContactReceivables contactId="c1" />);
    expect(screen.getByText("Ø Zahlungsdauer")).toBeInTheDocument();
    expect(screen.getByText("12 Tage (aus 3 Rechnungen)")).toBeInTheDocument();
    expect(screen.getByText("Guthaben", { selector: "dt" })).toBeInTheDocument();
    const items = screen.getByTestId("contact-open-items");
    expect(within(items).getByRole("link", { name: "RE-2026-0007" })).toHaveAttribute("href", "/rechnungen/d1");
    expect(within(items).getByText("27 Tage überfällig")).toBeInTheDocument();
    expect(within(items).getByText("15.09.2026")).toBeInTheDocument();
    const history = screen.getByTestId("contact-payment-history");
    expect(within(history).getAllByRole("row")).toHaveLength(3);
    expect(within(history).getByText("Bank")).toBeInTheDocument();
    expect(within(history).getByText("(storniert)")).toBeInTheDocument();
    expect(screen.getByTestId("dunning-card")).toHaveTextContent("c1");
  });

  test("PAY-004 the open-items and payment tables scroll in keyboard-focusable named regions (axe scrollable-region-focusable)", () => {
    renderWithIntl(<ContactReceivables contactId="c1" />);
    for (const name of ["Offene Posten", "Zahlungshistorie"]) {
      const region = screen.getByRole("region", { name });
      expect(region).toHaveAttribute("tabindex", "0");
      expect(within(region).getByRole("table")).toBeInTheDocument();
    }
  });

  test("PAY-004 empty customer shows the empty states", () => {
    backend.data["payments:contactReceivables"] = {
      items: [],
      totals: { openCents: 0, overdueCents: 0, dueWithin7Cents: 0 },
      creditCents: 0,
      averageDaysToPay: null,
      paidInvoices: 0,
      behaviour: null,
      truncated: false,
      payments: [],
    };
    renderWithIntl(<ContactReceivables contactId="c1" />);
    expect(screen.getByText("Keine offenen Posten.")).toBeInTheDocument();
    expect(screen.getByText("Noch keine Zahlungen erfasst.")).toBeInTheDocument();
    expect(screen.getByText("Noch keine bezahlten Rechnungen")).toBeInTheDocument();
  });

  test("PAY-008 shows the payment behaviour of the last 12 months (weighted days, late share)", () => {
    renderWithIntl(<ContactReceivables contactId="c1" />);
    expect(screen.getByText("Zahlungsverhalten (12 Monate)")).toBeInTheDocument();
    expect(screen.getByText("Ø 14 Tage (betragsgewichtet), 33,33 % verspätet – 3 Rechnungen")).toBeInTheDocument();
  });
});
