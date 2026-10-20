import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { AssetRegister } from "./asset-register";

const asset = {
  _id: "a1",
  inventoryNumber: "AV-0001",
  name: "Laptop",
  account: "0480",
  acquisitionDate: "2026-03-10",
  costCents: 79900,
  method: "linear",
  usefulLifeMonths: 36,
  bookValueCents: 70000,
  afaYearCents: 9900,
  status: "active",
  ruleVersion: "afa-2026.1",
};
const totals = {
  akStartCents: 0,
  additionsCents: 79900,
  disposalsCents: 0,
  afaYearCents: 9900,
  accumulatedEndCents: 9900,
  bookValueStartCents: 0,
  bookValueEndCents: 70000,
};
const data: Record<string, unknown> = {
  "assets:list": [asset],
  "assets:anlagenspiegel": {
    assets: [{ id: "a1", inventoryNumber: "AV-0001", name: "Laptop", account: "0480", ...totals }],
    groups: [{ account: "0480", count: 1, ...totals }],
    total: totals,
  },
  "assets:gwgList": [
    { id: "a2", inventoryNumber: "AV-0002", name: "Monitor", acquisitionDate: "2026-04-01", costCents: 49900 },
  ],
  "assets:detail": {
    asset,
    voucher: null,
    plan: [
      { period: "2026-03", amountCents: 2219, bookValueAfterCents: 77681, posted: null, preBook: false },
      { period: "2026-04", amountCents: 2219, bookValueAfterCents: 75462, posted: null, preBook: false },
    ],
  },
};
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, _args: unknown, enabled = true) =>
    enabled ? data[getFunctionName(ref as never)] : undefined,
}));
vi.mock("convex/react", () => ({ useMutation: () => vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

describe("Anlagen (F08 §6)", () => {
  test("AST-007 the depreciation plan scrolls in one keyboard-focusable region named „Abschreibungsplan“", async () => {
    renderWithIntl(<AssetRegister canWrite={false} />);
    await userEvent.click(screen.getAllByRole("button", { name: "AV-0001" })[0] as HTMLElement);
    const [section] = await screen.findAllByRole("region", { name: "Abschreibungsplan" });
    const scroller = section?.querySelector("table")?.parentElement as HTMLElement;
    expect(scroller).toHaveAttribute("role", "region");
    expect(scroller).toHaveAccessibleName("Abschreibungsplan");
    expect(scroller.tabIndex).toBe(0);
    // Vertical and horizontal scrolling share this one container; no unnamed, unfocusable scroller around it.
    expect(scroller.className).toMatch(/max-h-96/);
    expect(scroller.parentElement?.className ?? "").not.toMatch(/overflow/);
  });

  test.each([
    [/^Anlagenspiegel \d{4}$/, /^Anlagenspiegel/],
    [/^GWG-Verzeichnis$/, /^GWG-Verzeichnis$/],
  ])("AST-007 the %s table (wider than a phone) scrolls in a keyboard-focusable named region", async (name, tab) => {
    renderWithIntl(<AssetRegister canWrite={false} />);
    await userEvent.click(screen.getByRole("tab", { name: tab }));
    const scroller = await screen.findByRole("region", { name });
    expect(scroller.tabIndex).toBe(0);
    expect(scroller.querySelector("table")).not.toBeNull();
    expect(scroller.parentElement?.className ?? "").not.toMatch(/overflow/);
  });
});
