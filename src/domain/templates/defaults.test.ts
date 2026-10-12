import { describe, expect, test } from "vitest";
import { SALES_DOC_TYPES } from "../documents/layout";
import { DEFAULT_TEXT_TEMPLATES, TEMPLATE_KINDS, TEMPLATE_LANGUAGES } from "./defaults";
import { validatePlaceholders } from "./placeholders";
import { sanitizeTemplateHtml } from "./sanitize";

describe("SET-086 seeded default templates", () => {
  test("SET-086 German and English head, foot and message text for every numbered document type, one default each", () => {
    for (const docType of SALES_DOC_TYPES) {
      for (const kind of TEMPLATE_KINDS) {
        for (const language of TEMPLATE_LANGUAGES) {
          const matches = DEFAULT_TEXT_TEMPLATES.filter(
            (t) => t.kind === kind && t.language === language && t.docTypes.includes(docType),
          );
          expect(matches, `${docType}/${kind}/${language}`).toHaveLength(1);
          expect(matches[0]?.isDefault).toBe(true);
        }
      }
    }
    expect(DEFAULT_TEXT_TEMPLATES).toHaveLength(SALES_DOC_TYPES.length * 3 * 2);
  });

  test("SET-086 SET-081 SET-082 every seed is already sanitised and uses only allowed placeholders", () => {
    for (const t of DEFAULT_TEXT_TEMPLATES) {
      expect(sanitizeTemplateHtml(t.body), t.name).toBe(t.body);
      const scope = { kind: t.kind, docTypes: t.docTypes };
      expect(validatePlaceholders(t.body, scope), t.name).toMatchObject({ ok: true });
      if (t.kind === "message_text")
        expect(validatePlaceholders(t.subject ?? "", scope), t.name).toMatchObject({ ok: true });
      else expect(t.subject).toBeUndefined();
    }
  });

  test("SET-086 the texts fit the document type", () => {
    const find = (docType: string, kind: string, language: string) =>
      DEFAULT_TEXT_TEMPLATES.find(
        (t) => (t.docTypes as readonly string[]).includes(docType) && t.kind === kind && t.language === language,
      );
    expect(find("invoice", "document_foot", "de")?.body).toContain("{{document.paymentTermsText}}");
    expect(find("quote", "document_foot", "de")?.body).toContain("{{document.validUntil}}");
    expect(find("reminder", "document_head", "de")?.body).toContain("{{reminder.invoiceNumber}}");
    expect(find("cancellation", "document_head", "en")?.body).toContain("{{document.correctedNumber}}");
    expect(find("delivery_note", "message_text", "de")).toMatchObject({
      name: "Standard E-Mail-Text Lieferschein (DE)",
      subject: "{{document.typeLabel}} {{document.number}} – {{company.name}}",
    });
    expect(find("delivery_note", "message_text", "de")?.body).toContain("unseren Lieferschein {{document.number}}");
  });
});
