import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { InvoicingDeadlineBadge } from "./invoices-list";

describe("QUO-14 delivery note badge", () => {
  test("QUO-14 UST-01 warning and escalation badges carry the § 14 Abs. 2 UStG hint; none without a level", () => {
    const { container, rerender } = renderWithIntl(<InvoicingDeadlineBadge level="warning" />);
    expect(screen.getByText("Rechnung fällig")).toHaveAttribute("title", expect.stringContaining("§ 14 Abs. 2 UStG"));
    rerender(<InvoicingDeadlineBadge level="escalation" />);
    expect(screen.getByText("Rechnungsfrist überschritten")).toHaveAttribute("data-invoicing-deadline", "escalation");
    rerender(<InvoicingDeadlineBadge level={null} />);
    expect(container.querySelector("[data-invoicing-deadline]")).toBeNull();
  });
});
