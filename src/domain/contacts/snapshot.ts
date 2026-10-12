/**
 * Contract between contacts and documents (F02 §3.17): the buyer snapshot frozen at finalisation (CON-180) and the
 * draft banner listing contact changes since the draft was created (CON-182). Documents (F04) call these; no contact
 * mutation ever touches a finalised document (CON-181, mutation inventory).
 */
import { canonicalize } from "../audit/canonical";
import type { PostalAddress } from "./address";
import type { ElectronicAddress } from "./tax";

export interface BuyerSnapshot {
  readonly contactId: string;
  readonly number: string;
  readonly displayName: string;
  readonly organizationName?: string | undefined;
  readonly organizationName2?: string | undefined;
  /** "z. Hd. Frau Dr. Anna Müller" — the legal recipient stays the organisation (CON-009). */
  readonly attention?: string | undefined;
  readonly billingAddress: PostalAddress;
  readonly deliveryAddress?: PostalAddress | undefined;
  readonly vatId?: string | undefined;
  readonly taxNumber?: string | undefined;
  readonly buyerReference?: string | undefined;
  readonly electronicAddress?: ElectronicAddress | undefined;
  readonly isConsumer: boolean;
  readonly isPublicAuthority: boolean;
  readonly language: "de" | "en";
  readonly customFields: Readonly<Record<string, unknown>>;
  readonly vatIdCheckId?: string | undefined;
}

export interface SnapshotSource {
  readonly id: string;
  readonly number: string;
  readonly displayName: string;
  readonly organizationName?: string | undefined;
  readonly organizationName2?: string | undefined;
  readonly vatId?: string | undefined;
  readonly taxNumber?: string | undefined;
  readonly buyerReference?: string | undefined;
  readonly isConsumer: boolean;
  readonly isPublicAuthority: boolean;
  readonly language: "de" | "en";
  readonly customFields: Readonly<Record<string, unknown>>;
}

const SALUTATION_TEXT: Readonly<Record<string, string>> = { herr: "Herrn", frau: "Frau" };

/** CON-009: attention line for a person under an organisation. */
export function attentionLine(person: {
  salutation?: string | undefined;
  academicTitle?: string | undefined;
  firstName?: string | undefined;
  lastName?: string | undefined;
}): string {
  const parts = [SALUTATION_TEXT[person.salutation ?? ""], person.academicTitle, person.firstName, person.lastName]
    .map((s) => (s ?? "").trim())
    .filter(Boolean);
  return `z. Hd. ${parts.join(" ")}`;
}

/** CON-180: the frozen buyer data; only custom fields with `printOnDocuments` are copied. */
export function buildBuyerSnapshot(input: {
  contact: SnapshotSource;
  billingAddress: PostalAddress;
  deliveryAddress?: PostalAddress | undefined;
  attention?: string | undefined;
  electronicAddress?: ElectronicAddress | undefined;
  printableCustomFieldKeys: readonly string[];
  vatIdCheckId?: string | undefined;
}): BuyerSnapshot {
  const c = input.contact;
  const customFields: Record<string, unknown> = {};
  for (const k of input.printableCustomFieldKeys)
    if (c.customFields[k] !== undefined) customFields[k] = c.customFields[k];
  return {
    contactId: c.id,
    number: c.number,
    displayName: c.displayName,
    ...(c.organizationName ? { organizationName: c.organizationName } : {}),
    ...(c.organizationName2 ? { organizationName2: c.organizationName2 } : {}),
    ...(input.attention ? { attention: input.attention } : {}),
    billingAddress: input.billingAddress,
    ...(input.deliveryAddress ? { deliveryAddress: input.deliveryAddress } : {}),
    ...(c.vatId ? { vatId: c.vatId } : {}),
    ...(c.taxNumber ? { taxNumber: c.taxNumber } : {}),
    ...(c.buyerReference ? { buyerReference: c.buyerReference } : {}),
    ...(input.electronicAddress ? { electronicAddress: input.electronicAddress } : {}),
    isConsumer: c.isConsumer,
    isPublicAuthority: c.isPublicAuthority,
    language: c.language,
    customFields,
    ...(input.vatIdCheckId ? { vatIdCheckId: input.vatIdCheckId } : {}),
  };
}

/** Non-address contact data a draft re-reads (CON-182) with the German labels of the banner. */
export const DRAFT_WATCHED_FIELDS = {
  vatId: "USt-IdNr",
  isConsumer: "Kundentyp",
  isPublicAuthority: "Kundentyp",
  buyerReference: "Leitweg-ID / Käuferreferenz",
  paymentTerms: "Zahlungsbedingungen",
  defaultTaxCase: "Steuerfall",
  language: "Sprache",
  currency: "Währung",
  displayName: "Name",
} as const;

/** CON-182 banner text: "Kontaktdaten wurden geändert: USt-IdNr, Kundentyp" (labels deduplicated). */
export function draftChangeBanner(
  atDraft: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
): string | null {
  const labels = new Set<string>();
  for (const [field, label] of Object.entries(DRAFT_WATCHED_FIELDS)) {
    if (canonicalize(atDraft[field] ?? null) !== canonicalize(current[field] ?? null)) labels.add(label);
  }
  return labels.size === 0 ? null : `Kontaktdaten wurden geändert: ${[...labels].join(", ")}`;
}

/** CON-023: drafts keep their address copy; this decides whether to show the „neue Adresse übernehmen?“ banner. */
export function addressChanged(draftCopy: PostalAddress | undefined, current: PostalAddress | undefined): boolean {
  return canonicalize(draftCopy ?? null) !== canonicalize(current ?? null);
}

export const ADDRESS_CHANGED_BANNER = "Die Adresse des Kontakts wurde geändert — neue Adresse übernehmen?";
export const ADDRESS_REMOVED_WARNING = "Die gewählte Adresse wurde entfernt — Standard-Rechnungsadresse verwendet.";
