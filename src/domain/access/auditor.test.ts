import { describe, expect, test } from "vitest";
import { forbiddenRoleMessage, memberRefusalMessage } from "./auditor";

describe("auditor and member refusal texts (F12 §5.2/§5.3)", () => {
  test("E-AUD-32 an auditor gets „Nur Lesezugriff.“ for any write; other roles the role text (E-AUD-29)", () => {
    expect(forbiddenRoleMessage("auditor")).toBe("Nur Lesezugriff.");
    expect(forbiddenRoleMessage("viewer")).toBe("Ihre Rolle (Lesezugriff) erlaubt diese Aktion nicht.");
    expect(forbiddenRoleMessage("bookkeeper")).toBe("Ihre Rolle (Buchhaltung) erlaubt diese Aktion nicht.");
  });

  test("E-AUD-30 an expired auditor is told the expiry date and whom to contact", () => {
    const expiresAt = Date.UTC(2026, 9, 31, 23, 30); // 00:30 on 01.11.2026 in Berlin (CET)
    expect(memberRefusalMessage({ role: "auditor", expiresAt }, "expired", "Muster GmbH")).toBe(
      "Ihr Prüferzugang ist am 01.11.2026 abgelaufen. Bitte wenden Sie sich an Muster GmbH.",
    );
  });

  test("E-AUD-31 a deactivated auditor gets the same text with „beendet“ and the deactivation date", () => {
    const disabledAt = Date.UTC(2026, 9, 12, 9);
    expect(
      memberRefusalMessage({ role: "auditor", expiresAt: disabledAt + 9e8, disabledAt }, "disabled", "Muster GmbH"),
    ).toBe("Ihr Prüferzugang ist am 12.10.2026 beendet. Bitte wenden Sie sich an Muster GmbH.");
  });

  test("SEC-01 other members keep the short texts; a missing company name falls back to „den Inhaber“", () => {
    expect(memberRefusalMessage({ role: "viewer", expiresAt: 1 }, "expired", "X")).toBe("Ihr Zugang ist abgelaufen.");
    expect(memberRefusalMessage({ role: "bookkeeper", disabledAt: 1 }, "disabled", "X")).toBe(
      "Ihr Zugang wurde beendet.",
    );
    expect(memberRefusalMessage({ role: "auditor", expiresAt: Date.UTC(2026, 0, 5) }, "expired", undefined)).toBe(
      "Ihr Prüferzugang ist am 05.01.2026 abgelaufen. Bitte wenden Sie sich an den Inhaber.",
    );
  });
});
