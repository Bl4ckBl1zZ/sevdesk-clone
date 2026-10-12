import { describe, expect, test } from "vitest";
import { textTemplateSchema } from "../schemas/lookups";
import { defaultsToClear, prepareTextTemplate } from "./validate";

const base = {
  kind: "document_head" as const,
  docTypes: ["invoice"],
  language: "de" as const,
  name: "Kopftext Rechnung",
  body: "<p>{{contact.letterSalutation}}</p>",
  isDefault: false,
};

describe("SET-080 SET-081 SET-082 saving a text template", () => {
  test("SET-081 SET-082 the body is sanitised and the placeholders are checked (subject too)", () => {
    const r = prepareTextTemplate({ ...base, body: '<p onclick="x">{{contact.name}}</p><script>x</script>' });
    expect(r).toMatchObject({ ok: true, value: { body: "<p>{{contact.name}}</p>", placeholders: ["contact.name"] } });
    expect(prepareTextTemplate({ ...base, body: "{{contact.foo}}" })).toMatchObject({
      ok: false,
      error: { code: "PLACEHOLDER_UNKNOWN", params: { field: "body" } },
    });
    expect(
      prepareTextTemplate({ ...base, kind: "message_text", subject: "{{reminder.level}}", body: "x" }),
    ).toMatchObject({ ok: false, error: { code: "PLACEHOLDER_NOT_ALLOWED", params: { field: "subject" } } });
  });

  test("SET-080 only message texts have a subject; custom field keys are checked when known", () => {
    expect(prepareTextTemplate({ ...base, subject: "Betreff" })).toMatchObject({
      ok: true,
      value: { subject: undefined },
    });
    expect(prepareTextTemplate({ ...base, body: "{{document.custom.po}}" }, { document: ["projekt"] })).toMatchObject({
      ok: false,
      error: { code: "PLACEHOLDER_UNKNOWN" },
    });
  });

  test("SET-081 the 20,000 character limit applies to the sanitised body", () => {
    expect(prepareTextTemplate({ ...base, body: `<p>${"a".repeat(20_000)}</p>` })).toMatchObject({
      ok: false,
      error: { code: "TEMPLATE_TOO_LONG" },
    });
  });

  test("SET-080 the zod schema shows placeholder errors on the body field", () => {
    const r = textTemplateSchema.safeParse({ ...base, body: "{{#document.hasSkonto}}" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]).toMatchObject({
      path: ["body"],
      message: "Der Abschnitt {{#document.hasSkonto}} wird nicht geschlossen.",
    });
    expect(textTemplateSchema.safeParse({ ...base, docTypes: [] }).success).toBe(false);
    expect(textTemplateSchema.safeParse({ ...base, docTypes: ["self_billing"] }).success).toBe(false);
  });

  test("SET-080 at most one default per (kind, document type, language): overlapping defaults are cleared", () => {
    const existing = [
      { id: "a", kind: "document_head", language: "de", docTypes: ["invoice", "proforma"], isDefault: true },
      { id: "b", kind: "document_head", language: "en", docTypes: ["invoice"], isDefault: true },
      { id: "c", kind: "document_foot", language: "de", docTypes: ["invoice"], isDefault: true },
      { id: "d", kind: "document_head", language: "de", docTypes: ["quote"], isDefault: true },
      { id: "e", kind: "document_head", language: "de", docTypes: ["invoice"], isDefault: false },
    ];
    expect(
      defaultsToClear(existing, { id: "new", kind: "document_head", language: "de", docTypes: ["invoice"] }),
    ).toEqual(["a"]);
    expect(
      defaultsToClear(existing, { id: "a", kind: "document_head", language: "de", docTypes: ["invoice"] }),
    ).toEqual([]);
  });
});
