/**
 * Personal data in audit diffs (F02 §5.12, 03 §10 `auditLog.diff`, DSGVO-02 vs GOBD-06): natural-person
 * values are stored encrypted with a per-contact data key (`contactKeys`), so purging the key erases them
 * while the hash chain (computed over the ciphertext) keeps verifying ("crypto-shredding").
 *
 * This file only says WHICH fields are personal and WHICH contact they belong to; encryption lives in
 * `convex/model/contactKeys.ts`. Business identifiers (number, organisation name, VAT ID, tax number) stay
 * in clear text.
 */
export interface PersonalFieldRule {
  /** Top-level document fields whose values are encrypted in audit diffs. */
  fields: readonly string[];
  /** Where the owning contact's id is found: the entity id itself, or a field of the document. */
  contactIdFrom: "entityId" | { field: string };
}

export const PERSONAL_FIELDS: Readonly<Record<string, PersonalFieldRule>> = {
  contacts: {
    fields: ["salutation", "academicTitle", "firstName", "lastName", "birthday", "displayName", "searchText", "notes"],
    contactIdFrom: "entityId",
  },
  contactAddresses: { fields: ["address"], contactIdFrom: { field: "contactId" } },
  contactChannels: { fields: ["value", "label"], contactIdFrom: { field: "contactId" } },
  contactActivities: { fields: ["text"], contactIdFrom: { field: "contactId" } },
};

export interface EncryptedValue {
  enc: { contactId: string; iv: string; ct: string };
}

export function isEncryptedValue(v: unknown): v is EncryptedValue {
  return (
    typeof v === "object" &&
    v !== null &&
    "enc" in v &&
    typeof (v as EncryptedValue).enc?.ct === "string" &&
    typeof (v as EncryptedValue).enc?.iv === "string"
  );
}

/** Resolves the contact id a diff of `table` belongs to, or undefined if the table holds no personal data. */
export function personalContactId(
  table: string,
  entityId: string,
  diff: { before?: Record<string, unknown>; after?: Record<string, unknown> } | undefined,
): string | undefined {
  const rule = PERSONAL_FIELDS[table];
  if (!rule) return undefined;
  if (rule.contactIdFrom === "entityId") return entityId;
  const { field } = rule.contactIdFrom;
  const id = diff?.after?.[field] ?? diff?.before?.[field];
  return typeof id === "string" ? id : undefined;
}

/**
 * Applies `encrypt` to every personal field in `diff.before` / `diff.after`; everything else is unchanged.
 */
export async function mapPersonalFields<D extends { before?: unknown; after?: unknown }>(
  table: string,
  diff: D,
  encrypt: (value: unknown) => Promise<EncryptedValue>,
): Promise<D> {
  const rule = PERSONAL_FIELDS[table];
  if (!rule) return diff;
  const mapSide = async (side: unknown) => {
    if (side === null || typeof side !== "object" || Array.isArray(side)) return side;
    const out: Record<string, unknown> = { ...(side as Record<string, unknown>) };
    for (const f of rule.fields) {
      if (out[f] !== undefined && out[f] !== null) out[f] = await encrypt(out[f]);
    }
    return out;
  };
  return {
    ...diff,
    ...(diff.before !== undefined ? { before: await mapSide(diff.before) } : {}),
    ...(diff.after !== undefined ? { after: await mapSide(diff.after) } : {}),
  };
}
