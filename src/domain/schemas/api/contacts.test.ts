import { describe, expect, test } from "vitest";
import { contactCreateSchema, contactFormFromRecord, contactSchema } from "../contacts";
import {
  type ContactWireRecord,
  contactCreateToForm,
  contactCreateWire,
  contactFieldMapper,
  contactOut,
  contactPatchToForm,
  contactPatchWire,
  matchValues,
  parseMatch,
  serializeContact,
} from "./contacts";

const RAW = "k57f3x2m9q8w1e4r6t";

const record: ContactWireRecord = {
  _id: RAW,
  _creationTime: Date.UTC(2026, 9, 1),
  kind: "organization",
  number: "K-1001",
  displayName: "Muster GmbH",
  status: "active",
  organizationName: "Muster GmbH",
  roles: ["customer"],
  isConsumer: false,
  isPublicAuthority: false,
  vatId: "DE123456788",
  vatIdStatus: { lastCheckId: "j9a8s7d6f5g4h3k2l1", status: "valid", qualified: true, checkedAt: Date.UTC(2026, 9, 2) },
  einvoice: { preferredFormat: "auto" },
  language: "de",
  currency: "EUR",
  paymentTerms: { dueDays: 14, skontoPercentBp: 200, skontoDays: 7 },
  tags: ["t1t1t1t1t1t1t1t1t1"],
  customFields: {},
  version: 3,
  updatedAt: Date.UTC(2026, 9, 5),
};

describe("contacts on the wire (05 §4.1, F02 §7.1)", () => {
  test("API-011 a POST body maps onto the shared create form and passes the same zod validation", () => {
    const body = contactCreateWire.parse({
      kind: "organization",
      organization_name: "Beispiel AG",
      vat_id: "de 123 456 788",
      payment_terms: { due_days: 30, skonto_percent_bp: 250, skonto_days: 10 },
      tags: [`tag_${RAW}`],
      billing_address: { street: "Hauptstr. 1", postal_code: "10115", city: "Berlin", country_code: "DE" },
      channels: [{ type: "email", value: "Rechnung@Beispiel.de", is_invoice_email: true }],
    });
    const form = contactCreateToForm(body);
    expect(form.contact).toMatchObject({ dueDays: "30", skontoPercent: "2,5", skontoDays: "10", tags: [RAW] });
    const parsed = contactCreateSchema.parse(form);
    expect(parsed.contact).toMatchObject({
      organizationName: "Beispiel AG",
      vatId: "DE123456788",
      paymentTerms: { dueDays: 30, skontoPercentBp: 250, skontoDays: 10 },
    });
    expect(parsed.billingAddress?.city).toBe("Berlin");
    expect(parsed.channels).toHaveLength(1);
  });

  test("API-011 unknown fields and IDs with the wrong prefix are refused at the wire", () => {
    expect(contactCreateWire.safeParse({ kind: "person", foo: 1 }).success).toBe(false);
    expect(contactPatchWire.safeParse({ parent_id: `prd_${RAW}` }).success).toBe(false);
  });

  test("API-015 a PATCH overlays only the given fields on the stored record", () => {
    const patch = contactPatchToForm(contactPatchWire.parse({ payment_terms: null, notes: "VIP" }));
    expect(patch).toEqual({ dueDays: "", skontoPercent: "", skontoDays: "", paymentTermsText: "", notes: "VIP" });
    const merged = contactSchema.parse({ ...contactFormFromRecord(record as never), ...patch });
    expect(merged.paymentTerms).toBeUndefined();
    expect(merged.organizationName).toBe("Muster GmbH");
    expect(merged.notes).toBe("VIP");
  });

  test("API-009 form issue paths are reported as wire fields", () => {
    expect(contactFieldMapper("contact.dueDays")).toBe("payment_terms.due_days");
    expect(contactFieldMapper("contact.vatId")).toBe("vat_id");
    expect(contactFieldMapper("billingAddress.postalCode")).toBe("billing_address.postal_code");
    expect(contactFieldMapper("channels.0.value")).toBe("channels[0].value");
    expect(contactFieldMapper("contact.electronicAddressValue")).toBe("electronic_address.value");
  });

  test("API-017 ?match= accepts email, vat_id, number in order; unknown keys are refused", () => {
    expect(parseMatch("vat_id,email")).toEqual(["vat_id", "email"]);
    expect(parseMatch(undefined)).toEqual([]);
    expect(parseMatch("name")).toBeNull();
    const body = contactCreateWire.parse({
      kind: "person",
      last_name: "Muster",
      vat_id: "de123456789",
      channels: [
        { type: "phone", value: "+49 30 1" },
        { type: "email", value: " A@B.DE " },
      ],
    });
    expect(matchValues(body)).toEqual({ email: "a@b.de", vat_id: "DE123456789" });
  });

  test("API-011 API-013 a record serialises with prefixed IDs, snake_case and the requested expansions only", () => {
    const plain = serializeContact(record);
    expect(contactOut.parse(plain)).toBeTruthy();
    expect(plain).toMatchObject({
      id: `con_${RAW}`,
      object: "contact",
      tags: ["tag_t1t1t1t1t1t1t1t1t1"],
      payment_terms: { due_days: 14, skonto_percent_bp: 200, skonto_days: 7, text: null },
      updated_at: "2026-10-05T00:00:00.000Z",
    });
    expect(plain.vat_status).toBeUndefined();
    const expanded = serializeContact(
      record,
      {
        channels: [
          { _id: "c1c1c1c1c1c1c1c1c1", type: "email", value: "a@b.de", isPrimary: true, isInvoiceEmail: true },
        ],
      },
      new Set(["channels", "vat_status"]),
    );
    expect(expanded.channels?.[0]).toMatchObject({ id: "chn_c1c1c1c1c1c1c1c1c1", is_invoice_email: true });
    expect(expanded.vat_status).toMatchObject({ status: "valid", qualified: true, check_id: "vck_j9a8s7d6f5g4h3k2l1" });
  });
});
