import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { BackupsPanel } from "./backups-panel";

const backend = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("convex/react", () => ({ useAction: () => backend.status }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const AT = Date.UTC(2026, 9, 19, 2, 0);

beforeEach(() => {
  backend.status = vi.fn().mockResolvedValue({
    configured: true,
    bucket: "backups",
    status: "error",
    checkedAt: AT,
    sources: [
      {
        prefix: "postgres/",
        label: "Dokploy-Datenbank (Postgres)",
        latest: { key: "postgres/x", at: AT, bytes: 2_097_152 },
        ageHours: 4,
        status: "ok",
        detail: "Letzte Sicherung vor 4 Stunden.",
      },
      {
        prefix: "convex-export/",
        label: "Convex-Export",
        latest: null,
        ageHours: null,
        status: "error",
        detail: "Keine Sicherung unter convex-export/ gefunden.",
      },
    ],
    checkpoint: { latest: { key: "checkpoints/2026/10/19.jws", at: AT, bytes: 900 }, bucketLock: "absent" },
  });
});

describe("backup status page (AUD-026)", () => {
  test("AUD-026 shows the latest backup per source with status, the checkpoint bucket and the bucket lock", async () => {
    renderWithIntl(<BackupsPanel />);
    const list = await screen.findByRole("list", { name: "Sicherungen" });
    const [pg, ex] = within(list).getAllByRole("listitem") as [HTMLElement, HTMLElement];
    expect(pg).toHaveTextContent("2 MB");
    expect(within(pg).getByText("Aktuell")).toBeInTheDocument();
    expect(within(ex).getByText("Fehlt oder zu alt")).toBeInTheDocument();
    expect(screen.getByTestId("backup-checkpoint")).toHaveTextContent("Keine Bucket-Sperre eingerichtet");
  });

  test("AUD-026 without read-only credentials the page explains what is missing", async () => {
    backend.status = vi.fn().mockResolvedValue({
      configured: false,
      bucket: null,
      sources: [],
      checkpoint: null,
      status: "unknown",
      checkedAt: AT,
    });
    renderWithIntl(<BackupsPanel />);
    expect(await screen.findByRole("status")).toHaveTextContent("R2_BACKUP_READONLY_ACCESS_KEY_ID");
  });
});
