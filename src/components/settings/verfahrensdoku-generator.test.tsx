import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { VerfahrensdokuGenerator } from "./verfahrensdoku-generator";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  save: vi.fn(),
  release: vi.fn(),
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("convex/react", () => ({
  useMutation: () => backend.save,
  useAction: () => backend.release,
  useConvex: () => ({ query: vi.fn().mockResolvedValue({ url: null, name: "x.md", sha256: "ab" }) }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const chapter = (n: number | "Anhang", title: string, status: string, fields: unknown[] = []) => ({
  n,
  title,
  status,
  auto: [`Automatischer Text ${n}`],
  fields,
  missing: status === "Angaben fehlen" ? ["Beschreibung der Tätigkeit"] : [],
});

beforeEach(() => {
  backend.save = vi.fn().mockResolvedValue(null);
  backend.release = vi.fn().mockResolvedValue({ version: 1, sha256: "ab" });
  backend.data = {
    "members:me": { role: "owner" },
    "verfahrensdoku:view": {
      doc: {
        stand: "19.10.2026",
        complete: false,
        chapters: [
          chapter(1, "Allgemeine Beschreibung", "Angaben fehlen", [
            { key: "business", label: "Beschreibung der Tätigkeit", required: true, value: "" },
          ]),
          chapter(12, "Archivierung und Aufbewahrung", "automatisch"),
        ],
      },
      releaseIssue: "Für die Freigabe fehlen Angaben in Kapitel 1: Beschreibung der Tätigkeit.",
      versions: [
        {
          version: 1,
          validFrom: "2026-10-01",
          releasedAt: Date.UTC(2026, 9, 1),
          releasedBy: "user:o",
          sha256: "f".repeat(64),
          supersededAt: null,
        },
      ],
      outdated: {
        message: "Verfahrensdokumentation muss aktualisiert werden: Nummernkreise.",
        diff: [{ key: "numberRanges", label: "Nummernkreise", before: "RE-{####}", after: "R-{#####}" }],
      },
    },
  };
});

describe("Verfahrensdokumentation page (AUD-024, AUD-025)", () => {
  test("AUD-024 chapters show their status and auto text; release is blocked with the E-AUD-40 reason; inputs are saved", async () => {
    renderWithIntl(<VerfahrensdokuGenerator publicEdge={false} />);
    const c1 = screen.getByRole("region", { name: "1. Allgemeine Beschreibung" });
    expect(within(c1).getByText("Angaben fehlen")).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "12. Archivierung und Aufbewahrung" })).getByText("automatisch"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Freigeben" })).toBeDisabled();
    expect(
      screen.getByText("Für die Freigabe fehlen Angaben in Kapitel 1: Beschreibung der Tätigkeit."),
    ).toBeInTheDocument();
    await userEvent.type(within(c1).getByLabelText("Beschreibung der Tätigkeit *"), "Grafikdesign");
    await userEvent.click(screen.getByRole("button", { name: "Angaben speichern" }));
    expect(backend.save).toHaveBeenCalledWith({ values: { business: "Grafikdesign" } });
  });

  test("AUD-025 E-AUD-41 a changed watch item marks the current version „Aktualisierung erforderlich“ with the diff", () => {
    renderWithIntl(<VerfahrensdokuGenerator publicEdge={false} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Nummernkreise: RE-{####} → R-{#####}");
    expect(screen.getByText("Aktualisierung erforderlich")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Version 1 herunterladen" })).toBeInTheDocument();
  });

  test("AUD-024 a bookkeeper sees the chapters read-only without save or release", () => {
    backend.data["members:me"] = { role: "bookkeeper" };
    renderWithIntl(<VerfahrensdokuGenerator publicEdge={false} />);
    expect(screen.queryByRole("button", { name: "Freigeben" })).toBeNull();
    expect(screen.getByLabelText("Beschreibung der Tätigkeit *")).toHaveAttribute("readonly");
  });
});
