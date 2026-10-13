import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { NoPosNotice } from "../layout/no-pos-notice";
import { AuthMailCard, HealthPanel, SecurityPanel, SystemOverviewPanel, VersionsCard } from "./system-panels";
import { ZugriffskonzeptChapter } from "./verfahrensdoku";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue(null);
    return backend.mutations[name];
  },
  useAction: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue([]);
    return backend.mutations[name];
  },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  backend.mutations = {};
  backend.data = {
    "system:overview": {
      serverLocation: { countryCode: "DE" },
      accessConcept: { baseDomain: "buero.example.de", tailnetName: null },
      restoreDrill: { due: true, nextDueOn: null, message: "Noch keine Wiederherstellungsprobe erfasst." },
      lastRestoreDrillOn: null,
      drills: [],
    },
    "system:authMailStatus": {
      from: "noreply@mail.example.de",
      accountId: "acc123",
      tokenConfigured: true,
      lastTestAt: null,
      lastTestOk: null,
      lastTestDetail: null,
      purposes: ["sign_in_codes", "invitations", "owner_notifications"],
    },
    "system:zugriffskonzeptData": {
      today: "2026-10-12",
      accessConcept: { baseDomain: "buero.example.de", network: "tailnet", confirmedAt: Date.UTC(2026, 8, 1) },
      members: [{ email: "inhaber@firma.de", role: "owner", expiresAt: null, totp: true }],
      apiKeys: [],
    },
  };
});

describe("System page (F01 SET-130/131/135)", () => {
  test("SET-130 versions incl. KoSIT, XRechnung bundle and rule tables", () => {
    renderWithIntl(
      <VersionsCard
        versions={{
          app: { version: "1.0.0", gitSha: "abc1234", buildDate: "2026-10-12" },
          next: "16.4.0",
          node: "v24.9.0",
          convexImage: "72ce13c",
          betterAuth: "1.6.33",
          ruleTables: "2026-10-12",
        }}
        einvoice={{ tools: "2026-08-31-1", kosit: "1.5.2", xrechnungConfig: "2026-07-31", mustang: "2.16.4" }}
      />,
    );
    expect(screen.getByText("XRechnung-Konfiguration").nextSibling).toHaveTextContent("2026-07-31");
    expect(screen.getByText("Git-Commit").nextSibling).toHaveTextContent("abc1234");
  });

  test("SET-131 health checks show status, latency and detail; only the owner may run the service checks", () => {
    const checks = [
      { id: "convex", label: "Datenbank (Convex)", status: "ok" as const, latencyMs: 12, detail: "Backend 1.46" },
    ];
    const { unmount } = renderWithIntl(<HealthPanel checks={checks} isOwner={false} />);
    expect(screen.getByText(/Backend 1.46 · 12 ms/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "E-Mail-Versand und R2 prüfen" })).toBeNull();
    unmount();
    renderWithIntl(<HealthPanel checks={checks} isOwner />);
    expect(screen.getByRole("button", { name: "E-Mail-Versand und R2 prüfen" })).toBeInTheDocument();
  });

  test("SET-135 SEC-05 the restore-drill reminder is shown and the owner records a drill", async () => {
    renderWithIntl(<SystemOverviewPanel isOwner />);
    expect(screen.getByRole("alert")).toHaveTextContent("Noch keine Wiederherstellungsprobe erfasst.");
    expect(screen.getByText("Nur im Tailnet unter buero.example.de")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Wiederherstellungsprobe erfassen" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/Sicherung/), "postgres/2026-10-11.dump.zst");
    await userEvent.type(within(dialog).getByLabelText("Zielumgebung"), "Testinstanz");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(backend.mutations["system:recordRestoreDrill"]).toHaveBeenCalledWith(
      expect.objectContaining({
        backupObject: "postgres/2026-10-11.dump.zst",
        targetEnvironment: "Testinstanz",
        integrityOk: true,
      }),
    );
  });
});

describe("Security page (F12 AUD-020)", () => {
  test("AUD-020 every check shows its result; problems show the remedy; live probes run on request", async () => {
    renderWithIntl(
      <SecurityPanel
        checks={[
          { id: "session", label: "Anmeldung mit gültiger Sitzung", status: "ok" },
          {
            id: "passkey",
            label: "Inhaber hat einen Passkey",
            status: "error",
            detail: "Kein Passkey registriert.",
            remedy: "Passkey hinzufügen.",
          },
        ]}
      />,
    );
    expect(screen.getByText("Abhilfe: Passkey hinzufügen.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Live-Prüfung starten" }));
    expect(backend.mutations["settings:runAccessChecks"]).toHaveBeenCalled();
    expect(backend.mutations["settings:testCheckpointStorage"]).toHaveBeenCalled();
  });
});

describe("Integrations: auth e-mail card (F01 SET-106)", () => {
  test("SET-106 SEC-06 sender, account and „konfiguriert“ — never the token", () => {
    renderWithIntl(<AuthMailCard />);
    expect(screen.getByText("noreply@mail.example.de")).toBeInTheDocument();
    expect(screen.getByText("konfiguriert")).toBeInTheDocument();
    expect(screen.getByText("Anmeldecodes, Einladungen, Hinweise an den Inhaber")).toBeInTheDocument();
  });
});

describe("Verfahrensdokumentation (F01 SET-047)", () => {
  test("SET-047 the Zugriffskonzept chapter lists login, tailnet hosts and members", () => {
    renderWithIntl(<ZugriffskonzeptChapter />);
    expect(screen.getByRole("heading", { name: "Zugriffskonzept" })).toBeInTheDocument();
    expect(screen.getAllByText(/app\.buero\.example\.de/).length).toBeGreaterThan(0);
    expect(screen.getByRole("cell", { name: "inhaber@firma.de" })).toBeInTheDocument();
  });
});

describe("AO-04 no POS", () => {
  test("AO-04 CSH-029 the Kasse page says it is no till; cash income only on invoices", () => {
    renderWithIntl(<NoPosNotice />);
    expect(screen.getByRole("note")).toHaveTextContent(
      "Kein Kassensystem (keine Registrierkasse, keine TSE) – Bareinnahmen nur zu Rechnungen.",
    );
  });
});
