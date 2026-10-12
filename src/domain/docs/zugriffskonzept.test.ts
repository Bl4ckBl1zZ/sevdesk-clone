import { describe, expect, test } from "vitest";
import { zugriffskonzept, zugriffskonzeptMarkdown } from "./zugriffskonzept";

const INPUT = {
  today: "2026-10-12",
  accessConcept: {
    baseDomain: "buero.example.de",
    network: "tailnet" as const,
    tailnetName: "firma.ts.net",
    confirmedAt: Date.UTC(2026, 8, 1),
  },
  members: [
    { email: "inhaber@firma.de", role: "owner" as const, expiresAt: null, totp: true },
    { email: "pruefer@finanzamt.de", role: "auditor" as const, expiresAt: Date.UTC(2026, 10, 1), totp: false },
  ],
  apiKeys: [{ name: "Buchhaltungs-Export", scopes: ["audit:read"], kind: "api" as const }],
};

describe("SET-047 Zugriffskonzept in the Verfahrensdokumentation", () => {
  test("SET-047 T-SET-025 SEC-07 GOBD-10 login, tailnet hosts under BASE_DOMAIN, roles with validity, API keys, auditor procedure", () => {
    const doc = zugriffskonzept(INPUT);
    expect(doc.title).toBe("Zugriffskonzept");
    expect(doc.sections.map((s) => s.heading)).toEqual([
      "Anmeldung",
      "Netzwerkzugang",
      "Mitglieder und Rollen",
      "API- und MCP-Schlüssel",
      "Prüferzugang (Datenzugriff der Finanzverwaltung)",
      "Kontrollen",
    ]);
    const md = zugriffskonzeptMarkdown(doc);
    expect(md).toContain("Passkey");
    expect(md).toContain("E-Mail-Code");
    expect(md).toContain("app.buero.example.de");
    expect(md).toContain("api.buero.example.de");
    expect(md).toContain("ausschließlich im Tailnet „firma.ts.net“");
    expect(md).toContain("| inhaber@firma.de | Inhaber | unbefristet | ja |");
    expect(md).toContain("| pruefer@finanzamt.de | Prüfer | bis 01.11.2026 | nein |");
    expect(md).toContain("Buchhaltungs-Export (API) — audit:read");
    expect(md).toContain("/einstellungen/system/sicherheit");
    expect(md).toContain("Stand: 12.10.2026");
  });

  test("SET-047 without an access concept the chapter says so instead of inventing hosts", () => {
    const md = zugriffskonzeptMarkdown(zugriffskonzept({ ...INPUT, accessConcept: undefined, apiKeys: [] }));
    expect(md).toContain("Das Zugriffskonzept wurde in der Einrichtung noch nicht erfasst.");
    expect(md).toContain("Keine Schlüssel angelegt.");
  });
});
