import { describe, expect, test } from "vitest";
import {
  activitySchema,
  addressSchema,
  channelSchema,
  contactCreateSchema,
  contactSchema,
  emptyAddress,
  emptyContactForm,
  pdfConsentSchema,
  percentToBp,
} from "./contacts";

const form = (over: Partial<ReturnType<typeof emptyContactForm>> = {}) => ({
  ...emptyContactForm(),
  organizationName: "Müller GmbH",
  ...over,
});

const messages = (r: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) =>
  r.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`) ?? [];

describe("CON-001 … CON-112 contact schema (shared by UI, Convex, import)", () => {
  test("CON-001 CON-002 a valid organisation parses to the stored shape", () => {
    const r = contactSchema.safeParse(
      form({
        vatId: "atu 123 456 78",
        dueDays: "30",
        skontoPercent: "2",
        skontoDays: "10",
        defaultDiscount: "5,5",
        firstName: "ignored for organisations",
      }),
    );
    expect(messages(r)).toEqual([]);
    expect(r.data).toMatchObject({
      kind: "organization",
      organizationName: "Müller GmbH",
      vatId: "ATU12345678",
      paymentTerms: { dueDays: 30, skontoPercentBp: 200, skontoDays: 10 },
      defaultDiscountBp: 550,
      currency: "EUR",
    });
    expect(r.data).not.toHaveProperty("firstName");
    expect(r.data).not.toHaveProperty("number");
  });

  test("CON-001 §5.1 required name by kind, roles, conflict of flags", () => {
    expect(messages(contactSchema.safeParse(form({ organizationName: "" })))).toEqual([
      "organizationName: Bitte den Firmennamen angeben.",
    ]);
    expect(messages(contactSchema.safeParse(form({ kind: "person" })))).toEqual([
      "lastName: Bitte den Nachnamen angeben.",
    ]);
    expect(messages(contactSchema.safeParse(form({ roles: [] })))[0]).toContain("Bitte mindestens eine Rolle wählen");
    expect(messages(contactSchema.safeParse(form({ isConsumer: true, isPublicAuthority: true })))).toContain(
      "isPublicAuthority: Ein Kontakt kann nicht gleichzeitig Privatkunde und öffentlicher Auftraggeber sein.",
    );
  });

  test("CON-041 CON-084 B2G requires a valid Leitweg-ID in the schema already", () => {
    expect(messages(contactSchema.safeParse(form({ isPublicAuthority: true })))).toEqual([
      "buyerReference: Für öffentliche Auftraggeber ist die Leitweg-ID Pflicht.",
    ]);
    expect(contactSchema.safeParse(form({ isPublicAuthority: true, buyerReference: "991-01234-38" })).success).toBe(
      true,
    );
  });

  test("§5.3 payment fields: invalid numbers and Skonto without due days are field errors", () => {
    expect(messages(contactSchema.safeParse(form({ dueDays: "abc" })))).toEqual([
      "dueDays: Zahlungsziel muss zwischen 0 und 365 Tagen liegen.",
    ]);
    expect(messages(contactSchema.safeParse(form({ skontoPercent: "2" })))).toEqual([
      "dueDays: Für Skonto bitte ein Zahlungsziel angeben.",
    ]);
    expect(messages(contactSchema.safeParse(form({ dueDays: "14", skontoPercent: "x", skontoDays: "7" })))).toEqual([
      "skontoPercent: Skonto muss zwischen 0,01 % und 10 % liegen.",
    ]);
    expect(messages(contactSchema.safeParse(form({ defaultDiscount: "abc" })))).toEqual([
      "defaultDiscount: Rabatt kann höchstens 100 % betragen.",
    ]);
    expect(percentToBp("")).toBeUndefined();
    expect(percentToBp("19,5 %")).toBe(1950);
  });

  test("CON-083 an electronic address scheme needs a value; values are checked per scheme", () => {
    expect(messages(contactSchema.safeParse(form({ electronicAddressScheme: "EM" })))).toEqual([
      "electronicAddressValue: Bitte die elektronische Adresse angeben.",
    ]);
    const r = contactSchema.safeParse(form({ electronicAddressScheme: "EM", electronicAddressValue: "e@m.de" }));
    expect(r.data?.electronicAddress).toEqual({ scheme: "EM", value: "e@m.de" });
  });

  test("CON-020 CON-030 create form: inline billing address (optional) and channels", () => {
    const r = contactCreateSchema.safeParse({
      contact: form(),
      billingAddress: { ...emptyAddress(), street: "Hauptstr. 1", postalCode: "1011", city: "Berlin" },
      channels: [
        { type: "email", value: "x@y.de", label: "", isPrimary: true, isInvoiceEmail: true },
        { type: "email", value: "X@Y.DE", label: "", isPrimary: false, isInvoiceEmail: false },
        { type: "phone", value: "", label: "", isPrimary: true, isInvoiceEmail: false },
      ],
    });
    expect(messages(r)).toEqual([
      "billingAddress.postalCode: Die Postleitzahl passt nicht zum Land Deutschland.",
      "channels.1.value: Dieser Eintrag ist bereits vorhanden.",
    ]);
    const blank = contactCreateSchema.safeParse({ contact: form(), billingAddress: emptyAddress(), channels: [] });
    expect(blank.success && blank.data.billingAddress).toBeUndefined();
  });

  test("CON-020 CON-030 address and channel schemas", () => {
    expect(
      addressSchema.safeParse({
        type: "delivery",
        isDefault: true,
        ...emptyAddress("AT"),
        postalCode: "1010",
        city: "Wien",
      }).success,
    ).toBe(true);
    expect(
      messages(
        channelSchema.safeParse({ type: "fax", value: "0301", label: "", isPrimary: false, isInvoiceEmail: true }),
      ),
    ).toEqual(["isInvoiceEmail: Nur E-Mail-Adressen können als Rechnungsempfänger markiert werden."]);
  });

  test("CON-081 CON-121 CON-122 consent and activity schemas", () => {
    expect(messages(pdfConsentSchema.safeParse({ givenAt: "2026-02-03", source: "tacit", note: "" }))).toEqual([
      "note: Bitte beschreiben, woraus sich die stillschweigende Zustimmung ergibt.",
    ]);
    expect(messages(activitySchema.safeParse({ kind: "task", text: "Anrufen", dueOn: "" }))).toEqual([
      "dueOn: Bitte ein Fälligkeitsdatum angeben.",
    ]);
    expect(activitySchema.safeParse({ kind: "note", text: "Hallo", dueOn: "" }).success).toBe(true);
  });
});
