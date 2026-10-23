import { describe, expect, test } from "vitest";
import schema from "./schema";

/**
 * F12 PRV-011 / PRV-013: every table that points at a contact (and thus holds personal data of a data subject) must be
 * handled by the DSGVO flows — erased now (bucket 1), retained and restricted until its retention ends (bucket 2,
 * `contactReferences`), anonymised with the contact (`anonymiseContact`), or explicitly exempt with a reason.
 * A new table referencing `contacts` fails this test until it is classified here (and wired in convex/model/dsgvo.ts
 * or convex/model/retention.ts).
 */

type Handling = "erased" | "retained" | "anonymised" | "exempt";

const COVERAGE: Readonly<Record<string, { handling: Handling; why: string }>> = {
  contacts: { handling: "anonymised", why: "the subject itself: deleted when nothing is retained, else anonymised" },
  contactActivities: { handling: "erased", why: "bucket 1 (with attachments)" },
  contactAddresses: { handling: "erased", why: "bucket 1 unless printed on a retained document" },
  contactChannels: { handling: "erased", why: "bucket 1 unless printed on a retained document" },
  contactAliases: { handling: "erased", why: "BNK-048 learned payment name/IBAN, bucket 1" },
  customerPrices: { handling: "erased", why: "bucket 1" },
  recurringTemplates: { handling: "erased", why: "bucket 1" },
  recurringVouchers: { handling: "erased", why: "supplier template, bucket 1" },
  supplierProfiles: { handling: "erased", why: "learned booking defaults, bucket 1" },
  matchingRules: { handling: "erased", why: "bank rule assigning the contact, bucket 1" },
  dismissedDuplicates: { handling: "erased", why: "duplicate hint, bucket 1" },
  contactMerges: { handling: "erased", why: "undo snapshot holds the winner's old fields, bucket 1" },
  runningTimer: { handling: "erased", why: "transient timer, bucket 1" },
  salesDocuments: { handling: "retained", why: "finalised: vouchers8; drafts are bucket 1" },
  receivableLetters: { handling: "retained", why: "letters6 (F05 letters)" },
  payments: { handling: "retained", why: "books10" },
  journalEntries: { handling: "retained", why: "books10" },
  journalLines: { handling: "retained", why: "books10" },
  manualEntries: { handling: "retained", why: "books10 (a line names the contact)" },
  openingItems: { handling: "retained", why: "books10" },
  vatIdChecks: { handling: "retained", why: "books10" },
  vouchers: { handling: "retained", why: "vouchers8" },
  timeEntries: {
    handling: "retained",
    why: "invoiced entries vouchers8; open entries are the business's own work records and keep the link to the anonymised contact",
  },
  inboxItems: {
    handling: "exempt",
    why: "incoming supplier documents (voucher originals, retained with their voucher); the match link points at the anonymised contact; e-mail search via E-PRV-16",
  },
  projects: {
    handling: "exempt",
    why: "project master data of the business; the link points at the anonymised contact (free-text names are reviewed by the owner)",
  },
  dsgvoRequests: { handling: "exempt", why: "the request register itself is the Art. 5 Abs. 2 accountability record" },
};

interface ValidatorJson {
  type: string;
  tableName?: string;
  value?: unknown;
  fieldType?: unknown;
  keys?: unknown;
  values?: unknown;
}

function refersToContacts(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const j = v as ValidatorJson;
  if (j.type === "id") return j.tableName === "contacts";
  return Object.values(j).some((x) =>
    Array.isArray(x) ? x.some(refersToContacts) : typeof x === "object" && x !== null && refersToContacts(x),
  );
}

function contactTables(): string[] {
  return Object.entries(schema.tables)
    .filter(([, def]) => refersToContacts((def as unknown as { validator: { json: unknown } }).validator.json))
    .map(([name]) => name)
    .sort();
}

describe("DSGVO coverage of personal data (PRV-011, PRV-013)", () => {
  test("PRV-011 PRV-013 every table referencing a contact is erased, retained, anonymised or exempt with a reason", () => {
    expect(contactTables()).toEqual(Object.keys(COVERAGE).sort());
    for (const c of Object.values(COVERAGE)) expect(c.why.length).toBeGreaterThan(0);
  });
});
