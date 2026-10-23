import { DOCUMENT_ID_PREFIXES, type DocumentIdType, encodeId, type IdTable } from "../api/ids";

/**
 * `data.object` of outbound webhook events (05 §5.2). A reference to the resource the receiver can fetch with its API
 * key (prefixed ID as in GET), plus the non-personal state that triggers website automations (status, number,
 * amounts, `order_reference`). Never names, addresses, e-mails, IBANs or free texts (F02 §7, DSGVO-05).
 */
export type WebhookObject = Record<string, unknown> & { id: string; object: string; updated_at: string };

const iso = (ms: number) => new Date(ms).toISOString();

export function refObject(
  table: IdTable,
  id: string,
  object: string,
  at: number,
  extra: Record<string, unknown> = {},
): WebhookObject {
  return { id: encodeId(table, id), object, ...extra, updated_at: iso(at) };
}

export interface DocumentLike {
  _id: string;
  type: string;
  status: string;
  number?: string;
  paymentStatus?: string;
  artifactStatus?: string;
  documentDate?: string;
  dueDate?: string;
  currency: string;
  totals?: { grossCents: number; payableCents: number };
  openAmountCents?: number;
  orderReference?: string;
  buyerReference?: string;
  contactId?: string;
}

/** Sales documents: `quo_`/`ord_`/`dln_`/`inv_`/`cor_`/`rem_` as in GET. */
export function documentObject(d: DocumentLike, at: number): WebhookObject {
  const prefix = DOCUMENT_ID_PREFIXES[d.type as DocumentIdType] ?? "inv_";
  return {
    id: `${prefix}${d._id}`,
    object: d.type,
    status: d.status,
    number: d.number ?? null,
    payment_status: d.paymentStatus ?? null,
    artifact_status: d.artifactStatus ?? null,
    document_date: d.documentDate ?? null,
    due_date: d.dueDate ?? null,
    currency: d.currency,
    total_gross_cents: d.totals?.grossCents ?? null,
    payable_cents: d.totals?.payableCents ?? null,
    open_amount_cents: d.openAmountCents ?? null,
    order_reference: d.orderReference ?? null,
    buyer_reference: d.buyerReference ?? null,
    contact_id: d.contactId ? encodeId("contacts", d.contactId) : null,
    updated_at: iso(at),
  };
}

/** Contacts: the ID only — consumers fetch the contact (F02 §7). */
export function contactObject(contactId: string, at: number, extra: { archived?: boolean } = {}): WebhookObject {
  return refObject(
    "contacts",
    contactId,
    "contact",
    at,
    extra.archived === undefined ? {} : { archived: extra.archived },
  );
}

/** `data.previous` for personal resources: the changed field NAMES, never their values. */
export function changedFieldNames(fields: Iterable<string>): { changed_fields: string[] } {
  return { changed_fields: [...new Set(fields)].filter((f) => !f.startsWith("_")).sort() };
}
