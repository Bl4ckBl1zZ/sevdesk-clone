import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { STATUS_STYLES, StatusBadge } from "./status-badge";

describe("status badge (04-ui-ux §6)", () => {
  test("SMOKE every status shows German text, never colour alone", () => {
    renderWithIntl(<StatusBadge status="open" />);
    expect(screen.getByText("Offen")).toBeInTheDocument();
  });

  test("SMOKE overdue uses the destructive token and carries an icon", () => {
    const { container } = renderWithIntl(<StatusBadge status="overdue" />);
    expect(screen.getByText("Überfällig")).toBeInTheDocument();
    expect(container.querySelector("[data-status=overdue] svg")).not.toBeNull();
    expect(STATUS_STYLES.overdue.tone).toBe("destructive");
  });

  test("SMOKE colour tokens follow the status table", () => {
    expect(STATUS_STYLES.draft.tone).toBe("muted");
    expect(STATUS_STYLES.open.tone).toBe("info");
    expect(STATUS_STYLES.sent.tone).toBe("info");
    expect(STATUS_STYLES.partiallyPaid.tone).toBe("warning-soft");
    expect(STATUS_STYLES.paid.tone).toBe("success");
    expect(STATUS_STYLES.accepted.tone).toBe("success");
    expect(STATUS_STYLES.invoiced.tone).toBe("success");
    expect(STATUS_STYLES.rejected.tone).toBe("muted-strike");
    expect(STATUS_STYLES.expired.tone).toBe("muted-strike");
    expect(STATUS_STYLES.cancelled.tone).toBe("muted");
  });

  test("SMOKE storniert shows the Storno tag and locked records a lock suffix with a label", () => {
    renderWithIntl(<StatusBadge status="cancelled" locked />);
    expect(screen.getByText("Storniert")).toBeInTheDocument();
    expect(screen.getByText("Storno")).toBeInTheDocument();
    expect(screen.getByLabelText("Festgeschrieben")).toBeInTheDocument();
  });
});
