import type { ContactBundle } from "./contact-detail";

/** Test fixture shaped like `api.contacts.get` (F02 §6.3) for the contact component tests. */
export const AT = Date.UTC(2026, 9, 12, 8, 0);

export function contactBundle(overrides: Record<string, unknown> = {}): ContactBundle {
  const contact = {
    _id: "c1",
    _creationTime: AT,
    number: "10001",
    kind: "organization",
    organizationName: "Muster GmbH",
    displayName: "Muster GmbH",
    status: "active",
    roles: ["customer", "supplier"],
    tags: ["t1"],
    isConsumer: false,
    isPublicAuthority: false,
    vatId: "ATU12345678",
    taxNumber: "12/345/67890",
    iban: "DE89370400440532013000",
    debtorAccount: "10001",
    paymentTerms: { dueDays: 14 },
    einvoice: {
      preferredFormat: "auto",
      pdfConsents: [
        { givenAt: "2026-01-15", source: "email", recordedAt: AT - 1000, note: "per Mail vom Einkauf" },
        { givenAt: "2025-03-01", source: "contract", recordedAt: AT - 5000, revokedAt: "2025-12-31" },
      ],
    },
    reverseCharge13bCertificates: [
      { validUntil: "2025-12-31", addedAt: AT - 9000, replacedAt: AT - 2000 },
      { validUntil: "2026-12-31", addedAt: AT - 2000, file: { name: "ust1tg.pdf" } },
    ],
    version: 3,
  };
  return {
    contact,
    addresses: [
      {
        _id: "a1",
        contactId: "c1",
        type: "billing",
        isDefault: true,
        address: { name: "Muster GmbH", street: "Hauptstr. 1", postalCode: "10115", city: "Berlin", countryCode: "DE" },
      },
      {
        _id: "a2",
        contactId: "c1",
        type: "delivery",
        isDefault: false,
        address: {
          name: "Muster GmbH Lager",
          department: "Wareneingang",
          street: "Lagerweg 5",
          postalCode: "80331",
          city: "München",
          countryCode: "DE",
        },
      },
    ],
    channels: [
      {
        _id: "ch1",
        contactId: "c1",
        type: "email",
        value: "rechnung@muster.de",
        isPrimary: true,
        isInvoiceEmail: true,
      },
      {
        _id: "ch2",
        contactId: "c1",
        type: "phone",
        value: "030 123456",
        e164: "+4930123456",
        label: "Zentrale",
        isPrimary: true,
        isInvoiceEmail: false,
      },
      {
        _id: "ch3",
        contactId: "c1",
        type: "web",
        value: "https://muster.de",
        isPrimary: false,
        isInvoiceEmail: false,
      },
      { _id: "ch4", contactId: "c1", type: "fax", value: "030 999", isPrimary: false, isInvoiceEmail: false },
    ],
    activities: [
      { _id: "act1", _creationTime: AT + 3_600_000, contactId: "c1", kind: "note", text: "Rückruf wegen Angebot" },
      {
        _id: "act2",
        _creationTime: AT + 7_200_000,
        contactId: "c1",
        kind: "task",
        text: "Mahnung prüfen",
        dueAt: Date.UTC(2026, 9, 20, 10),
      },
    ],
    derived: [{ kind: "vat_check", at: AT, text: "USt-IdNr ATU12345678 geprüft: gültig" }],
    persons: [{ _id: "p1", number: "10002", displayName: "Erika Mustermann", position: "Einkauf", status: "active" }],
    parent: null,
    mergedInto: null,
    merges: [],
    checks: [
      {
        _id: "chk1",
        contactId: "c1",
        provider: "bzst_evatr",
        vatId: "ATU12345678",
        status: "valid",
        message: "Die USt-IdNr ist gültig.",
        checkedAt: AT,
        qualified: { name: "A", street: "A", postalCode: "B", city: "A" },
      },
    ],
    vatBadge: { kind: "qualified", text: "✓ qualifiziert bestätigt am 12.10.2026" },
    taxProfile: {
      service: { taxCase: "eu_b2b_service", reason: "EU-Unternehmer mit gültiger USt-IdNr" },
      goods: { taxCase: "intra_community_supply", reason: "Lieferung in einen anderen EU-Staat" },
      override: null,
      warnings: ["USt-IdNr vor der ersten Rechnung qualifiziert prüfen"],
    },
    invoiceRecipients: ["rechnung@muster.de"],
    electronicAddress: { scheme: "EM", value: "rechnung@muster.de" },
    certificate: { validUntil: "2026-12-31", addedAt: AT - 2000, file: { name: "ust1tg.pdf" } },
    tags: [{ _id: "t1", name: "Stammkunde", color: null }],
    paymentMethod: null,
    duplicateHints: [],
    stats: {},
    supplierStats: { spendThisYearCents: 250_000, spendAllTimeCents: 1_234_567, openPayablesCents: 9_900 },
    deleteBlockedBy: [],
    today: "2026-10-23",
    ...overrides,
  } as unknown as ContactBundle;
}
