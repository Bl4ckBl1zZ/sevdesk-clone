import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { CertificateCard, ConsentCard, VatCheckCard } from "./contact-tax";
import { contactBundle } from "./test-fixtures";

const backend = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown }[],
  checkResult: { reused: false, message: "gültig", warning: null as string | null },
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => async (args: unknown) => {
    const name = getFunctionName(ref as never);
    backend.calls.push({ name, args });
    if (name === "contacts:generateUploadUrl") return "https://upload.example/x";
    if (name === "contacts:addCertificate") return { warnings: ["Bescheinigung läuft in 30 Tagen ab."] };
    return null;
  },
  useAction: (ref: unknown) => async (args: unknown) => {
    backend.calls.push({ name: getFunctionName(ref as never), args });
    return backend.checkResult;
  },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  backend.calls = [];
  backend.checkResult = { reused: false, message: "gültig", warning: null };
  for (const f of Object.values(toast)) f.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VAT check, PDF consent and § 13b certificate cards (F02 §6.3)", () => {
  test("CON-061 the check history lists provider, VAT ID, result, qualified codes and the evidence link", () => {
    renderWithIntl(<VatCheckCard data={contactBundle()} canWrite />);
    expect(screen.getByText("✓ qualifiziert bestätigt am 12.10.2026")).toBeInTheDocument();
    expect(screen.getByText("BZSt eVatR")).toBeInTheDocument();
    expect(screen.getByText("Die USt-IdNr ist gültig.")).toBeInTheDocument();
    expect(screen.getByText(/Name \/ Straße \/ PLZ \/ Ort: A \/ A \/ B \/ A/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Nachweis öffnen" })).toHaveAttribute("href", "/kontakte/c1/nachweis/chk1");
  });

  test("CON-051 „USt-IdNr prüfen“ runs vatIdChecks:check; „Erneut prüfen“ forces a new check", async () => {
    renderWithIntl(<VatCheckCard data={contactBundle()} canWrite />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "USt-IdNr prüfen" }));
    expect(backend.calls[0]).toEqual({ name: "vatIdChecks:check", args: { contactId: "c1", force: false } });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Prüfung abgeschlossen: gültig"));
    backend.checkResult = { reused: true, message: "gültig", warning: "Name weicht ab" };
    await user.click(screen.getByRole("button", { name: "Erneut prüfen" }));
    expect(backend.calls[1]?.args).toEqual({ contactId: "c1", force: true });
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("Ergebnis der Prüfung von heute übernommen."));
    expect(toast.warning).toHaveBeenCalledWith("Name weicht ab");
  });

  test("CON-050 without a VAT ID there is no check button and the history is empty", () => {
    const data = contactBundle({ checks: [] });
    (data.contact as { vatId?: string }).vatId = undefined;
    renderWithIntl(<VatCheckCard data={data} canWrite />);
    expect(screen.getByText("Keine USt-IdNr hinterlegt.")).toBeInTheDocument();
    expect(screen.getByText("Noch keine Prüfung.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("CON-081 consent history shows source, active and revoked dates; read-only without permission", () => {
    renderWithIntl(<ConsentCard data={contactBundle()} canWrite={false} />);
    expect(screen.getByText("per E-Mail")).toBeInTheDocument();
    expect(screen.getByText("aktiv seit 15.01.2026")).toBeInTheDocument();
    expect(screen.getByText("— per Mail vom Einkauf")).toBeInTheDocument();
    expect(screen.getByText("im Vertrag")).toBeInTheDocument();
    expect(screen.getByText("widerrufen am 31.12.2025")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("CON-081 recording a consent calls contacts:addPdfConsent with date, source and note", async () => {
    renderWithIntl(<ConsentCard data={contactBundle()} canWrite />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Zustimmung erfassen" }));
    const dialog = await screen.findByRole("dialog", { name: "Zustimmung erfassen" });
    fireEvent.change(within(dialog).getByLabelText(/^Zugestimmt am/), { target: { value: "2026-10-01" } });
    await user.selectOptions(within(dialog).getByLabelText("Quelle"), "contract");
    await user.type(within(dialog).getByLabelText("Notiz"), "Rahmenvertrag § 7");
    await user.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(backend.calls.find((c) => c.name === "contacts:addPdfConsent")?.args).toEqual({
        contactId: "c1",
        values: { givenAt: "2026-10-01", source: "contract", note: "Rahmenvertrag § 7" },
      }),
    );
  });

  test("CON-081 revoking the active consent records the revocation date", async () => {
    renderWithIntl(<ConsentCard data={contactBundle()} canWrite />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Widerruf erfassen" }));
    const dialog = await screen.findByRole("dialog", { name: "Widerruf erfassen" });
    fireEvent.change(within(dialog).getByLabelText("Widerrufen am"), { target: { value: "2026-10-20" } });
    await user.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(backend.calls.find((c) => c.name === "contacts:revokePdfConsent")?.args).toEqual({
        contactId: "c1",
        revokedAt: "2026-10-20",
      }),
    );
  });

  test("CON-072 the current certificate, its file and the replaced history are shown; expired is flagged", () => {
    const { unmount } = renderWithIntl(<CertificateCard data={contactBundle()} canWrite={false} />);
    expect(screen.getByText(/Gültig bis 31\.12\.2026/)).toBeInTheDocument();
    expect(screen.getByText("(ust1tg.pdf)")).toBeInTheDocument();
    expect(screen.getByText("31.12.2025 · ersetzt")).toBeInTheDocument();
    expect(screen.queryByText("abgelaufen")).toBeNull();
    unmount();
    renderWithIntl(<CertificateCard data={contactBundle({ today: "2027-01-05" })} canWrite={false} />);
    expect(screen.getByText("abgelaufen")).toBeInTheDocument();
  });

  test("CON-070 uploading a certificate stores the file, then calls contacts:addCertificate", async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ storageId: "st1" }) }));
    vi.stubGlobal("fetch", fetchMock);
    renderWithIntl(<CertificateCard data={contactBundle({ certificate: null })} canWrite />);
    expect(screen.getByText("Keine Bescheinigung hinterlegt.")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Bescheinigung hinterlegen" }));
    const dialog = await screen.findByRole("dialog", { name: "Bescheinigung hinterlegen" });
    fireEvent.change(within(dialog).getByLabelText("Gültig bis"), { target: { value: "2027-06-30" } });
    const file = new File(["%PDF"], "ust1tg-2027.pdf", { type: "application/pdf" });
    await user.upload(within(dialog).getByLabelText(/^Datei/), file);
    await user.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(backend.calls.find((c) => c.name === "contacts:addCertificate")?.args).toEqual({
        contactId: "c1",
        validUntil: "2027-06-30",
        storageId: "st1",
        fileName: "ust1tg-2027.pdf",
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith("https://upload.example/x", expect.objectContaining({ method: "POST" }));
    expect(toast.warning).toHaveBeenCalledWith("Bescheinigung läuft in 30 Tagen ab.");
  });

  test("CON-070 a file of the wrong type is rejected before uploading", async () => {
    renderWithIntl(<CertificateCard data={contactBundle()} canWrite />);
    const user = userEvent.setup({ applyAccept: false });
    await user.click(screen.getByRole("button", { name: "Bescheinigung hinterlegen" }));
    const dialog = await screen.findByRole("dialog", { name: "Bescheinigung hinterlegen" });
    await user.upload(within(dialog).getByLabelText(/^Datei/), new File(["x"], "a.txt", { type: "text/plain" }));
    await user.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(within(dialog).getByLabelText(/^Datei/)).toHaveAttribute("aria-invalid", "true");
    expect(backend.calls).toHaveLength(0);
  });
});
