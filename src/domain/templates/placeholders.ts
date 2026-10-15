/**
 * Placeholder dictionary and template parser (F01 §5.6, SET-082, SET-087). Pure: the editor picker, the save
 * validation (Convex, REST, MCP) and the preview renderer use the same functions. Resolution at finalisation and the
 * frozen snapshot text follow in P1 (SET-084).
 *
 *   {{namespace.key}}        value (HTML-escaped)            {{#key}}…{{/key}}  if set / true
 *   {{^key}}…{{/key}}        if not set / false              \{{                literal "{{"
 */
import { NUMBERED_TYPE_LABEL_DE } from "../numbering/register";
import { err, type Issue, issue, ok, type Result } from "../result";

export type PlaceholderNamespace = "company" | "contact" | "document" | "reminder" | "recurring" | "date";
export type TemplateKind = "document_head" | "document_foot" | "message_text";

export interface PlaceholderDef {
  key: string;
  label: string;
  namespace: PlaceholderNamespace;
  /** German sample value for the picker and the preview („live sample value“, SET-087). */
  sample: string;
  /** Booleans can only be used in sections. */
  flag?: true;
  /** Only in copyable e-mail texts (`message_text`). */
  mailOnly?: true;
}

export const NAMESPACE_LABEL_DE: Readonly<Record<PlaceholderNamespace, string>> = {
  company: "Unternehmen",
  contact: "Kontakt",
  document: "Dokument",
  reminder: "Mahnung",
  recurring: "Wiederkehrende Rechnung",
  date: "Datum",
};

/** Namespaces restricted to some document types (§5.6). */
const NAMESPACE_DOC_TYPES: Partial<Record<PlaceholderNamespace, readonly string[]>> = {
  reminder: ["reminder"],
  recurring: ["invoice"],
};

const d = (
  namespace: PlaceholderNamespace,
  key: string,
  label: string,
  sample: string,
  extra: { flag?: true; mailOnly?: true } = {},
): PlaceholderDef => ({ key: `${namespace}.${key}`, label, namespace, sample, ...extra });

export const PLACEHOLDERS: readonly PlaceholderDef[] = [
  d("company", "name", "Firma", "Muster Design GmbH"),
  d("company", "tradeName", "Geschäftsbezeichnung", "Muster Design"),
  d("company", "legalForm", "Rechtsform", "GmbH"),
  d("company", "street", "Straße", "Hauptstr. 1"),
  d("company", "postalCode", "PLZ", "10115"),
  d("company", "city", "Ort", "Berlin"),
  d("company", "country", "Land", "Deutschland"),
  d("company", "addressLine", "Adresse einzeilig", "Muster Design GmbH · Hauptstr. 1 · 10115 Berlin"),
  d("company", "contactName", "Ansprechpartner", "Erika Musterfrau"),
  d("company", "phone", "Telefon", "+49 30 123456"),
  d("company", "email", "E-Mail", "info@muster.de"),
  d("company", "website", "Website", "https://muster.de"),
  d("company", "taxNumber", "Steuernummer", "27/815/08155"),
  d("company", "vatId", "USt-IdNr", "DE123456788"),
  d("company", "taxOffice", "Finanzamt", "Finanzamt Berlin-Mitte"),
  d("company", "registerCourt", "Registergericht", "Amtsgericht Charlottenburg"),
  d("company", "registerNumber", "Registernummer", "HRB 123456 B"),
  d("company", "representatives", "Vertretungsberechtigte", "Max Mustermann, Erika Musterfrau"),
  d("company", "iban", "IBAN", "DE89 3704 0044 0532 0130 00"),
  d("company", "bic", "BIC", "COBADEFFXXX"),
  d("company", "bankName", "Bank", "Commerzbank"),
  d("company", "accountHolder", "Kontoinhaber", "Muster Design GmbH"),
  d("company", "creditorId", "Gläubiger-ID", "DE98ZZZ09999999999"),

  d("contact", "number", "Kundennummer", "10042"),
  d("contact", "name", "Anzeigename", "Müller GmbH"),
  d("contact", "organizationName", "Firma", "Müller GmbH"),
  d("contact", "salutation", "Anrede", "Frau"),
  d("contact", "academicTitle", "Titel", "Dr."),
  d("contact", "firstName", "Vorname", "Anna"),
  d("contact", "lastName", "Nachname", "Müller"),
  d("contact", "fullName", "Voller Name", "Dr. Anna Müller"),
  d("contact", "position", "Position", "Einkauf"),
  d("contact", "letterSalutation", "Briefanrede", "Sehr geehrte Frau Dr. Müller,"),
  d("contact", "email", "Rechnungs-E-Mail", "rechnung@mueller.de"),
  d("contact", "phone", "Telefon (primär)", "+49 221 987654"),
  d("contact", "street", "Straße", "Musterweg 5"),
  d("contact", "postalCode", "PLZ", "50667"),
  d("contact", "city", "Ort", "Köln"),
  d("contact", "country", "Land", "Deutschland"),
  d("contact", "vatId", "USt-IdNr", "DE811907980"),
  d("contact", "taxNumber", "Steuernummer", "217/5774/1234"),
  d("contact", "buyerReference", "Käuferreferenz / Leitweg-ID", "04011000-12345-67"),
  d("contact", "isConsumer", "Privatkunde", "nein", { flag: true }),
  d("contact", "isPublicAuthority", "Öffentlicher Auftraggeber", "nein", { flag: true }),

  d("document", "typeLabel", "Dokumentart", "Rechnung"),
  d("document", "number", "Nummer", "RE-2026-0042"),
  d("document", "date", "Datum", "12.10.2026"),
  d("document", "supplyDate", "Leistungsdatum/-zeitraum", "01.10.2026 – 31.10.2026"),
  d("document", "subject", "Betreff", "Website-Relaunch"),
  d("document", "dueDate", "Fälligkeitsdatum", "26.10.2026"),
  d("document", "dueDays", "Zahlungsziel in Tagen", "14"),
  d("document", "validUntil", "Gültig bis", "11.11.2026"),
  d("document", "netTotal", "Summe netto", "1.000,00 €"),
  d("document", "vatTotal", "Umsatzsteuer", "190,00 €"),
  d("document", "grossTotal", "Gesamtbetrag", "1.190,00 €"),
  d("document", "payableAmount", "Zahlbetrag", "1.190,00 €"),
  d("document", "openAmount", "Offener Betrag", "1.190,00 €", { mailOnly: true }),
  d("document", "currency", "Währung", "EUR"),
  d("document", "skontoPercent", "Skonto in %", "2"),
  d("document", "skontoDays", "Skonto-Frist in Tagen", "7"),
  d("document", "skontoDate", "Skonto bis", "19.10.2026"),
  d("document", "skontoAmount", "Skonto-Betrag", "23,80 €"),
  d(
    "document",
    "paymentTermsText",
    "Zahlungsbedingungen",
    "Zahlbar bis 26.10.2026 ohne Abzug. Bei Zahlung bis 19.10.2026 2 % Skonto (23,80 €).",
  ),
  d("document", "paymentMethod", "Zahlungsart", "Überweisung"),
  d("document", "orderReference", "Bestellnummer", "PO-4711"),
  d("document", "buyerReference", "Käuferreferenz", "04011000-12345-67"),
  d("document", "contractReference", "Vertragsnummer", "V-2026-12"),
  d("document", "originNumber", "Bezugsdokument", "AN-2026-0017"),
  d("document", "originDate", "Datum des Bezugsdokuments", "01.09.2026"),
  d("document", "correctedNumber", "Ursprüngliche Rechnung", "RE-2026-0040"),
  d("document", "correctedDate", "Datum der ursprünglichen Rechnung", "05.10.2026"),
  d("document", "portalLink", "Online-Link", ""),
  d("document", "hasSkonto", "Mit Skonto", "ja", { flag: true }),
  d("document", "isKleinunternehmer", "Kleinunternehmer", "nein", { flag: true }),
  d("document", "hasPortal", "Mit Online-Link", "nein", { flag: true }),

  d("reminder", "level", "Mahnstufe", "1"),
  d("reminder", "title", "Titel", "Zahlungserinnerung"),
  d("reminder", "invoiceNumber", "Rechnungsnummer", "RE-2026-0042"),
  d("reminder", "invoiceDate", "Rechnungsdatum", "12.09.2026"),
  d("reminder", "invoiceDueDate", "Fällig seit", "26.09.2026"),
  d("reminder", "openAmount", "Offener Betrag", "1.190,00 €"),
  d("reminder", "feeAmount", "Mahngebühr", "5,00 €"),
  d("reminder", "interestAmount", "Verzugszinsen", "12,34 €"),
  d("reminder", "totalDue", "Gesamtforderung", "1.207,34 €"),
  d("reminder", "newDueDate", "Neue Frist", "22.10.2026"),
  d("reminder", "flatFee", "Verzugspauschale (§ 288 Abs. 5 BGB)", "40,00 €"),
  d("reminder", "defaultStartDate", "Verzug seit", "27.09.2026"),
  d("reminder", "number", "Nummer der Mahnung", "MA-2026-0007"),
  d("reminder", "date", "Datum der Mahnung", "12.10.2026"),

  d("recurring", "periodFrom", "Zeitraum von", "01.10.2026"),
  d("recurring", "periodTo", "Zeitraum bis", "31.10.2026"),
  d("recurring", "periodText", "Zeitraum als Satz", "Berechnung für den Zeitraum vom 01.10.2026 bis 31.10.2026"),

  d("date", "today", "Heute", "12.10.2026"),
  d("date", "year", "Jahr", "2026"),
  d("date", "month", "Monat (Zahl)", "10"),
  d("date", "monthName", "Monat", "Oktober"),
  d("date", "quarter", "Quartal", "Q4"),
  d("date", "previousMonthName", "Vormonat", "September"),
  d("date", "nextMonthName", "Folgemonat", "November"),
];

const BY_KEY = new Map(PLACEHOLDERS.map((p) => [p.key, p]));
const CUSTOM = /^(contact|document)\.custom\.([a-z][a-z0-9_]{0,39})$/;
export const MAX_SECTION_DEPTH = 3;

export interface TemplateScope {
  kind: TemplateKind;
  docTypes: readonly string[];
  /** Custom field keys per entity; when given, unknown `*.custom.<key>` placeholders are rejected. */
  customFields?: { contact?: readonly string[]; document?: readonly string[] };
}

export type PlaceholderIssue = Issue<
  | "PLACEHOLDER_UNKNOWN"
  | "PLACEHOLDER_SECTION_UNCLOSED"
  | "PLACEHOLDER_SECTION_UNOPENED"
  | "PLACEHOLDER_SECTION_DEPTH"
  | "PLACEHOLDER_NOT_ALLOWED"
  | "PLACEHOLDER_SECTION_ONLY"
>;

type Token =
  | { type: "text"; value: string }
  | { type: "var"; name: string }
  | { type: "open"; name: string; inverted: boolean }
  | { type: "close"; name: string }
  | { type: "invalid"; raw: string };

const TAG = /\\\{\{|\{\{([\s\S]*?)\}\}/g;

function tokenize(body: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const m of body.matchAll(TAG)) {
    const at = m.index ?? 0;
    if (at > last) tokens.push({ type: "text", value: body.slice(last, at) });
    last = at + m[0].length;
    if (m[0] === "\\{{") {
      tokens.push({ type: "text", value: "{{" });
      continue;
    }
    const inner = (m[1] ?? "").trim();
    const sigil = inner[0];
    const name = (sigil === "#" || sigil === "^" || sigil === "/" ? inner.slice(1) : inner).trim();
    if (!/^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/.test(name)) {
      tokens.push({ type: "invalid", raw: m[0] });
      continue;
    }
    if (sigil === "#" || sigil === "^") tokens.push({ type: "open", name, inverted: sigil === "^" });
    else if (sigil === "/") tokens.push({ type: "close", name });
    else tokens.push({ type: "var", name });
  }
  if (last < body.length) tokens.push({ type: "text", value: body.slice(last) });
  return tokens;
}

const docTypeLabel = (docTypes: readonly string[]) => docTypes.map((t) => NUMBERED_TYPE_LABEL_DE[t] ?? t).join(", ");

function checkName(name: string, scope: TemplateScope, asSection: boolean): PlaceholderIssue | null {
  const custom = CUSTOM.exec(name);
  if (custom) {
    const entity = custom[1] as "contact" | "document";
    const known = scope.customFields?.[entity];
    if (known && !known.includes(custom[2] ?? "")) {
      return issue("PLACEHOLDER_UNKNOWN", `Unbekannter Platzhalter {{${name}}}.`, { name });
    }
    return null;
  }
  const def = BY_KEY.get(name);
  if (!def) return issue("PLACEHOLDER_UNKNOWN", `Unbekannter Platzhalter {{${name}}}.`, { name });
  const restricted = NAMESPACE_DOC_TYPES[def.namespace];
  const outside = restricted ? scope.docTypes.filter((t) => !restricted.includes(t)) : [];
  if (outside.length > 0) {
    return issue(
      "PLACEHOLDER_NOT_ALLOWED",
      `Der Platzhalter {{${name}}} ist in Vorlagen für ${docTypeLabel(outside)} nicht verfügbar.`,
      { name },
    );
  }
  if (def.mailOnly && scope.kind !== "message_text") {
    return issue("PLACEHOLDER_NOT_ALLOWED", `Der Platzhalter {{${name}}} ist nur in E-Mail-Texten verfügbar.`, {
      name,
    });
  }
  if (def.flag && !asSection) {
    return issue(
      "PLACEHOLDER_SECTION_ONLY",
      `Der Platzhalter {{${name}}} kann nur als Abschnitt verwendet werden ({{#${name}}}…{{/${name}}}).`,
      { name },
    );
  }
  return null;
}

/** SET-082: validates a template (subject or body); returns the placeholder names used. */
export function validatePlaceholders(body: string, scope: TemplateScope): Result<string[], PlaceholderIssue> {
  const used = new Set<string>();
  const stack: string[] = [];
  for (const t of tokenize(body)) {
    if (t.type === "text") continue;
    if (t.type === "invalid") {
      return err(issue("PLACEHOLDER_UNKNOWN", `Unbekannter Platzhalter ${t.raw}.`, { name: t.raw }));
    }
    if (t.type === "close") {
      const top = stack.pop();
      if (top === undefined) {
        return err(
          issue("PLACEHOLDER_SECTION_UNOPENED", `Der Abschnitt {{/${t.name}}} wurde nicht geöffnet.`, { name: t.name }),
        );
      }
      if (top !== t.name) {
        return err(
          issue("PLACEHOLDER_SECTION_UNCLOSED", `Der Abschnitt {{#${top}}} wird nicht geschlossen.`, { name: top }),
        );
      }
      continue;
    }
    const problem = checkName(t.name, scope, t.type === "open");
    if (problem) return err(problem);
    used.add(t.name);
    if (t.type === "open") {
      stack.push(t.name);
      if (stack.length > MAX_SECTION_DEPTH) {
        return err(
          issue("PLACEHOLDER_SECTION_DEPTH", "Abschnitte können höchstens 3 Ebenen tief verschachtelt werden.", {
            name: t.name,
          }),
        );
      }
    }
  }
  const open = stack.pop();
  if (open !== undefined) {
    return err(
      issue("PLACEHOLDER_SECTION_UNCLOSED", `Der Abschnitt {{#${open}}} wird nicht geschlossen.`, { name: open }),
    );
  }
  return ok([...used]);
}

export type PlaceholderValues = Readonly<Record<string, string | boolean | undefined>>;

const escapeHtml = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const truthy = (v: string | boolean | undefined) => v === true || (typeof v === "string" && v !== "");

/**
 * Renders a (validated) template: values are HTML-escaped, missing values render empty (SET-085), sections follow
 * the value's truthiness. Used by the editor preview now and by finalisation in P1.
 */
export function renderTemplate(body: string, values: PlaceholderValues): string {
  let out = "";
  const visible: boolean[] = [];
  const shown = () => visible.every(Boolean);
  for (const t of tokenize(body)) {
    if (t.type === "open") visible.push(truthy(values[t.name]) !== t.inverted);
    else if (t.type === "close") visible.pop();
    else if (!shown()) continue;
    else if (t.type === "text") out += t.value;
    else if (t.type === "var") {
      const v = values[t.name];
      out += typeof v === "string" ? escapeHtml(v) : "";
    } else out += escapeHtml(t.raw);
  }
  return out;
}

export interface PlaceholderGroup {
  namespace: PlaceholderNamespace;
  label: string;
  items: PlaceholderDef[];
}

/** Placeholders usable in a template of `kind` for `docTypes`, grouped by namespace (picker, SET-087). */
export function placeholderGroups(scope: Pick<TemplateScope, "kind" | "docTypes">): PlaceholderGroup[] {
  const groups: PlaceholderGroup[] = [];
  for (const namespace of Object.keys(NAMESPACE_LABEL_DE) as PlaceholderNamespace[]) {
    const items = PLACEHOLDERS.filter(
      (p) => p.namespace === namespace && checkName(p.key, { ...scope }, p.flag === true) === null,
    );
    if (items.length) groups.push({ namespace, label: NAMESPACE_LABEL_DE[namespace], items });
  }
  return groups;
}

/** Case-insensitive search over key, label and sample value; empty groups are dropped. */
export function searchPlaceholders(groups: readonly PlaceholderGroup[], query: string): PlaceholderGroup[] {
  const q = query.trim().toLocaleLowerCase("de");
  if (!q) return [...groups];
  return groups
    .map((g) => ({
      ...g,
      items: g.items.filter((p) =>
        [p.key, p.label, p.sample, g.label].some((s) => s.toLocaleLowerCase("de").includes(q)),
      ),
    }))
    .filter((g) => g.items.length > 0);
}

/** The text the picker inserts. */
export const placeholderSnippet = (p: PlaceholderDef): string =>
  p.flag ? `{{#${p.key}}}…{{/${p.key}}}` : `{{${p.key}}}`;

/** Sample values for the preview (flags: Skonto on, KU off). */
export function samplePlaceholderValues(): Record<string, string | boolean> {
  return Object.fromEntries(PLACEHOLDERS.map((p) => [p.key, p.flag ? p.sample === "ja" : p.sample]));
}
