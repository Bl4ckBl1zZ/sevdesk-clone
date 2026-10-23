import { describe, expect, test } from "vitest";
import { buildSystemInfo, redactText } from "./system-info";

describe("SET-136 Systeminfo kopieren", () => {
  test("SET-136 redacts e-mail addresses, IBANs, URLs/hosts and tokens from free text", () => {
    expect(redactText("Mail an inhaber@muster.de fehlgeschlagen")).toBe("Mail an [e-mail] fehlgeschlagen");
    expect(redactText("Konto DE89 3704 0044 0532 0130 00 gesperrt")).toBe("Konto [iban] gesperrt");
    expect(redactText("https://app.8u9yhy8fewf.org/api/health antwortet 502")).toBe("[url] antwortet 502");
    expect(redactText("api.example.org liefert UI-Pfade")).toBe("[host] liefert UI-Pfade");
    expect(redactText("Token demo_token_abcdefghijklmnopqrstuvwxyz123 abgelehnt")).toBe("Token [token] abgelehnt");
  });

  test("SET-136 the JSON holds versions and health only — no secrets, no personal data", () => {
    const json = buildSystemInfo({
      generatedAt: "2026-10-12T10:00:00.000Z",
      versions: { app: { version: "1.4.0", gitSha: "abc1234", buildDate: null }, next: "16.4.0", node: "v24.1.0" },
      einvoice: { kosit: "1.5.0", xrechnungConfig: "2025-07-10", mustang: "2.26.0" },
      checks: [
        { id: "convex", status: "ok", latencyMs: 12 },
        {
          id: "email",
          status: "error",
          detail: "Token cf_abcdefghijklmnopqrstuvwxyz0123 für inhaber@muster.de ungültig",
        },
      ],
    });
    const parsed = JSON.parse(json);
    expect(parsed.versions).toEqual({
      app: { version: "1.4.0", gitSha: "abc1234", buildDate: null },
      next: "16.4.0",
      node: "v24.1.0",
    });
    expect(parsed.einvoiceTools.mustang).toBe("2.26.0");
    expect(parsed.health).toEqual([
      { id: "convex", status: "ok", latencyMs: 12 },
      { id: "email", status: "error", detail: "Token [token] für [e-mail] ungültig" },
    ]);
    expect(json).not.toContain("muster.de");
    expect(json).not.toContain("cf_abc");
  });
});
