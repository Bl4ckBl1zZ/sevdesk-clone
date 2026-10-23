import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { MatchingRules } from "./matching-rules";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, args: unknown) => {
    const v = backend.data[getFunctionName(ref as never)];
    return typeof v === "function" ? v(args) : v;
  },
}));
vi.mock("convex/react", () => {
  const fn = (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.calls[name] ??= vi.fn().mockResolvedValue({ id: "r1", mode: "auto", warning: null });
    return backend.calls[name];
  };
  return { useMutation: fn, useAction: fn };
});
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/catalog/shared", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useCan: () => true,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const rule = {
  _id: "r1",
  name: "Kontoführung Revolut",
  priority: 10,
  enabled: true,
  mode: "auto",
  when: { purposeContains: "plan fee", direction: "out" },
  apply: { action: "categorize", account: "6855", statementSufficesAsVoucher: true },
  createdVia: "ui",
  hits90: 3,
};

beforeEach(() => {
  backend.calls = {};
  backend.data = {
    "matchingRules:list": [rule],
    "matchingRules:suggestions": [],
    "banking:accounts": [],
    "contacts:options": [],
    "matchingRules:preview": (args: { when: Record<string, unknown> }) => ({
      count: args.when.purposeContains ? 1 : 0,
      message: `Diese Regel würde ${args.when.purposeContains ? "1 Umsatz" : "0 Umsätze"} der letzten 90 Tage treffen`,
      hits: args.when.purposeContains
        ? [
            {
              id: "t1",
              accountId: "a1",
              bookingDate: "2026-10-01",
              amountCents: -1500,
              currency: "EUR",
              counterpartyName: null,
              purpose: "Monthly plan fee",
              status: "open",
            },
          ]
        : [],
    }),
  };
});

describe("Einstellungen › Bank › Regeln (BNK-050, BNK-051)", () => {
  test("BNK-050 the list shows priority, mode badge and the hits of the last 90 days", () => {
    renderWithIntl(<MatchingRules />);
    expect(screen.getByText("Kontoführung Revolut")).toBeVisible();
    expect(screen.getByText("Automatik")).toBeVisible();
    expect(screen.getByText(/3 Treffer in 90 Tagen/)).toBeVisible();
  });

  test("BNK-051 EC-BNK-70 the editor previews live, flags an unsafe regex and offers „Auf offene Umsätze anwenden“", async () => {
    const user = userEvent.setup();
    renderWithIntl(<MatchingRules />);
    await user.click(screen.getByRole("button", { name: "Regel „Kontoführung Revolut“ bearbeiten" }));
    expect(await screen.findByText("Diese Regel würde 1 Umsatz der letzten 90 Tage treffen")).toBeVisible();
    await user.type(screen.getByLabelText("Verwendungszweck (regulärer Ausdruck)"), "(a+)+");
    expect(
      screen.getByText("Ungültiger regulärer Ausdruck: verschachtelte Wiederholungen sind nicht erlaubt."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
    await user.clear(screen.getByLabelText("Verwendungszweck (regulärer Ausdruck)"));
    await user.click(screen.getByRole("button", { name: "Auf 1 offenen Umsatz anwenden" }));
    expect(backend.calls["matchingRules:applyToExisting"]).toHaveBeenCalledWith({
      ruleId: "r1",
      transactionIds: ["t1"],
    });
  });

  test("BNK-053 a proposed rule opens the editor prefilled; saving creates it", async () => {
    backend.data["matchingRules:suggestions"] = [
      {
        key: "iban:DE02120300000000202051|private",
        name: "Max Muster",
        count: 3,
        transactionIds: ["t1", "t2", "t3"],
        when: { ibanEquals: "DE02120300000000202051", direction: "out" },
        apply: { action: "private" },
        message: "3 Umsätze von „Max Muster“ wurden gleich zugeordnet – Regel anlegen?",
      },
    ];
    const user = userEvent.setup();
    renderWithIntl(<MatchingRules />);
    expect(screen.getByText("3 Umsätze von „Max Muster“ wurden gleich zugeordnet – Regel anlegen?")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Regel für „Max Muster“ anlegen" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Max Muster");
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    expect(backend.calls["matchingRules:create"]).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Max Muster",
        when: { ibanEquals: "DE02120300000000202051", direction: "out" },
        apply: { action: "private" },
      }),
    );
  });
});
