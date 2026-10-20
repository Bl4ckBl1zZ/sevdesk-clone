import { screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { ElsterGuideSteps, type GuideLike } from "./elster-guide-steps";

vi.mock("convex/react", () => ({ useMutation: () => vi.fn() }));

const guide: GuideLike = {
  formName: "Anlage EÜR",
  formYear: 2025,
  formYearWarning: "Achtung: Formular 2025 wählen, nicht 2026.",
  prerequisites: ["Zertifikat bereithalten"],
  navigation: ["Formulare & Leistungen", "Alle Formulare"],
  steps: [
    {
      title: "Betriebseinnahmen",
      fields: [{ kz: "112", zeile: 12, label: "Umsatzsteuerfreie Einnahmen", copy: "100,00" }],
    },
  ],
  checklist: ["Prüfen"],
  blocked: false,
  blockers: [],
  sheetHash: "h",
};

describe("ElsterGuideSteps", () => {
  test("E-UVA-22 TAX-022 the form-year warning is an alert inside a list item (axe list: <ol> holds only <li>)", () => {
    renderWithIntl(<ElsterGuideSteps guide={guide} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Formular 2025 wählen");
    const item = alert.closest("li");
    expect(item).not.toBeNull();
    expect(item?.getAttribute("role")).toBeNull();
    expect(within(item as HTMLElement).getByRole("alert")).toBe(alert);
  });
});
