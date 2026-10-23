import { describe, expect, test } from "vitest";
import { makeSnapshot } from "../../../test/factories/snapshot";
import { type MessageTemplate, mailtoHref, messageText, pickMessageTemplate } from "./message-text";

const tpl = (patch: Partial<MessageTemplate> = {}): MessageTemplate => ({
  kind: "message_text",
  docTypes: ["invoice"],
  language: "de",
  name: "Eigene Vorlage",
  subject: "Rechnung {{document.number}}",
  body: "<p>{{contact.letterSalutation}}</p><p>anbei Rechnung {{document.number}} über {{document.grossTotal}}, offen {{document.openAmount}}.</p><p>{{company.name}}</p>",
  isDefault: true,
  ...patch,
});

describe("SND-19 „E-Mail-Text kopieren“", () => {
  test("SND-19 T-SND-014 subject and body are resolved from the snapshot as plain text", () => {
    const s = makeSnapshot({ number: "RE-2026-0042" });
    const r = messageText(s, { templates: [tpl()], openAmountCents: 50_00, today: "2026-10-20" });
    expect(r.subject).toBe("Rechnung RE-2026-0042");
    expect(r.body).toContain("anbei Rechnung RE-2026-0042 über");
    expect(r.body).toMatch(/offen 50,00\s€/);
    expect(r.body).toContain(s.seller.name);
    expect(r.body).not.toContain("<p>");
    expect(r.body).not.toContain("{{");
    expect(r.templateName).toBe("Eigene Vorlage");
  });

  test("SND-19 the template follows document type and language; the default wins; shipped default as fallback", () => {
    const en = tpl({ language: "en", name: "EN", subject: "Invoice {{document.number}}" });
    const quote = tpl({ docTypes: ["quote"], name: "Angebot" });
    const other = tpl({ isDefault: false, name: "Zweite" });
    const def = tpl({ name: "Standard" });
    expect(pickMessageTemplate([en, quote, other, def], "invoice", "de")?.name).toBe("Standard");
    expect(pickMessageTemplate([en, quote, other], "invoice", "de")?.name).toBe("Zweite");
    expect(pickMessageTemplate([en, quote], "invoice", "en")?.name).toBe("EN");
    expect(pickMessageTemplate([tpl({ kind: "document_head" })], "invoice", "de")).toBeNull();
    const s = makeSnapshot({ number: "RE-2026-0042" });
    const fallback = messageText(s, { templates: [], today: "2026-10-20" });
    expect(fallback.subject).toBe(`Rechnung RE-2026-0042 – ${s.seller.name}`);
    expect(fallback.body).toContain("anbei erhalten Sie unsere Rechnung RE-2026-0042 vom");
  });

  test("SND-19 HTML-like characters in values come out unescaped in the plain text", () => {
    const s = makeSnapshot({ number: "RE-2026-0042" });
    const r = messageText(
      { ...s, texts: { subject: "Kabel <5 m & Stecker" } },
      {
        templates: [tpl({ subject: "{{document.subject}}", body: "<p>{{document.subject}}</p>" })],
        today: "2026-10-20",
      },
    );
    expect(r.subject).toBe("Kabel <5 m & Stecker");
    expect(r.body).toBe("Kabel <5 m & Stecker");
  });

  test("SND-19 mailto link carries recipients, subject and body only (no attachments)", () => {
    const href = mailtoHref(
      ["rechnung@mueller.de", "buchhaltung@mueller.de"],
      "Rechnung RE-1 & Co",
      "Zeile 1\nZeile 2",
    );
    expect(href).toBe(
      "mailto:rechnung%40mueller.de,buchhaltung%40mueller.de?subject=Rechnung%20RE-1%20%26%20Co&body=Zeile%201%0D%0AZeile%202",
    );
    expect(href).not.toContain("attach");
    expect(mailtoHref([], "S", "B")).toBe("mailto:?subject=S&body=B");
  });
});
