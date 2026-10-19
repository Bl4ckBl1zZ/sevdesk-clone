import { describe, expect, test } from "vitest";
import {
  buildVerfahrensdoku,
  outdatedMessage,
  releaseIssue,
  VD_CHAPTERS,
  type VdSources,
  verfahrensdokuMarkdown,
  watchDiff,
  watchSnapshot,
} from "./verfahrensdoku";

const sources = (over: Partial<VdSources> = {}): VdSources => ({
  today: "2026-10-19",
  company: {
    name: "Muster Studio",
    legalForm: "einzelunternehmen",
    address: "Markt 1, 52062 Aachen",
    taxationMethod: "soll",
    chart: "SKR04",
    kleinunternehmer: true,
    profitMethod: "euer",
  },
  software: { appVersion: "1.4.2", hosting: "eigener Server (Proxmox PVE), Dokploy", edge: "Tailnet" },
  access: {
    members: [{ role: "owner", expiresAt: null, totp: false }],
    apiKeys: [{ name: "Website", scopes: ["invoices:read"], kind: "api" }],
    tailnet: null,
  },
  numberRanges: [{ name: "Rechnungen", format: "RE-{YYYY}-{####}", active: true }],
  layoutsCount: 1,
  bankAccounts: [{ name: "Revolut EUR", kind: "bank", ledgerAccount: "1800" }],
  hasCashTransfers: false,
  integrations: [],
  rules: { posting: "posting-2026.1", roleMapping: "roles-2026.2", retention: "retention-2026.1" },
  integrity: { checkpointKid: "kid-abc", lastCheckpoint: "19.10.2026", backupConfigured: true },
  restoreDrills: [],
  services: [{ name: "Tailscale", role: "Auftragsverarbeiter", region: "USA", avvConfirmedAt: null }],
  imports: [
    { source: "sevdesk_export", at: Date.UTC(2026, 9, 1), files: [{ name: "export.zip", sha256: "a".repeat(64) }] },
  ],
  changes: [],
  ...over,
});

const complete = (): Record<string, string> =>
  Object.fromEntries(VD_CHAPTERS.flatMap((c) => c.fields.filter((x) => x.required).map((x) => [x.key, "erledigt"])));

describe("Verfahrensdokumentation generator (AUD-024)", () => {
  test("AUD-024 16 chapters plus annex; status automatisch / vollständig / Angaben fehlen; auto text from settings", () => {
    const doc = buildVerfahrensdoku(sources(), {});
    expect(doc.chapters).toHaveLength(17);
    expect(doc.chapters.find((c) => c.n === 12)?.status).toBe("automatisch");
    expect(doc.chapters.find((c) => c.n === 1)?.status).toBe("Angaben fehlen");
    expect(doc.chapters.find((c) => c.n === 1)?.auto.join(" ")).toContain("Kleinunternehmer nach § 19 UStG");
    expect(doc.chapters.find((c) => c.n === 5)?.auto.join(" ")).toContain("RE-{YYYY}-{####}");
    expect(doc.chapters.find((c) => c.n === 11)?.auto.join(" ")).toContain("sevdesk_export");
    expect(doc.chapters.find((c) => c.n === 14)?.auto.join(" ")).toContain("kid-abc");
    expect(doc.chapters.find((c) => c.n === 15)?.auto.join(" ")).toContain("Tailscale");
    const done = buildVerfahrensdoku(sources(), { ...complete(), taxAdvisor: "" });
    expect(done.chapters.find((c) => c.n === 1)?.status).toBe("vollständig");
    expect(done.complete).toBe(true);
  });

  test("AUD-024 E-AUD-40 release is blocked while a mandatory owner input is missing; the Markdown carries the version", () => {
    expect(releaseIssue(buildVerfahrensdoku(sources(), {}))).toBe(
      "Für die Freigabe fehlen Angaben in Kapitel 1: Beschreibung der Tätigkeit.",
    );
    const doc = buildVerfahrensdoku(sources(), complete());
    expect(releaseIssue(doc)).toBeNull();
    const md = verfahrensdokuMarkdown(doc, { company: "Muster Studio", version: 2, validFrom: "2026-10-19" });
    expect(md).toContain("# Verfahrensdokumentation – Muster Studio");
    expect(md).toContain("Version 2, gültig ab 19.10.2026");
    expect(md).toContain("## 3. Zugriffskonzept");
    expect(md).toContain("**Scan-Verfahren (wer, wann, Qualitätskontrolle, Vernichtung):** erledigt");
  });

  test("AUD-025 E-AUD-41 the watch list reports changed access concept, method and software minor version", () => {
    const before = watchSnapshot(sources());
    const after = watchSnapshot(
      sources({
        access: {
          members: [
            { role: "owner", expiresAt: null, totp: false },
            { role: "bookkeeper", expiresAt: null, totp: false },
          ],
          apiKeys: [],
          tailnet: null,
        },
        company: { ...sources().company, taxationMethod: "ist" },
        software: { ...sources().software, appVersion: "1.5.0" },
      }),
    );
    const diff = watchDiff(before, after);
    expect(diff.map((d) => d.key)).toEqual(["taxationMethod", "access", "apiKeys", "software"]);
    expect(outdatedMessage(diff)).toBe(
      "Verfahrensdokumentation muss aktualisiert werden: Versteuerungsart, Zugriffskonzept und Rollen, API- und MCP-Schlüssel, Software-Version.",
    );
    // a patch release does not outdate it
    expect(
      watchDiff(before, watchSnapshot(sources({ software: { ...sources().software, appVersion: "1.4.9" } }))),
    ).toEqual([]);
  });
});
