import { screen } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { IntegrityBanner } from "../shell/integrity-banner";
import { IntegrityPanel } from "./integrity-panel";

const backend = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, _args: unknown, enabled = true) =>
    enabled ? backend.data[getFunctionName(ref as never)] : undefined,
}));
vi.mock("convex/react", () => ({ useMutation: () => vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const AT = Date.UTC(2026, 9, 19, 0, 30);

beforeEach(() => {
  backend.data = {
    "members:me": { role: "owner" },
    "integrity:status": {
      head: { seq: 1234, hash: "abcdef0123456789abcdef", at: AT },
      lastRun: {
        id: "r1",
        at: AT,
        ok: true,
        scope: "startup",
        lastVerifiedSeq: 1234,
        findings: [],
        acknowledgedAt: null,
      },
      latestCheckpoint: {
        date: "2026-10-19",
        lastSeq: 1200,
        uploadStatus: "uploaded",
        exportedTo: "r2://checkpoints/checkpoints/2026/10/19.jws",
        kid: "k1",
      },
      finalisationBlocked: false,
    },
    "system:clock": { at: AT, offsetMs: 300, status: "ok", detail: "Abweichung 0,3 s.", reference: "https://x" },
  };
});

describe("integrity status panel (SET-132)", () => {
  test("SET-132 shows the last run, the signed checkpoint with its export target, the chain head and the clock", () => {
    renderWithIntl(<IntegrityPanel />);
    expect(screen.getByTestId("integrity-last-run")).toHaveTextContent("in Ordnung (Startprüfung)");
    expect(screen.getByTestId("integrity-checkpoint")).toHaveTextContent("19.10.2026 · bis seq 1200");
    expect(screen.getByTestId("integrity-checkpoint")).toHaveTextContent(
      "extern gespeichert: r2://checkpoints/checkpoints/2026/10/19.jws",
    );
    expect(screen.getByTestId("integrity-head")).toHaveTextContent("seq 1234 · abcdef012345");
    expect(screen.getByTestId("integrity-clock")).toHaveTextContent("Abweichung 0,3 s.");
  });

  test("SET-132 a failed run lists its findings", () => {
    const status = backend.data["integrity:status"] as Record<string, unknown>;
    backend.data["integrity:status"] = {
      ...status,
      lastRun: {
        id: "r1",
        at: AT,
        ok: false,
        scope: "full",
        lastVerifiedSeq: 40,
        findings: [
          { kind: "chain_hash_mismatch", severity: "error", detail: "Protokolleintrag seq 41 wurde verändert." },
        ],
        acknowledgedAt: null,
      },
    };
    renderWithIntl(<IntegrityPanel />);
    expect(screen.getByTestId("integrity-last-run")).toHaveTextContent("1 Befund (vollständig)");
    expect(screen.getByRole("list", { name: "Befunde der letzten Prüfung" })).toHaveTextContent("seq 41");
  });

  test("AUD-019 GOBD-22 a clock skew over 2 s shows a warning banner, over 60 s an alert", () => {
    backend.data["system:clock"] = {
      at: AT,
      offsetMs: 5000,
      status: "warning",
      detail: "Die Serveruhr weicht um 5,0 s ab.",
    };
    const { unmount } = renderWithIntl(<IntegrityBanner />);
    expect(screen.getByRole("status")).toHaveTextContent("Uhrzeit-Abweichung: Die Serveruhr weicht um 5,0 s ab.");
    unmount();
    backend.data["system:clock"] = {
      at: AT,
      offsetMs: 90000,
      status: "error",
      detail: "Die Serveruhr weicht um 90 s ab.",
    };
    renderWithIntl(<IntegrityBanner />);
    expect(screen.getByRole("alert")).toHaveTextContent("sind gesperrt");
  });
});
