import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { IntegrityBanner } from "../shell/integrity-banner";
import { IntegrityPanel } from "./integrity-panel";

const backend = vi.hoisted(() => ({ data: {} as Record<string, unknown>, verify: vi.fn() }));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, _args: unknown, enabled = true) =>
    enabled ? backend.data[getFunctionName(ref as never)] : undefined,
}));
vi.mock("convex/react", () => ({ useMutation: () => vi.fn(), useAction: () => backend.verify }));
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
      detail: "Die Serverzeit weicht um 5,0 s ab. Bitte Zeitsynchronisation (NTP) prüfen.",
    };
    const { unmount } = renderWithIntl(<IntegrityBanner />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Uhrzeit-Abweichung: Die Serverzeit weicht um 5,0 s ab. Bitte Zeitsynchronisation (NTP) prüfen.",
    );
    unmount();
    backend.data["system:clock"] = {
      at: AT,
      offsetMs: 90000,
      status: "error",
      detail: "Fertigstellen gesperrt: Die Serverzeit weicht um 90 s ab.",
    };
    renderWithIntl(<IntegrityBanner />);
    expect(screen.getByRole("alert")).toHaveTextContent("sind gesperrt");
  });
});

describe("checkpoint verification upload (AUD-017)", () => {
  test("AUD-017 „Prüfpunkt verifizieren“ sends the uploaded file and shows the signature and chain checks", async () => {
    backend.verify.mockResolvedValue({
      ok: true,
      message: "Prüfpunkt bestätigt.",
      kid: "k1",
      date: "2026-10-19",
      lastSeq: 1200,
      checks: [
        { id: "signature", status: "ok", detail: "Signatur gültig (Schlüssel-Fingerabdruck k1)." },
        {
          id: "chain",
          status: "ok",
          detail: "Die Protokollkette enthält seq 1200 mit dem Hash des Prüfpunkts vom 19.10.2026.",
        },
      ],
    });
    renderWithIntl(<IntegrityPanel />);
    expect(screen.getByRole("heading", { name: "Prüfpunkt verifizieren" })).toBeInTheDocument();
    const file = new File(["eyJh.eyJw.c2ln"], "19.jws", { type: "application/jose" });
    await userEvent.upload(screen.getByLabelText("Prüfpunkt-Datei (.jws)"), file);
    await waitFor(() => expect(backend.verify).toHaveBeenCalledWith({ jws: "eyJh.eyJw.c2ln" }));
    const result = await screen.findByRole("status");
    expect(result).toHaveTextContent("Prüfpunkt bestätigt.");
    expect(result).toHaveTextContent("Prüfpunkt vom 19.10.2026 · bis seq 1200");
    expect(screen.getByRole("list", { name: "Einzelprüfungen" })).toHaveTextContent(
      "In Ordnung: Signatur gültig (Schlüssel-Fingerabdruck k1).",
    );
  });

  test("AUD-017 a checkpoint that is not confirmed is shown as an alert with the failing check", async () => {
    backend.verify.mockResolvedValue({
      ok: false,
      message:
        "Prüfpunkt nicht bestätigt: Protokolleintrag seq 7 stimmt nicht mit dem Prüfpunkt vom 19.10.2026 überein.",
      kid: "k1",
      date: "2026-10-19",
      lastSeq: 7,
      checks: [
        { id: "signature", status: "ok", detail: "Signatur gültig (Schlüssel-Fingerabdruck k1)." },
        {
          id: "chain",
          status: "error",
          detail: "Protokolleintrag seq 7 stimmt nicht mit dem Prüfpunkt vom 19.10.2026 überein.",
        },
      ],
    });
    renderWithIntl(<IntegrityPanel />);
    await userEvent.upload(screen.getByLabelText("Prüfpunkt-Datei (.jws)"), new File(["x.y.z"], "a.jws"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Prüfpunkt nicht bestätigt");
    expect(alert).toHaveTextContent("Fehler: Protokolleintrag seq 7");
  });
});
