import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { ImportDialog } from "./import-dialog";

const backend = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown }[],
  preview: null as unknown,
}));
vi.mock("@/hooks/use-authed-query", () => ({ useAuthedQuery: () => undefined }));
vi.mock("convex/react", () => {
  const fn = (ref: unknown) => async (args: unknown) => {
    const name = getFunctionName(ref as never);
    backend.calls.push({ name, args });
    if (name === "banking:generateUploadUrl") return "https://upload";
    if (name === "banking:previewImport") return backend.preview;
    if (name === "banking:commitImport") return { counts: { new: 2 }, message: "PDF fehlt noch." };
    return null;
  };
  return { useMutation: fn, useAction: fn };
});
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const accounts = [
  { id: "acc1", name: "Revolut EUR", currency: "EUR" },
  { id: "acc2", name: "Revolut USD", currency: "USD" },
] as never;

const preview = (over: Record<string, unknown> = {}) => ({
  format: "camt053",
  fileName: "camt.xml",
  currency: "EUR",
  periodFrom: "2026-09-01",
  periodTo: "2026-09-30",
  openingBalanceCents: 100_000,
  closingBalanceCents: 150_000,
  balanceSource: "file",
  counts: { new: 2, duplicates: 1, merged: 1, conflicts: 1, possibleDuplicates: 1, rejected: 0, skipped: 3 },
  issues: [{ line: 7, message: "Betrag fehlt" }],
  skipped: [],
  arithmetic: { status: "ok" },
  continuity: { status: "mismatch", message: "Anfangssaldo 1.000,00 € ≠ letzter Endsaldo 990,00 €" },
  runningBalanceBreaks: [{ line: 3, diffCents: 100, message: "Saldo springt in Zeile 3" }],
  lockedPeriods: [{ month: "2026-09", message: "September 2026 ist festgeschrieben." }],
  rows: [
    {
      line: 1,
      bookingDate: "2026-09-03",
      amountCents: 50_000,
      currency: "EUR",
      counterpartyName: "Muster GmbH",
      purpose: "RE-1",
      outcome: "new",
    },
    {
      line: 2,
      bookingDate: "2026-09-04",
      amountCents: -1_000,
      currency: "EUR",
      purpose: "Gebühr",
      outcome: "conflict",
    },
  ],
  ...over,
});

beforeEach(() => {
  backend.calls = [];
  backend.preview = preview();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ storageId: "s1" }) }));
  toast.success.mockClear();
  toast.warning.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("ImportDialog (F07 BNK-030…035)", () => {
  test("BNK-034 preview shows outcomes, checks and the counts; commit imports with the signed PDF", async () => {
    const onClose = vi.fn();
    renderWithIntl(<ImportDialog accounts={accounts} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Kontoauszug importieren" });
    const previewBtn = within(dialog).getByRole("button", { name: "Vorschau" });
    expect(previewBtn).toBeDisabled();
    const user = userEvent.setup();
    await user.selectOptions(within(dialog).getByLabelText("Konto"), "acc1");
    await user.upload(within(dialog).getByLabelText("Kontoauszugsdatei"), new File(["<xml/>"], "camt.xml"));
    await user.upload(
      within(dialog).getByLabelText("Signierter PDF-Kontoauszug (optional)"),
      new File(["%PDF"], "auszug.pdf", { type: "application/pdf" }),
    );
    await user.click(previewBtn);
    expect(backend.calls.find((c) => c.name === "banking:previewImport")?.args).toEqual({
      accountId: "acc1",
      storageId: "s1",
      fileName: "camt.xml",
    });
    expect(await screen.findByText("CAMT.053")).toBeInTheDocument();
    expect(screen.getByText("01.09.2026 – 30.09.2026")).toBeInTheDocument();
    expect(screen.getByText(/1\.500,00\s€/)).toBeInTheDocument();
    const counts = screen.getByTestId("import-counts");
    expect(counts).toHaveTextContent("2 neu");
    expect(counts).toHaveTextContent("2 bereits vorhanden");
    expect(counts).toHaveTextContent("1 Abweichungen");
    expect(counts).toHaveTextContent("1 mögliche Dubletten");
    expect(counts).toHaveTextContent("3 nicht gebucht (übersprungen)");
    expect(screen.getByText(/Anfangssaldo \+ Umsätze = Endsaldo/)).toBeInTheDocument();
    expect(screen.getByText(/Anfangssaldo 1\.000,00 € ≠ letzter Endsaldo/)).toBeInTheDocument();
    expect(screen.getByText(/Saldo springt in Zeile 3/)).toBeInTheDocument();
    expect(screen.getByText(/September 2026 ist festgeschrieben/)).toBeInTheDocument();
    expect(screen.getByText("Zeile 7: Betrag fehlt")).toBeInTheDocument();
    const rows = screen.getByRole("list", { name: "Zeilen der Datei" });
    expect(within(rows).getByText("Muster GmbH")).toBeInTheDocument();
    expect(within(rows).getByText("Abweichung")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "2 Umsätze importieren" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(backend.calls.find((c) => c.name === "banking:commitImport")?.args).toEqual({
      accountId: "acc1",
      storageId: "s1",
      fileName: "camt.xml",
      pdfStorageId: "s1",
      pdfName: "auszug.pdf",
    });
    expect(toast.success).toHaveBeenCalledWith("2 Umsätze importiert.");
    expect(toast.warning).toHaveBeenCalledWith("PDF fehlt noch.");
  });

  test("BNK-034 an already imported file warns and imports again only with force", async () => {
    backend.preview = preview({
      alreadyImported: { at: 1, message: "Diese Datei wurde am 02.10.2026 bereits importiert." },
      arithmetic: { status: "unverifiable" },
      continuity: { status: "first" },
      runningBalanceBreaks: [],
      lockedPeriods: [],
      issues: [],
      counts: { new: 0, duplicates: 5, merged: 0, conflicts: 0, possibleDuplicates: 0, rejected: 0, skipped: 0 },
    });
    renderWithIntl(<ImportDialog accounts={accounts} onClose={() => {}} />);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("Kontoauszugsdatei"), new File(["x"], "revolut.csv"));
    await user.click(screen.getByRole("button", { name: "Vorschau" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Diese Datei wurde am 02.10.2026 bereits importiert. Ein erneuter Import fügt keine Umsätze hinzu.",
    );
    expect(screen.getByText(/Saldo nicht prüfbar/)).toBeInTheDocument();
    expect(screen.getByText(/Erster Kontoauszug dieses Kontos/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Trotzdem importieren" }));
    expect(backend.calls.find((c) => c.name === "banking:commitImport")?.args).toMatchObject({ force: true });
  });

  test("BNK-030 „Zurück“ returns from the preview to the file form", async () => {
    renderWithIntl(<ImportDialog accounts={accounts} onClose={() => {}} />);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("Kontoauszugsdatei"), new File(["x"], "camt.xml"));
    await user.click(screen.getByRole("button", { name: "Vorschau" }));
    await user.click(await screen.findByRole("button", { name: "Zurück" }));
    expect(screen.getByLabelText("Kontoauszugsdatei")).toBeInTheDocument();
  });
});
