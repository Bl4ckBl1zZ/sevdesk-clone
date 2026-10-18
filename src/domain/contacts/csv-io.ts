/**
 * Contact CSV import mapping and export columns (F02 CON-140…143, §5.7, §6.8). Header aliases include the sevdesk
 * export headers listed in F09 §4.3.1 (UNSURE until owner samples exist). Every row becomes a create-form value and
 * is validated with the same zod schema as the UI (CON-142); the preview classifies rows as neu / Aktualisierung /
 * Konflikt / Fehler with the match order number → VAT ID → invoice e-mail (CON-141).
 */
import { foldSearch } from "./core";

export const CONTACT_IMPORT_FIELDS = [
  "number",
  "kind",
  "organizationName",
  "organizationName2",
  "salutation",
  "academicTitle",
  "firstName",
  "lastName",
  "position",
  "roles",
  "street",
  "street2",
  "postalCode",
  "city",
  "countryCode",
  "email",
  "phone",
  "mobile",
  "fax",
  "web",
  "vatId",
  "taxNumber",
  "buyerReference",
  "iban",
  "bic",
  "isConsumer",
  "isPublicAuthority",
  "dueDays",
  "debtorAccount",
  "creditorAccount",
  "language",
  "currency",
  "birthday",
  "tags",
  "notes",
] as const;
export type ContactImportField = (typeof CONTACT_IMPORT_FIELDS)[number];

export const CONTACT_IMPORT_FIELD_LABELS: Readonly<Record<ContactImportField, string>> = {
  number: "Kontaktnummer",
  kind: "Typ (Organisation/Person)",
  organizationName: "Firma",
  organizationName2: "Namenszusatz",
  salutation: "Anrede",
  academicTitle: "Titel",
  firstName: "Vorname",
  lastName: "Nachname",
  position: "Position",
  roles: "Rolle / Kategorie",
  street: "Straße",
  street2: "Adresszusatz",
  postalCode: "PLZ",
  city: "Ort",
  countryCode: "Land",
  email: "E-Mail (Rechnung)",
  phone: "Telefon",
  mobile: "Mobil",
  fax: "Fax",
  web: "Webseite",
  vatId: "USt-IdNr",
  taxNumber: "Steuernummer",
  buyerReference: "Leitweg-ID / Käuferreferenz",
  iban: "IBAN",
  bic: "BIC",
  isConsumer: "Privatkunde",
  isPublicAuthority: "Öffentlicher Auftraggeber",
  dueDays: "Zahlungsziel (Tage)",
  debtorAccount: "Debitorenkonto",
  creditorAccount: "Kreditorenkonto",
  language: "Sprache",
  currency: "Währung",
  birthday: "Geburtstag",
  tags: "Tags",
  notes: "Notiz",
};

/** Normalised header → field (aliases incl. sevdesk's export headers, F09 §4.3.1). */
const ALIASES: Readonly<Record<string, ContactImportField>> = Object.fromEntries(
  (
    [
      [
        "number",
        ["kontaktnummer", "kundennummer", "kunden-nr", "kunden-nr.", "kundennr", "nr", "nr.", "nummer", "number"],
      ],
      ["kind", ["typ", "kontaktart", "art", "kind"]],
      ["organizationName", ["firma", "firmenname", "organisation", "unternehmen", "name", "company"]],
      ["organizationName2", ["namenszusatz", "name 2", "name2", "firma 2", "zusatz"]],
      ["salutation", ["anrede", "salutation"]],
      ["academicTitle", ["titel", "akad. grad", "title"]],
      ["firstName", ["vorname", "first name", "firstname"]],
      ["lastName", ["nachname", "familienname", "last name", "lastname", "surname"]],
      ["position", ["position", "funktion"]],
      ["roles", ["kategorie", "rolle", "rollen", "role", "category"]],
      ["street", ["strasse", "straße", "str.", "adresse", "street"]],
      ["street2", ["adresszusatz", "strasse 2", "straße 2", "street 2"]],
      ["postalCode", ["plz", "postleitzahl", "zip", "postal code", "postcode"]],
      ["city", ["ort", "stadt", "city"]],
      ["countryCode", ["land", "laenderkennzeichen", "länderkennzeichen", "country"]],
      ["email", ["e-mail", "email", "mail", "rechnungs-e-mail", "e-mail-adresse"]],
      ["phone", ["telefon", "tel.", "telefonnummer", "phone"]],
      ["mobile", ["mobil", "handy", "mobiltelefon", "mobile"]],
      ["fax", ["fax", "telefax"]],
      ["web", ["webseite", "website", "homepage", "internet", "web"]],
      [
        "vatId",
        [
          "ust-idnr",
          "ust-idnr.",
          "ust-id",
          "ustid",
          "umsatzsteuer-id",
          "umsatzsteuer-identifikationsnummer",
          "vat id",
          "eu-ust-idnr.",
          // sevdesk contact export (verified 2026-10-18)
          "umst.-id",
          "umst-id",
        ],
      ],
      ["taxNumber", ["steuernummer", "steuer-nr", "tax number"]],
      [
        "buyerReference",
        [
          "leitweg-id",
          "leitweg id",
          "leitweg-id / leitwegsnummer",
          "kaeuferreferenz",
          "käuferreferenz",
          "buyer reference",
        ],
      ],
      ["iban", ["iban", "iban 1"]],
      ["bic", ["bic", "swift", "swift-code", "swift-code 1"]],
      ["isConsumer", ["privatkunde", "b2c", "endkunde"]],
      ["isPublicAuthority", ["oeffentlicher auftraggeber", "öffentlicher auftraggeber", "b2g", "behoerde", "behörde"]],
      ["dueDays", ["zahlungsziel", "zahlungsziel (tage)", "zahlungsziel tage", "due days"]],
      ["debtorAccount", ["debitorenkonto", "debitoren-nr", "debitoren-nr.", "debitorennummer", "debitor"]],
      ["creditorAccount", ["kreditorenkonto", "kreditoren-nr", "kreditoren-nr.", "kreditorennummer", "kreditor"]],
      ["language", ["sprache", "language"]],
      ["currency", ["waehrung", "währung", "currency"]],
      ["birthday", ["geburtstag", "geburtsdatum", "birthday"]],
      ["tags", ["tags", "schlagworte", "stichworte"]],
      ["notes", ["notiz", "notizen", "bemerkung", "bemerkungen", "beschreibung", "notes"]],
    ] as const
  ).flatMap(([field, names]) => names.map((n) => [foldSearch(n), field as ContactImportField])),
);

/** CON-140: automatic mapping of CSV headers (each field at most once; unknown headers stay unmapped). */
export function autoMapHeaders(headers: readonly string[]): (ContactImportField | null)[] {
  const used = new Set<ContactImportField>();
  return headers.map((h) => {
    const field = ALIASES[foldSearch(h)];
    if (!field || used.has(field)) return null;
    used.add(field);
    return field;
  });
}

/** §5.7: at least „Firma“ or „Nachname“ must be mapped. */
export function checkMapping(mapping: readonly (ContactImportField | null)[]): string | null {
  return mapping.includes("organizationName") || mapping.includes("lastName")
    ? null
    : "Bitte mindestens „Firma“ oder „Nachname“ zuordnen.";
}

const truthy = (v: string) => /^(1|ja|j|yes|y|true|wahr|x)$/i.test(v.trim());

const SALUTATION: Readonly<Record<string, string>> = {
  herr: "herr",
  herrn: "herr",
  hr: "herr",
  "hr.": "herr",
  frau: "frau",
  fr: "frau",
  "fr.": "frau",
  divers: "divers",
};

/** Roles from free text (sevdesk „Kategorie“: Kunde, Lieferant, Partner, Interessent; several separated by , ; /). */
export function parseRoles(v: string): ("customer" | "supplier" | "partner" | "prospect")[] {
  const out = new Set<"customer" | "supplier" | "partner" | "prospect">();
  for (const part of v.split(/[,;/|]/).map((p) => foldSearch(p))) {
    if (/^(kunde|kunden|customer)$/.test(part)) out.add("customer");
    else if (/^(lieferant|lieferanten|supplier|vendor)$/.test(part)) out.add("supplier");
    else if (/^(partner)$/.test(part)) out.add("partner");
    else if (/^(interessent|lead|prospect)$/.test(part)) out.add("prospect");
  }
  return [...out];
}

/** "Deutschland" / "DE" / "Österreich" → ISO code (common German names; codes pass through). */
export function parseCountry(v: string): string {
  const t = v.trim();
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
  const names: Record<string, string> = {
    deutschland: "DE",
    germany: "DE",
    osterreich: "AT",
    austria: "AT",
    schweiz: "CH",
    switzerland: "CH",
    frankreich: "FR",
    france: "FR",
    niederlande: "NL",
    italien: "IT",
    spanien: "ES",
    polen: "PL",
    belgien: "BE",
    luxemburg: "LU",
    danemark: "DK",
    "vereinigtes konigreich": "GB",
    grossbritannien: "GB",
    "united kingdom": "GB",
    usa: "US",
    "vereinigte staaten": "US",
  };
  return names[foldSearch(t)] ?? (t === "" ? "DE" : t.toUpperCase());
}

/** German date "31.12.1980" or ISO → ISO; anything else is returned unchanged (the schema reports it). */
export function parseDate(v: string): string {
  const t = v.trim();
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
  return m ? `${m[3]}-${(m[2] ?? "").padStart(2, "0")}-${(m[1] ?? "").padStart(2, "0")}` : t;
}

export interface ImportRowValues {
  contact: Record<string, unknown>;
  billingAddress: Record<string, string>;
  channels: { type: string; value: string; label: string; isPrimary: boolean; isInvoiceEmail: boolean }[];
}

/**
 * One CSV row → create-form values (same shape as the UI form, validated with `contactCreateSchema`). `base` is the
 * empty form with the company defaults.
 */
export function rowToFormValues(
  row: readonly string[],
  mapping: readonly (ContactImportField | null)[],
  base: Record<string, unknown>,
): ImportRowValues {
  const get = (f: ContactImportField) => {
    const i = mapping.indexOf(f);
    return i < 0 ? "" : (row[i] ?? "").trim();
  };
  const org = get("organizationName");
  const last = get("lastName");
  const kindText = foldSearch(get("kind"));
  const kind =
    kindText === "person" || kindText === "privatperson" || kindText === "1"
      ? "person"
      : kindText === "organisation" || kindText === "unternehmen" || kindText === "2"
        ? "organization"
        : org === "" && last !== ""
          ? "person"
          : "organization";
  const roles = parseRoles(get("roles"));
  const contact: Record<string, unknown> = {
    ...base,
    kind,
    number: get("number"),
    organizationName: kind === "organization" ? org : "",
    organizationName2: get("organizationName2"),
    salutation: SALUTATION[foldSearch(get("salutation"))] ?? "",
    academicTitle: get("academicTitle"),
    firstName: get("firstName"),
    lastName: last,
    position: get("position"),
    birthday: parseDate(get("birthday")),
    roles: roles.length > 0 ? roles : ["customer"],
    vatId: get("vatId"),
    taxNumber: get("taxNumber"),
    buyerReference: get("buyerReference"),
    iban: get("iban"),
    bic: get("bic"),
    isConsumer: truthy(get("isConsumer")),
    isPublicAuthority: truthy(get("isPublicAuthority")),
    dueDays: get("dueDays"),
    debtorAccount: get("debtorAccount"),
    creditorAccount: get("creditorAccount"),
    notes: get("notes"),
  };
  const lang = foldSearch(get("language"));
  if (lang) contact.language = lang.startsWith("en") ? "en" : "de";
  const currency = get("currency");
  if (currency) contact.currency = currency.toUpperCase();
  const name = kind === "organization" ? org : [get("firstName"), last].filter(Boolean).join(" ");
  const channels: ImportRowValues["channels"] = [];
  const add = (type: string, value: string, isInvoiceEmail = false) => {
    if (value) channels.push({ type, value, label: "", isPrimary: true, isInvoiceEmail });
  };
  add("email", get("email"), true);
  add("phone", get("phone"));
  add("mobile", get("mobile"));
  add("fax", get("fax"));
  add("web", get("web"));
  return {
    contact,
    billingAddress: {
      name,
      name2: "",
      department: "",
      street: get("street"),
      street2: get("street2"),
      postalCode: get("postalCode"),
      city: get("city"),
      countryCode: parseCountry(get("countryCode")),
      poBox: "",
    },
    channels,
  };
}

/** Tags column ("A, B; C") → names. */
export const parseTagNames = (v: string): string[] =>
  v
    .split(/[,;|]/)
    .map((t) => t.trim())
    .filter(Boolean);

export type ImportRowStatus = "new" | "update" | "conflict" | "error";
export const IMPORT_ROW_STATUS_LABELS: Readonly<Record<ImportRowStatus, string>> = {
  new: "neu",
  update: "Aktualisierung",
  conflict: "Konflikt",
  error: "Fehler",
};

export interface ExistingMatch {
  readonly id: string;
  readonly number: string;
  readonly restricted: boolean;
}

/**
 * CON-141 status of a valid row given the match found (number → VAT ID → invoice e-mail) and the mode.
 * Restricted contacts are never silently reactivated (CON-E32).
 */
export function classifyRow(
  match: ExistingMatch | null,
  mode: "create_only" | "create_and_update",
  rowNumber: string,
): { status: ImportRowStatus; message?: string } {
  if (!match) return { status: "new" };
  if (match.restricted) return { status: "conflict", message: "Kontakt ist nach DSGVO eingeschränkt" };
  if (mode === "create_only") {
    return {
      status: "conflict",
      message: rowNumber
        ? `Kontaktnummer ${rowNumber} existiert bereits.`
        : `Kontakt ${match.number} existiert bereits.`,
    };
  }
  return { status: "update" };
}

/** §5.7 duplicate keys inside the file: "Zeile {n} hat dieselbe {key} wie Zeile {m}." */
export function duplicateKeysInFile(
  rows: readonly { rowNumber: number; number: string; vatId: string; email: string }[],
): Map<number, string> {
  const out = new Map<number, string>();
  const seen = new Map<string, number>();
  const labels = { number: "Kontaktnummer", vatId: "USt-IdNr", email: "E-Mail-Adresse" } as const;
  for (const r of rows) {
    for (const key of ["number", "vatId", "email"] as const) {
      const value = r[key].trim().toLowerCase();
      if (!value) continue;
      const k = `${key}|${value}`;
      const first = seen.get(k);
      if (first !== undefined && !out.has(r.rowNumber)) {
        out.set(r.rowNumber, `Zeile ${r.rowNumber} hat dieselbe ${labels[key]} wie Zeile ${first}.`);
      } else if (first === undefined) seen.set(k, r.rowNumber);
    }
  }
  return out;
}

// ── export (CON-143) ───────────────────────────────────────────────────────────────────────────────────
export const CONTACT_EXPORT_HEADERS = [
  "Kontaktnummer",
  "Typ",
  "Name",
  "Firma",
  "Namenszusatz",
  "Anrede",
  "Titel",
  "Vorname",
  "Nachname",
  "Rollen",
  "Status",
  "Straße",
  "PLZ",
  "Ort",
  "Land",
  "E-Mail",
  "Telefon",
  "Rechnungs-E-Mails",
  "USt-IdNr",
  "USt-IdNr-Status",
  "Steuernummer",
  "Leitweg-ID / Käuferreferenz",
  "Privatkunde",
  "Öffentlicher Auftraggeber",
  "Zahlungsziel",
  "IBAN",
  "BIC",
  "Debitorenkonto",
  "Kreditorenkonto",
  "Tags",
  "Eigene Felder",
] as const;

export interface ContactExportSource {
  readonly number: string;
  readonly kind: "organization" | "person";
  readonly displayName: string;
  readonly organizationName?: string | undefined;
  readonly organizationName2?: string | undefined;
  readonly salutation?: string | undefined;
  readonly academicTitle?: string | undefined;
  readonly firstName?: string | undefined;
  readonly lastName?: string | undefined;
  readonly roles: readonly string[];
  readonly status: string;
  readonly billing?: { street: string; postalCode: string; city: string; countryCode: string } | undefined;
  readonly primaryEmail?: string | undefined;
  readonly primaryPhone?: string | undefined;
  readonly invoiceEmails: readonly string[];
  readonly vatId?: string | undefined;
  readonly vatStatusText: string;
  readonly taxNumber?: string | undefined;
  readonly buyerReference?: string | undefined;
  readonly isConsumer: boolean;
  readonly isPublicAuthority: boolean;
  readonly dueDays?: number | undefined;
  readonly iban?: string | undefined;
  readonly bic?: string | undefined;
  readonly debtorAccount?: string | undefined;
  readonly creditorAccount?: string | undefined;
  readonly tagNames: readonly string[];
  readonly customFields: Readonly<Record<string, unknown>>;
}

const ROLE_EXPORT: Readonly<Record<string, string>> = {
  customer: "Kunde",
  supplier: "Lieferant",
  partner: "Partner",
  prospect: "Interessent",
};
const STATUS_EXPORT: Readonly<Record<string, string>> = { lead: "Lead", active: "Aktiv", archived: "Archiviert" };
const SALUTATION_EXPORT: Readonly<Record<string, string>> = { herr: "Herr", frau: "Frau", divers: "Divers" };

/** CON-143: one export row in the order of CONTACT_EXPORT_HEADERS. */
export function contactExportRow(c: ContactExportSource): string[] {
  const yesNo = (b: boolean) => (b ? "ja" : "nein");
  return [
    c.number,
    c.kind === "organization" ? "Organisation" : "Person",
    c.displayName,
    c.organizationName ?? "",
    c.organizationName2 ?? "",
    SALUTATION_EXPORT[c.salutation ?? ""] ?? "",
    c.academicTitle ?? "",
    c.firstName ?? "",
    c.lastName ?? "",
    c.roles.map((r) => ROLE_EXPORT[r] ?? r).join(", "),
    STATUS_EXPORT[c.status] ?? c.status,
    c.billing?.street ?? "",
    c.billing?.postalCode ?? "",
    c.billing?.city ?? "",
    c.billing?.countryCode ?? "",
    c.primaryEmail ?? "",
    c.primaryPhone ?? "",
    c.invoiceEmails.join(", "),
    c.vatId ?? "",
    c.vatStatusText,
    c.taxNumber ?? "",
    c.buyerReference ?? "",
    yesNo(c.isConsumer),
    yesNo(c.isPublicAuthority),
    c.dueDays === undefined ? "" : String(c.dueDays),
    c.iban ?? "",
    c.bic ?? "",
    c.debtorAccount ?? "",
    c.creditorAccount ?? "",
    c.tagNames.join(", "),
    Object.entries(c.customFields)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${String(v)}`)
      .join("; "),
  ];
}
