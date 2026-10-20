import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { DatevCard, presetRange } from "./datev-card";

const backend = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown }[],
  can: new Set<string>(),
  status: null as unknown,
  list: [] as unknown[],
  report: null as unknown,
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => async (args: unknown) => {
    const name = getFunctionName(ref as never);
    backend.calls.push({ name, args });
    return name === "datev:download" ? { url: null, name: "x" } : { jobId: "j1" };
  },
  useAction: (ref: unknown) => async (args: unknown) => {
    backend.calls.push({ name: getFunctionName(ref as never), args });
    return backend.report;
  },
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, _args: unknown, enabled = true) => {
    if (!enabled) return undefined;
    return getFunctionName(ref as never) === "datev:status" ? backend.status : backend.list;
  },
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/catalog/shared", async (orig) => ({
  ...(await orig<typeof import("@/components/catalog/shared")>()),
  useCan: (p: string) => backend.can.has(p),
}));

const row = {
  id: "d1",
  from: "2026-10-01",
  to: "2026-10-31",
  scope: ["revenue"],
  mode: "new",
  festschreibung: false,
  isRepeat: false,
  doNotReimport: false,
  rowCount: 3,
  sumUmsatzCents: 35_700,
  sha256: "ab".repeat(32),
  name: "DATEV_20261001_20261031_Testexport.zip",
  actor: "user:u1",
  at: Date.UTC(2026, 10, 2),
};
const report = {
  issues: [
    {
      level: "warning",
      code: "DATEV_FORCED_ZERO",
      message: "Nicht festgeschriebene Monate (10/2026) werden ohne Festschreibung exportiert.",
    },
  ],
  blocking: false,
  nothingToExport: false,
  needsConfirmation: null,
  festschreibung: 0,
  isRepeat: false,
  doNotReimport: false,
  files: [{ name: "EXTF_Buchungsstapel_20261001_20261031.csv", rows: 3 }],
  rowCount: 3,
  sumUmsatzCents: 35_700,
  entryCount: 2,
  accepted: false,
};

beforeEach(() => {
  backend.calls = [];
  backend.can = new Set(["exports.datev", "exports.datev.read", "exports.datev.acceptance"]);
  backend.status = {
    configured: true,
    formatVersion: 13,
    personalAccounts: true,
    fiscalYearStartMonth: 1,
    acceptance: null,
  };
  backend.list = [row];
  backend.report = report;
});

describe("DatevCard (F09 §6, EXP-007, EXP-009, EXP-016)", () => {
  test("EXP-008 range presets: previous month, quarter and year", () => {
    expect(presetRange("month", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(presetRange("quarter", "2026-05-02")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(presetRange("quarter", "2026-02-02")).toEqual({ from: "2025-10-01", to: "2025-12-31" });
    expect(presetRange("year", "2026-10-19")).toEqual({ from: "2025-01-01", to: "2025-12-31" });
  });

  test("EXP-007 „Prüfen“ opens the report; „Export erstellen“ starts the job with the chosen scope", async () => {
    renderWithIntl(<DatevCard />);
    expect(screen.getByRole("heading", { name: "DATEV-Export" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("DATEV-Import noch nicht von einem Steuerberater bestätigt.");
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "Belegdateien" }));
    await user.click(screen.getByRole("button", { name: "Prüfen" }));
    expect(backend.calls[0]?.name).toBe("datev:validate");
    expect(
      await screen.findByText("Nicht festgeschriebene Monate (10/2026) werden ohne Festschreibung exportiert."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Export erstellen" }));
    const startCall = backend.calls.find((c) => c.name === "datev:start");
    const scope = (startCall?.args as { scope?: string[] } | undefined)?.scope ?? [];
    expect(scope).toContain("revenue");
    expect(scope).not.toContain("documents");
    expect(startCall?.args).toMatchObject({ mode: "new" });
  });

  test("EXP-011 „Zeitraum beim Export festschreiben“ checks with the lock and starts the ⚠ lock export", async () => {
    renderWithIntl(<DatevCard />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "Zeitraum beim Export festschreiben" }));
    await user.click(screen.getByRole("button", { name: "Prüfen" }));
    expect(backend.calls[0]).toMatchObject({ name: "datev:validate", args: { lockPeriod: true } });
    await user.click(await screen.findByRole("button", { name: "Export erstellen" }));
    const call = backend.calls.find((c) => c.name === "datev:startWithLock");
    expect(call?.args).not.toHaveProperty("lockPeriod");
    expect(backend.calls.some((c) => c.name === "datev:start")).toBe(false);
  });

  test("EXP-010 a full re-export of an unlocked range needs the confirmation before „Export erstellen“", async () => {
    backend.report = {
      ...report,
      needsConfirmation: "Der Steuerberater muss den vorherigen Stapel X.csv vor dem Import löschen. Fortfahren?",
    };
    renderWithIntl(<DatevCard />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Prüfen" }));
    const create = await screen.findByRole("button", { name: "Export erstellen" });
    expect(create).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /vor dem Import löschen/ }));
    expect(create).toBeEnabled();
  });

  test("TST-EXP-14 E-EXP-18 without acceptance the download needs the „Testexport“ confirmation", async () => {
    renderWithIntl(<DatevCard />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: `${row.name} herunterladen` }));
    const ok = screen.getByRole("button", { name: "Herunterladen" });
    expect(ok).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /mir ist bekannt/ }));
    await user.click(ok);
    expect(backend.calls.find((c) => c.name === "datev:download")?.args).toEqual({ id: "d1", testConfirmed: true });
  });

  test("EXP-016 recorded acceptance: no banner, direct download; the owner form is gone", async () => {
    backend.status = {
      configured: true,
      formatVersion: 13,
      personalAccounts: true,
      fiscalYearStartMonth: 1,
      acceptance: {
        testedOn: "2026-11-01",
        formatVersion: 13,
        buKeysConfirmed: true,
        advisorName: "StB Muster",
        recordedAt: 1,
      },
    };
    renderWithIntl(<DatevCard />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Testimport am 01.11.2026 bestätigt (StB Muster, Formatversion 13).")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abnahme speichern" })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: `${row.name} herunterladen` }));
    expect(backend.calls.find((c) => c.name === "datev:download")?.args).toEqual({ id: "d1" });
  });

  test("EXP-016 the owner records the advisor acceptance", async () => {
    renderWithIntl(<DatevCard />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Steuerberater/in"), "StB Muster");
    await user.click(screen.getByRole("checkbox", { name: "BU-Schlüssel bestätigt" }));
    await user.click(screen.getByRole("button", { name: "Abnahme speichern" }));
    expect(backend.calls.find((c) => c.name === "datev:recordAcceptance")?.args).toMatchObject({
      formatVersion: 13,
      buKeysConfirmed: true,
      advisorName: "StB Muster",
    });
  });

  test("hidden without DATEV keys or without the read permission", () => {
    backend.status = {
      configured: false,
      formatVersion: 13,
      personalAccounts: true,
      fiscalYearStartMonth: 1,
      acceptance: null,
    };
    const { container } = renderWithIntl(<DatevCard />);
    expect(container).toBeEmptyDOMElement();
  });
});
