/**
 * GoBD-safe merge (F02 CON-132…135, §4.4, §5.8; EC-113): same kind only; mutable data moves to the winner, finalised
 * records keep the loser's ID and resolve through `mergedIntoId`; undo while no moved draft was finalised.
 */
import { type FieldIssue, fieldIssue } from "./core";

/** Fields the owner may take from a loser (per-field choice, winner by default). */
export const MERGE_FIELDS = [
  "organizationName",
  "organizationName2",
  "salutation",
  "academicTitle",
  "firstName",
  "lastName",
  "position",
  "birthday",
  "vatId",
  "taxNumber",
  "buyerReference",
  "electronicAddress",
  "defaultTaxCase",
  "isConsumer",
  "isPublicAuthority",
  "language",
  "currency",
  "paymentTerms",
  "defaultDiscountBp",
  "paymentMethodId",
  "iban",
  "bic",
  "debtorAccount",
  "creditorAccount",
  "notes",
] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

export const MERGE_FIELD_LABELS: Readonly<Record<MergeField, string>> = {
  organizationName: "Firmenname",
  organizationName2: "Namenszusatz",
  salutation: "Anrede",
  academicTitle: "Titel",
  firstName: "Vorname",
  lastName: "Nachname",
  position: "Position",
  birthday: "Geburtstag",
  vatId: "USt-IdNr",
  taxNumber: "Steuernummer",
  buyerReference: "Käuferreferenz / Leitweg-ID",
  electronicAddress: "Elektronische Adresse",
  defaultTaxCase: "Standard-Steuerfall",
  isConsumer: "Privatkunde",
  isPublicAuthority: "Öffentlicher Auftraggeber",
  language: "Sprache",
  currency: "Währung",
  paymentTerms: "Zahlungsbedingungen",
  defaultDiscountBp: "Rabatt",
  paymentMethodId: "Zahlungsart",
  iban: "IBAN",
  bic: "BIC",
  debtorAccount: "Debitorenkonto",
  creditorAccount: "Kreditorenkonto",
  notes: "Interne Notiz",
};

/** Tables whose rows move to the winner (mutable data only; finalised records never move, CON-132). */
export const MOVED_TABLES = ["contactAddresses", "contactChannels", "contactActivities", "customerPrices"] as const;

export interface MergeContact {
  readonly id: string;
  readonly kind: "organization" | "person";
  readonly status: "lead" | "active" | "archived";
  readonly mergedIntoId?: string | undefined;
  readonly restrictedAt?: number | undefined;
  readonly displayName: string;
  readonly fields: Readonly<Partial<Record<MergeField, unknown>>>;
  readonly tags: readonly string[];
  readonly customFields: Readonly<Record<string, unknown>>;
}

export type FieldChoices = Readonly<Partial<Record<MergeField, string>>>;

/** §5.8 rules. `confirmVatConflict` acknowledges different non-empty VAT IDs (MERGE_VAT_CONFLICT). */
export function validateMerge(
  winner: MergeContact,
  losers: readonly MergeContact[],
  confirmVatConflict = false,
): FieldIssue | null {
  if (losers.length === 0)
    return fieldIssue("loserIds", "MERGE_NO_LOSER", "Bitte mindestens einen Kontakt zum Zusammenführen wählen.");
  if (winner.status === "archived" || winner.mergedIntoId || winner.restrictedAt !== undefined) {
    return fieldIssue("winnerId", "MERGE_WINNER_INVALID", "Der Zielkontakt ist archiviert oder eingeschränkt.");
  }
  for (const l of losers) {
    if (l.id === winner.id)
      return fieldIssue(
        "loserIds",
        "MERGE_SAME_CONTACT",
        "Ein Kontakt kann nicht mit sich selbst zusammengeführt werden.",
      );
    if (l.kind !== winner.kind) {
      return fieldIssue(
        "loserIds",
        "MERGE_KIND_MISMATCH",
        "Nur Kontakte desselben Typs (Organisation/Person) können zusammengeführt werden.",
      );
    }
    if (l.mergedIntoId)
      return fieldIssue("loserIds", "MERGE_LOSER_INVALID", `${l.displayName} wurde bereits zusammengeführt.`);
  }
  const vatIds = new Set([winner, ...losers].map((c) => c.fields.vatId).filter((v): v is string => !!v));
  if (vatIds.size > 1 && !confirmVatConflict) {
    return fieldIssue(
      "vatId",
      "MERGE_VAT_CONFLICT",
      "Die Kontakte haben unterschiedliche USt-IdNrs. Bitte die richtige auswählen — die Prüfnachweise beider bleiben erhalten.",
    );
  }
  return null;
}

/**
 * The winner's new values: per field the chosen contact's value (winner by default), tags as union, custom fields
 * merged with the winner winning unless a loser was chosen for that key (`customFieldChoices`).
 */
export function mergedValues(
  winner: MergeContact,
  losers: readonly MergeContact[],
  choices: FieldChoices,
  customFieldChoices: Readonly<Record<string, string>> = {},
): { fields: Partial<Record<MergeField, unknown>>; tags: string[]; customFields: Record<string, unknown> } {
  const byId = new Map([winner, ...losers].map((c) => [c.id, c]));
  const fields: Partial<Record<MergeField, unknown>> = {};
  for (const f of MERGE_FIELDS) {
    const source = choices[f] ? byId.get(choices[f] as string) : undefined;
    if (source && source.id !== winner.id) fields[f] = source.fields[f];
  }
  const tags = [...new Set([...winner.tags, ...losers.flatMap((l) => l.tags)])];
  const customFields: Record<string, unknown> = {};
  for (const l of [...losers].reverse()) Object.assign(customFields, l.customFields);
  Object.assign(customFields, winner.customFields);
  for (const [key, id] of Object.entries(customFieldChoices)) {
    const source = byId.get(id);
    if (source && source.customFields[key] !== undefined) customFields[key] = source.customFields[key];
  }
  return { fields, tags, customFields };
}

/** CON-135: warning when a loser's personal account was already handed to DATEV. */
export function datevMergeWarning(loserAccount: string | undefined, exported: boolean): string | null {
  if (!loserAccount || !exported) return null;
  return `Personenkonto ${loserAccount} wurde bereits an DATEV übergeben — offene Posten bitte in der Buchhaltung umbuchen.`;
}

/** CON-134: undo is possible while none of the moved drafts was finalised since. */
export function checkUndo(finalisedMovedDrafts: number, alreadyUndone: boolean): FieldIssue | null {
  if (alreadyUndone)
    return fieldIssue(undefined, "MERGE_ALREADY_UNDONE", "Die Zusammenführung wurde bereits rückgängig gemacht.");
  if (finalisedMovedDrafts > 0) {
    return fieldIssue(
      undefined,
      "MERGE_UNDO_IMPOSSIBLE",
      `Rückgängig nicht mehr möglich: ${finalisedMovedDrafts} übernommene Entwürfe wurden inzwischen fertiggestellt.`,
      { n: finalisedMovedDrafts },
    );
  }
  return null;
}

/** Follows `mergedIntoId` to the final winner (cycle-safe), CON-133 alias resolution. */
export function resolveAlias(id: string, mergedInto: (id: string) => string | undefined): string {
  const seen = new Set<string>();
  let current = id;
  for (let next = mergedInto(current); next && !seen.has(next); next = mergedInto(current)) {
    seen.add(current);
    current = next;
  }
  return current;
}
