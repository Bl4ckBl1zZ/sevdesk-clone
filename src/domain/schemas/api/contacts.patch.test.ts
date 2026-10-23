import { describe, expect, test } from "vitest";
import { contactFormFromRecord, contactSchema } from "../contacts";
import {
  addressToForm,
  type ContactWireRecord,
  contactFieldMapper,
  contactMergeArgs,
  contactPatchToForm,
  contactPatchWire,
  contactSearchRow,
  serializeContact,
} from "./contacts";

/** 05 §4.1 / F02 §7.1 PATCH /contacts/{id}: every writable wire field maps to its form field; null clears. */

const RAW = "k57f3x2m9q8w1e4r6t";
const RAW2 = "a1b2c3d4e5f6g7h8i9";

describe("PATCH /contacts wire → form (05 §4.1)", () => {
  test("API-015 CON-005 CON-043 every writable person, tax, e-invoice, payment and accounting field maps onto the form", () => {
    const wire = contactPatchWire.parse({
      parent_id: `con_${RAW}`,
      organization_name: "Muster GmbH",
      organization_name2: "Niederlassung Nord",
      salutation: "frau",
      academic_title: "Dr.",
      first_name: "Erika",
      last_name: "Muster",
      position: "Einkauf",
      birthday: "1980-05-17",
      number: "10042",
      roles: ["customer", "supplier"],
      status: "lead",
      is_consumer: false,
      is_public_authority: true,
      vat_id: "DE123456788",
      tax_number: "21/815/08150",
      default_tax_case: "",
      buyer_reference: "04011000-12345-67",
      electronic_address: { scheme: "EM", value: "rechnung@muster.de" },
      preferred_format: "xrechnung_cii",
      language: "en",
      currency: "CHF",
      default_discount_bp: 350,
      payment_method_id: `pmt_${RAW2}`,
      iban: "DE89370400440532013000",
      bic: "COBADEFFXXX",
      debtor_account: "10042",
      creditor_account: "70042",
      use_collective_debtor: true,
      tags: [`tag_${RAW}`],
      custom_fields: { kundengruppe: "A", rabattstufe: 2, newsletter: true },
      notes: "Rechnungen nur per XRechnung",
    });
    expect(contactPatchToForm(wire)).toEqual({
      parentId: RAW,
      organizationName: "Muster GmbH",
      organizationName2: "Niederlassung Nord",
      salutation: "frau",
      academicTitle: "Dr.",
      firstName: "Erika",
      lastName: "Muster",
      position: "Einkauf",
      birthday: "1980-05-17",
      number: "10042",
      roles: ["customer", "supplier"],
      status: "lead",
      isConsumer: false,
      isPublicAuthority: true,
      vatId: "DE123456788",
      taxNumber: "21/815/08150",
      defaultTaxCase: "",
      buyerReference: "04011000-12345-67",
      electronicAddressScheme: "EM",
      electronicAddressValue: "rechnung@muster.de",
      preferredFormat: "xrechnung_cii",
      language: "en",
      currency: "CHF",
      defaultDiscount: "3,5",
      paymentMethodId: RAW2,
      iban: "DE89370400440532013000",
      bic: "COBADEFFXXX",
      debtorAccount: "10042",
      creditorAccount: "70042",
      useCollectiveDebtor: true,
      tags: [RAW],
      customFields: { kundengruppe: "A", rabattstufe: 2, newsletter: true },
      notes: "Rechnungen nur per XRechnung",
    });
  });

  test("API-015 null clears the parent, the e-invoice address, the default discount and the payment method", () => {
    const form = contactPatchToForm(
      contactPatchWire.parse({
        parent_id: null,
        electronic_address: null,
        default_discount_bp: null,
        payment_method_id: null,
        payment_terms: { due_days: 10 },
      }),
    );
    expect(form).toEqual({
      parentId: "",
      electronicAddressScheme: "",
      electronicAddressValue: "",
      defaultDiscount: "",
      paymentMethodId: "",
      dueDays: "10",
      skontoPercent: "",
      skontoDays: "",
      paymentTermsText: "",
    });
    expect(contactPatchToForm(contactPatchWire.parse({}))).toEqual({});
  });

  test("CON-020 an address on the wire fills the form; missing parts keep the defaults of the country", () => {
    expect(addressToForm(undefined, "AT")).toMatchObject({ countryCode: "AT", street: "", city: "" });
    expect(
      addressToForm(
        {
          name: "Muster GmbH",
          name2: "z. Hd. Buchhaltung",
          department: "Einkauf",
          street: "Ring 1",
          street2: "Hinterhaus",
          postal_code: "1010",
          city: "Wien",
          country_code: "AT",
          po_box: "12",
        },
        "DE",
      ),
    ).toEqual({
      name: "Muster GmbH",
      name2: "z. Hd. Buchhaltung",
      department: "Einkauf",
      street: "Ring 1",
      street2: "Hinterhaus",
      postalCode: "1010",
      city: "Wien",
      countryCode: "AT",
      poBox: "12",
    });
    expect(addressToForm({ city: "Berlin" }, "DE")).toMatchObject({ city: "Berlin", countryCode: "DE", street: "" });
  });

  test("API-009 a missing or contact-only issue path has no wire field", () => {
    expect(contactFieldMapper(undefined)).toBeUndefined();
    expect(contactFieldMapper("contact")).toBeUndefined();
    expect(contactFieldMapper("contact.values")).toBeUndefined();
    expect(contactFieldMapper("contact.organizationName2")).toBe("organization_name2");
  });
});

describe("contact serialisation and merge arguments (05 §4.1, 06 §3.2)", () => {
  const record: ContactWireRecord = {
    _id: RAW,
    _creationTime: Date.UTC(2026, 9, 1),
    kind: "organization",
    number: "10001",
    displayName: "Muster GmbH",
    status: "active",
    organizationName: "Muster GmbH",
    roles: ["customer"],
    isConsumer: false,
    isPublicAuthority: false,
    vatId: "DE123456788",
    einvoice: { preferredFormat: "auto" },
    language: "de",
    currency: "EUR",
    tags: [],
    customFields: {},
    version: 1,
  };

  test("API-013 persons and stats are expanded on request; a missing updatedAt falls back to the creation time", () => {
    const out = serializeContact(
      record,
      { persons: [{ _id: RAW2, number: "10002", displayName: "Erika Muster" }] },
      new Set(["persons", "stats", "vat_status"]),
    );
    expect(out.persons).toEqual([{ id: `con_${RAW2}`, number: "10002", display_name: "Erika Muster" }]);
    expect(out.stats).toEqual({});
    expect(out.updated_at).toBe("2026-10-01T00:00:00.000Z");
    expect(out.vat_status).toEqual({ status: "unchecked", qualified: false, checked_at: null, check_id: null });
  });

  test("CON-055 the search row shows „unchecked“ for an unchecked VAT ID and null without one", () => {
    expect(contactSearchRow(record)).toMatchObject({
      id: `con_${RAW}`,
      vat_status: "unchecked",
      city: null,
      email: null,
    });
    const { vatId: _v, ...noVat } = record;
    expect(contactSearchRow(noVat as ContactWireRecord, { city: "Berlin", email: "a@b.de" })).toMatchObject({
      vat_id: null,
      vat_status: null,
      city: "Berlin",
      email: "a@b.de",
    });
  });

  test("CON-134 MCP-006 merge arguments are fully defaulted; a wrong-prefixed winner, loser or field choice voids them", () => {
    expect(contactMergeArgs({ winner_id: `con_${RAW}`, loser_ids: [`con_${RAW2}`] })).toEqual({
      values: { winnerId: RAW, loserIds: [RAW2], fieldChoices: {}, confirmVatConflict: false },
    });
    expect(
      contactMergeArgs({
        winner_id: `con_${RAW}`,
        loser_ids: [`con_${RAW2}`],
        field_choices: { vatId: `con_${RAW2}` },
        confirm_vat_conflict: true,
      }),
    ).toEqual({ values: { winnerId: RAW, loserIds: [RAW2], fieldChoices: { vatId: RAW2 }, confirmVatConflict: true } });
    expect(contactMergeArgs({ winner_id: `prd_${RAW}`, loser_ids: [`con_${RAW2}`] })).toBeNull();
    expect(contactMergeArgs({ winner_id: `con_${RAW}`, loser_ids: [`prd_${RAW2}`] })).toBeNull();
    expect(
      contactMergeArgs({
        winner_id: `con_${RAW}`,
        loser_ids: [`con_${RAW2}`],
        field_choices: { vatId: `prd_${RAW2}` },
      }),
    ).toBeNull();
  });

  test("API-015 a full PATCH applied to the stored record passes the shared contact validation", () => {
    const patch = contactPatchToForm(
      contactPatchWire.parse({
        organization_name2: "Filiale",
        currency: "CHF",
        notes: "neu",
        default_discount_bp: 500,
      }),
    );
    const merged = contactSchema.parse({ ...contactFormFromRecord(record as never), ...patch });
    expect(merged).toMatchObject({
      organizationName2: "Filiale",
      currency: "CHF",
      notes: "neu",
      defaultDiscountBp: 500,
    });
  });
});
