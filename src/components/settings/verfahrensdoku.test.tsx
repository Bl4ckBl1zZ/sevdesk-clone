import { screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { DocChapterCard } from "./verfahrensdoku";

vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({ useAuthedQuery: () => undefined }));

const doc = {
  title: "Zugriffskonzept",
  stand: "19.10.2026",
  sections: [
    {
      heading: "Mitglieder und Rollen",
      paragraphs: ["Wer hat Zugriff?"],
      table: { head: ["E-Mail", "Rolle"], rows: [["inhaber@firma.de", "Inhaber"]] },
    },
  ],
};

describe("DocChapterCard", () => {
  test("AUD-024 a section is a region named by its heading even when the heading contains spaces", () => {
    renderWithIntl(<DocChapterCard doc={doc} fileName="zk.md" idPrefix="zk" />);
    const section = screen.getByRole("region", { name: "Mitglieder und Rollen" });
    expect(within(section).getByRole("heading", { name: "Mitglieder und Rollen" })).toBeTruthy();
  });

  test("AUD-024 the table scrolls in a keyboard-focusable, labelled container (axe scrollable-region-focusable)", () => {
    renderWithIntl(<DocChapterCard doc={doc} fileName="zk.md" idPrefix="zk" />);
    const scroller = screen.getByRole("group", { name: "Mitglieder und Rollen" });
    expect(scroller.getAttribute("tabindex")).toBe("0");
    expect(within(scroller).getByRole("table")).toBeTruthy();
  });
});
