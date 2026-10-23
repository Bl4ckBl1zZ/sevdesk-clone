import { screen } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { UsageTab } from "./usage-tab";

const backend = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));

const nb = (s: string | null) => (s ?? "").replace(/ /g, " ");

describe("UsageTab", () => {
  test("PRD-074 shows units and revenue this/last year and links every document containing the product", () => {
    backend.data = {
      "products:usage": {
        thisYear: { unitsMilli: 100_000, revenueCents: 15_000 },
        lastYear: { unitsMilli: 0, revenueCents: 0 },
        documents: [
          {
            documentId: "d1",
            number: "RE-2026-0001",
            type: "invoice",
            status: "open",
            documentDate: "2026-10-09",
            contactName: "Muster GmbH",
            quantityMilli: 100_000,
          },
          {
            documentId: "d2",
            number: null,
            type: "invoice",
            status: "draft",
            documentDate: null,
            contactName: null,
            quantityMilli: 50_000,
          },
        ],
      },
    };
    renderWithIntl(<UsageTab productId={"p1" as never} />);
    expect(nb(screen.getByTestId("product-usage-sums").textContent)).toContain("150,00 €");
    expect(screen.getByRole("link", { name: "Rechnung RE-2026-0001" })).toHaveAttribute(
      "href",
      expect.stringContaining("/d1"),
    );
    expect(screen.getByRole("link", { name: "Rechnung (Entwurf)" })).toBeInTheDocument();
    expect(screen.getByText("09.10.2026")).toBeInTheDocument();
  });
});
