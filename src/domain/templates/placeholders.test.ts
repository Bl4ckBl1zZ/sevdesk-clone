import { describe, expect, test } from "vitest";
import {
  PLACEHOLDERS,
  placeholderGroups,
  placeholderSnippet,
  renderTemplate,
  samplePlaceholderValues,
  searchPlaceholders,
  validatePlaceholders,
} from "./placeholders";

const invoiceHead = { kind: "document_head", docTypes: ["invoice"] } as const;

describe("SET-082 placeholders and sections", () => {
  test("SET-082 T-SET-043 unknown placeholder, unclosed section and reminder.* in an invoice template are rejected", () => {
    expect(validatePlaceholders("Hallo {{contact.foo}}", invoiceHead)).toMatchObject({
      ok: false,
      error: { code: "PLACEHOLDER_UNKNOWN", message: "Unbekannter Platzhalter {{contact.foo}}." },
    });
    expect(validatePlaceholders("{{#document.hasSkonto}}Skonto", invoiceHead)).toMatchObject({
      ok: false,
      error: {
        code: "PLACEHOLDER_SECTION_UNCLOSED",
        message: "Der Abschnitt {{#document.hasSkonto}} wird nicht geschlossen.",
      },
    });
    expect(validatePlaceholders("Stufe {{reminder.level}}", invoiceHead)).toMatchObject({
      ok: false,
      error: {
        code: "PLACEHOLDER_NOT_ALLOWED",
        message: "Der Platzhalter {{reminder.level}} ist in Vorlagen für Rechnung nicht verfügbar.",
      },
    });
    expect(validatePlaceholders("Stufe {{reminder.level}}", { kind: "document_head", docTypes: ["reminder"] }).ok).toBe(
      true,
    );
  });

  test("SET-082 whitespace inside braces, sections, inverted sections and the \\{{ escape are accepted", () => {
    const body =
      "<p>{{ contact.letterSalutation }}</p>{{#document.hasSkonto}}Skonto bis {{document.skontoDate}}{{/document.hasSkonto}}" +
      "{{^document.isKleinunternehmer}}zzgl. USt{{/document.isKleinunternehmer}} \\{{kein.platzhalter}}";
    const r = validatePlaceholders(body, invoiceHead);
    expect(r).toEqual({
      ok: true,
      value: ["contact.letterSalutation", "document.hasSkonto", "document.skontoDate", "document.isKleinunternehmer"],
    });
  });

  test("SET-082 names are case-sensitive; booleans only in sections; mail-only values only in message texts", () => {
    expect(validatePlaceholders("{{Contact.name}}", invoiceHead)).toMatchObject({
      error: { code: "PLACEHOLDER_UNKNOWN" },
    });
    expect(validatePlaceholders("{{document.hasSkonto}}", invoiceHead)).toMatchObject({
      error: { code: "PLACEHOLDER_SECTION_ONLY" },
    });
    expect(validatePlaceholders("{{document.openAmount}}", invoiceHead)).toMatchObject({
      error: {
        code: "PLACEHOLDER_NOT_ALLOWED",
        message: "Der Platzhalter {{document.openAmount}} ist nur in E-Mail-Texten verfügbar.",
      },
    });
    expect(validatePlaceholders("{{document.openAmount}}", { kind: "message_text", docTypes: ["invoice"] }).ok).toBe(
      true,
    );
    expect(validatePlaceholders("{{ }}", invoiceHead)).toMatchObject({ error: { code: "PLACEHOLDER_UNKNOWN" } });
  });

  test("SET-082 sections nest at most 3 levels; a stray closing tag is reported", () => {
    const three =
      "{{#document.hasSkonto}}{{#contact.isConsumer}}{{#document.subject}}x{{/document.subject}}{{/contact.isConsumer}}{{/document.hasSkonto}}";
    expect(validatePlaceholders(three, invoiceHead).ok).toBe(true);
    const four = `{{#document.hasPortal}}${three}{{/document.hasPortal}}`;
    expect(validatePlaceholders(four, invoiceHead)).toMatchObject({ error: { code: "PLACEHOLDER_SECTION_DEPTH" } });
    expect(validatePlaceholders("x{{/document.hasSkonto}}", invoiceHead)).toMatchObject({
      error: { code: "PLACEHOLDER_SECTION_UNOPENED" },
    });
    expect(validatePlaceholders("{{#document.hasSkonto}}{{/contact.isConsumer}}", invoiceHead)).toMatchObject({
      error: { code: "PLACEHOLDER_SECTION_UNCLOSED" },
    });
  });

  test("SET-082 custom fields: contact.custom.<key> must exist when the definitions are known", () => {
    const scope = { ...invoiceHead, customFields: { contact: ["projekt"] } };
    expect(validatePlaceholders("{{contact.custom.projekt}}", scope).ok).toBe(true);
    expect(validatePlaceholders("{{contact.custom.kostenstelle}}", scope)).toMatchObject({
      error: { code: "PLACEHOLDER_UNKNOWN" },
    });
  });

  test("SET-082 SET-085 rendering escapes values, renders missing values empty and follows sections", () => {
    const body =
      "{{contact.name}}: {{#document.hasSkonto}}Skonto{{/document.hasSkonto}}{{^document.hasSkonto}}ohne{{/document.hasSkonto}} {{contact.custom.projekt}}\\{{x";
    expect(renderTemplate(body, { "contact.name": "Müller <GmbH> & Co", "document.hasSkonto": true })).toBe(
      "Müller &lt;GmbH&gt; &amp; Co: Skonto {{x",
    );
    expect(renderTemplate(body, { "contact.name": "A", "document.hasSkonto": false })).toBe("A: ohne {{x");
  });
});

describe("SET-087 placeholder picker", () => {
  test("SET-087 groups by namespace with German labels and sample values; reminder.* only for reminders", () => {
    const groups = placeholderGroups(invoiceHead);
    expect(groups.map((g) => g.label)).toEqual([
      "Unternehmen",
      "Kontakt",
      "Dokument",
      "Wiederkehrende Rechnung",
      "Datum",
    ]);
    const contact = groups.find((g) => g.namespace === "contact");
    expect(contact?.items.find((p) => p.key === "contact.letterSalutation")).toMatchObject({
      label: "Briefanrede",
      sample: "Sehr geehrte Frau Dr. Müller,",
    });
    expect(groups.flatMap((g) => g.items).some((p) => p.key === "document.openAmount")).toBe(false);
    expect(placeholderGroups({ kind: "message_text", docTypes: ["reminder"] }).map((g) => g.namespace)).toContain(
      "reminder",
    );
  });

  test("SET-087 search matches key, label or sample; flags insert a section snippet", () => {
    const found = searchPlaceholders(placeholderGroups(invoiceHead), "skonto");
    expect(found.map((g) => g.namespace)).toEqual(["document"]);
    expect(found[0]?.items.map((p) => p.key)).toContain("document.skontoAmount");
    expect(searchPlaceholders(placeholderGroups(invoiceHead), "Briefanrede")[0]?.items.map((p) => p.key)).toEqual([
      "contact.letterSalutation",
    ]);
    const flag = PLACEHOLDERS.find((p) => p.key === "document.hasSkonto");
    if (!flag) throw new Error("missing");
    expect(placeholderSnippet(flag)).toBe("{{#document.hasSkonto}}…{{/document.hasSkonto}}");
    expect(samplePlaceholderValues()["document.hasSkonto"]).toBe(true);
    expect(samplePlaceholderValues()["contact.name"]).toBe("Müller GmbH");
  });
});
