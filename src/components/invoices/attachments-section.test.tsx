import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { AttachmentsSection } from "./attachments-section";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown }[],
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => async (args: unknown) => {
    const name = getFunctionName(ref as never);
    backend.calls.push({ name, args });
    return name.endsWith("generateAttachmentUploadUrl") ? "https://upload.test" : null;
  },
  useConvex: () => ({ query: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const attachment = {
  name: "agb.pdf",
  mime: "application/pdf",
  bytes: 20_480,
  sha256: "a".repeat(64),
  embedInXml: false,
  includeInExport: true,
};

beforeEach(() => {
  backend.data = { "members:me": { role: "owner" } };
  backend.calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ storageId: "st1" }) } as unknown as Response),
  );
});

describe("AttachmentsSection (DOC-18, INV-30)", () => {
  test("DOC-18 a draft lists attachments with export/BG-24 switches and uploads a new file", async () => {
    renderWithIntl(
      <AttachmentsSection
        id={"d1" as never}
        draft
        files={{ attachments: [attachment], evidence: [], proofWarning: null }}
      />,
    );
    const list = screen.getByTestId("document-attachments");
    expect(within(list).getByText("agb.pdf")).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox", { name: "In E-Rechnung einbetten" }));
    expect(backend.calls).toContainEqual({
      name: "invoices:updateAttachment",
      args: { id: "d1", sha256: attachment.sha256, embedInXml: true },
    });
    const file = new File(["%PDF-1.7"], "leistungsnachweis.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByLabelText("Anhang hinzufügen (höchstens 10)"), file);
    expect(backend.calls).toContainEqual({
      name: "invoices:addAttachment",
      args: { id: "d1", storageId: "st1", name: "leistungsnachweis.pdf" },
    });
    expect(screen.queryByText("Nachweise")).toBeNull();
  });

  test("DOC-18 rejects an unsupported file type before uploading", async () => {
    renderWithIntl(
      <AttachmentsSection id={"d1" as never} draft files={{ attachments: [], evidence: [], proofWarning: null }} />,
    );
    const file = new File(["MZ"], "tool.exe", { type: "application/octet-stream" });
    await userEvent.upload(screen.getByLabelText("Anhang hinzufügen (höchstens 10)"), file, { applyAccept: false });
    expect(screen.getByRole("alert").textContent).toContain("Erlaubt sind PDF");
    expect(backend.calls.some((c) => c.name === "invoices:addAttachment")).toBe(false);
  });

  test("INV-30 a finalised invoice shows the proof warning, frozen attachments and adds a proof", async () => {
    renderWithIntl(
      <AttachmentsSection
        id={"d1" as never}
        draft={false}
        files={{
          attachments: [attachment],
          evidence: [],
          proofWarning: {
            code: "proof_missing_igl",
            message: "Gelangensnachweis fehlt (Gelangensbestätigung oder CMR).",
          },
        }}
      />,
    );
    expect(screen.getAllByRole("alert")[0]?.textContent).toContain("Gelangensnachweis fehlt");
    expect(screen.queryByRole("button", { name: "agb.pdf entfernen" })).toBeNull();
    expect((screen.getByRole("checkbox", { name: "Im Export-ZIP" }) as HTMLInputElement).disabled).toBe(true);
    await userEvent.selectOptions(screen.getByLabelText("Art des Nachweises"), "cmr");
    await userEvent.upload(screen.getByLabelText("Datei"), new File(["%PDF"], "cmr.pdf", { type: "application/pdf" }));
    await userEvent.click(screen.getByRole("button", { name: "Nachweis hinzufügen" }));
    expect(backend.calls).toContainEqual({
      name: "invoices:addEvidence",
      args: { id: "d1", storageId: "st1", name: "cmr.pdf", kind: "cmr" },
    });
  });
});
