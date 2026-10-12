/**
 * Contact core record (F02 §3.1, §5.1; 03 §2 `contacts`). Pure rules: enums, derived display name, number
 * normalisation, search text with diacritic folding, and the field validation shared by the zod schema (UI, REST,
 * MCP) and the Convex model (which adds the context: today, existing numbers, parent).
 */
import { isSupportedCurrency } from "../money/currencies";
import { type Issue, issue } from "../result";
import { isCalendarDate } from "../time/calendar-date";

export const CONTACT_KINDS = ["organization", "person"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export const CONTACT_ROLES = ["customer", "supplier", "partner", "prospect"] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];

export const CONTACT_STATUSES = ["lead", "active", "archived"] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const SALUTATIONS = ["herr", "frau", "divers", "none"] as const;
export type Salutation = (typeof SALUTATIONS)[number];

export const CONTACT_LANGUAGES = ["de", "en"] as const;
export type ContactLanguage = (typeof CONTACT_LANGUAGES)[number];

export const ROLE_LABELS: Readonly<Record<ContactRole, string>> = {
  customer: "Kunde",
  supplier: "Lieferant",
  partner: "Partner",
  prospect: "Interessent",
};

export const STATUS_LABELS: Readonly<Record<ContactStatus, string>> = {
  lead: "Lead",
  active: "aktiv",
  archived: "archiviert",
};

export const SALUTATION_LABELS: Readonly<Record<Salutation, string>> = {
  herr: "Herr",
  frau: "Frau",
  divers: "Divers",
  none: "Keine Anrede",
};

/** A blocking error (or warning) with the form field it belongs to (`{ code, message, field? }`, F02 §5). */
export interface FieldIssue extends Issue {
  readonly field?: string;
}

export const fieldIssue = (
  field: string | undefined,
  code: string,
  message: string,
  params?: Readonly<Record<string, string | number>>,
): FieldIssue => ({ ...issue(code, message, params), ...(field ? { field } : {}) });

export interface Validation {
  readonly errors: FieldIssue[];
  readonly warnings: FieldIssue[];
}

export const emptyValidation = (): { errors: FieldIssue[]; warnings: FieldIssue[] } => ({ errors: [], warnings: [] });

// ── display name (CON-002) ─────────────────────────────────────────────────────────────────────────────
export interface NameParts {
  readonly kind: ContactKind;
  readonly organizationName?: string | undefined;
  readonly academicTitle?: string | undefined;
  readonly firstName?: string | undefined;
  readonly lastName?: string | undefined;
}

/** Organisation → `organizationName`; person → `[academicTitle] firstName lastName` (CON-002). */
export function displayName(p: NameParts): string {
  if (p.kind === "organization") return (p.organizationName ?? "").trim();
  return [p.academicTitle, p.firstName, p.lastName]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

// ── number (CON-003) ───────────────────────────────────────────────────────────────────────────────────
export const CONTACT_NUMBER_RE = /^[A-Za-z0-9$%&*+\-/]{1,36}$/;

/** Uniqueness key: case-insensitive, trimmed (CON-003 "unique case-insensitive"). */
export const normalizeContactNumber = (n: string): string => n.trim().toUpperCase();

// ── search text (CON-172, §5.11: Müller = Muller = Mueller; phone digits only) ──────────────────────────
const TRANSLIT: Readonly<Record<string, string>> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss", æ: "ae", ø: "oe", å: "aa" };

/** Lower case without diacritics ("Müller" → "muller"); the form used for queries. */
export function foldSearch(text: string): string {
  return text.toLowerCase().replace(/ß/g, "ss").normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim();
}

/** German transliteration ("Müller" → "mueller"). */
function transliterate(text: string): string {
  return text.toLowerCase().replace(/[äöüßæøå]/g, (c) => TRANSLIT[c] ?? c);
}

const digits = (s: string) => s.replace(/\D/g, "");

/** Phone search tokens: international digits and the national form with leading 0 (+49 30 1234 → 49301234, 0301234). */
export function phoneTokens(e164OrRaw: string): string[] {
  const d = digits(e164OrRaw);
  if (!d) return [];
  const out = new Set([d]);
  if (e164OrRaw.trim().startsWith("+49") && d.startsWith("49")) out.add(`0${d.slice(2)}`);
  if (e164OrRaw.trim().startsWith("0049") && d.startsWith("0049")) out.add(`0${d.slice(4)}`);
  return [...out];
}

export interface SearchSource {
  readonly displayName: string;
  readonly organizationName2?: string | undefined;
  readonly number: string;
  readonly emails?: readonly string[];
  readonly phones?: readonly string[];
  readonly vatId?: string | undefined;
  readonly city?: string | undefined;
  readonly tags?: readonly string[];
}

/** Denormalised `contacts.searchText` (03 §2): every token in folded and transliterated form. */
export function buildSearchText(s: SearchSource): string {
  const words = [s.displayName, s.organizationName2 ?? "", s.city ?? "", ...(s.tags ?? [])].join(" ");
  const tokens = new Set<string>();
  for (const w of [foldSearch(words), transliterate(words), foldSearch(transliterate(words))].join(" ").split(/\s+/)) {
    if (w) tokens.add(w);
  }
  for (const t of [s.number, s.vatId ?? "", ...(s.emails ?? [])]) {
    const v = t.trim().toLowerCase();
    if (v) tokens.add(v);
  }
  for (const p of s.phones ?? []) for (const t of phoneTokens(p)) tokens.add(t);
  return [...tokens].join(" ");
}

/** Query normalisation: a phone-like query becomes its digits ("030 1234" → "0301234"), text is folded. */
export function normalizeSearchQuery(q: string): string {
  const t = q.trim();
  if (/^[+\d][\d\s/()-]{3,}$/.test(t)) return digits(t);
  return foldSearch(t);
}

// ── field validation (§5.1) ────────────────────────────────────────────────────────────────────────────
export interface CoreFields {
  readonly kind: ContactKind;
  readonly parentId?: string | undefined;
  readonly organizationName?: string | undefined;
  readonly organizationName2?: string | undefined;
  readonly academicTitle?: string | undefined;
  readonly firstName?: string | undefined;
  readonly lastName?: string | undefined;
  readonly position?: string | undefined;
  readonly birthday?: string | undefined;
  /** Empty = assign from the number range. */
  readonly number?: string | undefined;
  readonly roles: readonly string[];
  readonly currency: string;
  readonly isConsumer: boolean;
  readonly isPublicAuthority: boolean;
}

const tooLong = (field: string, n: number) =>
  fieldIssue(field, "TOO_LONG", `Der Text ist zu lang (max. ${n} Zeichen).`, { max: n });

/** §5.1 rules that need no context. `today` enables the birthday-in-the-future check. */
export function validateCoreFields(c: CoreFields, today?: string): Validation {
  const v = emptyValidation();
  const len = (s: string | undefined) => (s ?? "").trim().length;
  if (c.kind === "organization") {
    if (len(c.organizationName) === 0)
      v.errors.push(fieldIssue("organizationName", "REQUIRED", "Bitte den Firmennamen angeben."));
    else if (len(c.organizationName) > 160) v.errors.push(tooLong("organizationName", 160));
    if (c.parentId)
      v.errors.push(
        fieldIssue(
          "parentId",
          "PARENT_NOT_ALLOWED",
          "Organisationen können keiner anderen Organisation untergeordnet werden.",
        ),
      );
  } else {
    if (len(c.lastName) === 0) v.errors.push(fieldIssue("lastName", "REQUIRED", "Bitte den Nachnamen angeben."));
    else if (len(c.lastName) > 80) v.errors.push(tooLong("lastName", 80));
  }
  if (len(c.organizationName2) > 160) v.errors.push(tooLong("organizationName2", 160));
  if (len(c.firstName) > 80) v.errors.push(tooLong("firstName", 80));
  if (len(c.academicTitle) > 30) v.errors.push(tooLong("academicTitle", 30));
  if (len(c.position) > 80) v.errors.push(tooLong("position", 80));
  const number = (c.number ?? "").trim();
  if (number && !CONTACT_NUMBER_RE.test(number)) {
    v.errors.push(
      fieldIssue(
        "number",
        "CONTACT_NUMBER_INVALID",
        "Die Kontaktnummer darf 1–36 Zeichen enthalten (A–Z, a–z, 0–9 und $ % & * + - /).",
      ),
    );
  }
  if (c.roles.length === 0) {
    v.errors.push(
      fieldIssue(
        "roles",
        "ROLE_REQUIRED",
        "Bitte mindestens eine Rolle wählen (Kunde, Lieferant, Partner, Interessent).",
      ),
    );
  }
  const birthday = (c.birthday ?? "").trim();
  if (birthday && (!isCalendarDate(birthday) || (today !== undefined && birthday > today))) {
    v.errors.push(fieldIssue("birthday", "DATE_INVALID", "Ungültiges Datum."));
  }
  if (!isSupportedCurrency(c.currency)) {
    v.errors.push(fieldIssue("currency", "CURRENCY_INVALID", "Die Währung wird nicht unterstützt."));
  }
  if (c.isConsumer && c.isPublicAuthority) {
    v.errors.push(
      fieldIssue(
        "isPublicAuthority",
        "CONTACT_TYPE_CONFLICT",
        "Ein Kontakt kann nicht gleichzeitig Privatkunde und öffentlicher Auftraggeber sein.",
      ),
    );
  }
  return v;
}

/** CON-001/§5.1 `parentId` with the loaded parent (context check in the model). */
export function checkParent(
  childId: string | undefined,
  parent: { id: string; kind: ContactKind; status: ContactStatus; mergedIntoId?: string | undefined } | null,
): FieldIssue | null {
  const invalid = fieldIssue(
    "parentId",
    "PARENT_INVALID",
    "Ein Ansprechpartner kann nur einer Organisation zugeordnet werden.",
  );
  if (!parent) return invalid;
  if (parent.kind !== "organization" || parent.status === "archived" || parent.mergedIntoId) return invalid;
  if (childId !== undefined && parent.id === childId) return invalid;
  return null;
}

/** §5.1 `kind` change organisation → person with children. */
export function checkKindChange(before: ContactKind, after: ContactKind, childCount: number): FieldIssue | null {
  if (before === "organization" && after === "person" && childCount > 0) {
    return fieldIssue(
      "kind",
      "KIND_CHANGE_HAS_CHILDREN",
      "Die Organisation hat Ansprechpartner und kann nicht in eine Person umgewandelt werden.",
    );
  }
  return null;
}

export const contactNumberTaken = (number: string): FieldIssue =>
  fieldIssue("number", "CONTACT_NUMBER_TAKEN", `Die Kontaktnummer ${number} ist bereits vergeben.`, { number });

/** CON-004: a lead becomes active when the first document is finalised (called by the finalisation, F04). */
export function statusAfterFinalisation(status: ContactStatus): ContactStatus {
  return status === "lead" ? "active" : status;
}
