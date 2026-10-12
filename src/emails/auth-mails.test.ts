import { describe, expect, test } from "vitest";
import { inviteMail, otpMail, testMail } from "./auth-mails";

describe("auth mails (02 §9)", () => {
  test("SET-009a the sign-in code mail is German and contains the code in subject, text and HTML", () => {
    const m = otpMail({ code: "123456", appName: "Rechnungen" });
    expect(m.subject).toBe("Ihr Anmeldecode für Rechnungen: 123456");
    expect(m.text).toContain("Ihr Anmeldecode lautet: 123456");
    expect(m.text).toContain("10 Minuten gültig");
    expect(m.html).toContain(">123456</strong>");
    expect(m.html).toContain('lang="de"');
  });

  test("SEC-06 values are HTML-escaped", () => {
    const m = inviteMail({
      appName: "Rechnungen",
      companyName: "Müller <GmbH>",
      role: "auditor",
      signInUrl: "https://app.buero.example.de/anmelden?x=1&y=2",
      expiresOn: "19.10.2026",
    });
    expect(m.html).toContain("Müller &lt;GmbH&gt;");
    expect(m.html).toContain("x=1&amp;y=2");
    expect(m.text).toContain("Rolle: Prüfer (nur Lesen)");
  });

  test("SET-107 test mail subject names the company", () => {
    expect(testMail({ appName: "Rechnungen", companyName: "Muster GmbH" }).subject).toBe(
      "Testnachricht von Muster GmbH",
    );
  });
});
