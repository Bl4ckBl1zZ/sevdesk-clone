import { describe, expect, test } from "vitest";
import {
  checkBillingAddressComplete,
  defaultChanges,
  formatAddressLine,
  isKnownCountry,
  isValidPostalCodeFor,
  nextDefaultAfterRemoval,
  validateAddress,
} from "./address";
import {
  invoiceRecipients,
  normalizeEmail,
  normalizeUrl,
  primaryOf,
  telHref,
  toE164,
  validateChannel,
} from "./channels";

const addr = { name: "Müller GmbH", street: "Hauptstr. 1", postalCode: "10115", city: "Berlin", countryCode: "DE" };

describe("CON-020 … CON-025 addresses", () => {
  test("CON-025 postal-code formats for DE, AT, CH, NL, FR, IT, ES, PL, GB; others 2–10 chars", () => {
    const ok: [string, string][] = [
      ["DE", "10115"],
      ["AT", "1010"],
      ["CH", "8001"],
      ["NL", "1012 AB"],
      ["NL", "1012AB"],
      ["FR", "75001"],
      ["IT", "00184"],
      ["ES", "28013"],
      ["PL", "00-950"],
      ["GB", "SW1A 1AA"],
      ["US", "94105"],
    ];
    for (const [c, p] of ok) expect(isValidPostalCodeFor(c, p), `${c} ${p}`).toBe(true);
    const bad: [string, string][] = [
      ["DE", "1011"],
      ["AT", "10100"],
      ["NL", "1012"],
      ["ES", "53001"],
      ["PL", "00950"],
      ["GB", "12345"],
      ["US", "1"],
    ];
    for (const [c, p] of bad) expect(isValidPostalCodeFor(c, p), `${c} ${p}`).toBe(false);
  });

  test("CON-025 §5.2 POSTAL_CODE_INVALID names the country; unknown country → COUNTRY_INVALID", () => {
    const v = validateAddress({ ...addr, postalCode: "1234" });
    expect(v.errors[0]).toMatchObject({
      code: "POSTAL_CODE_INVALID",
      field: "postalCode",
      message: "Die Postleitzahl passt nicht zum Land Deutschland.",
    });
    expect(validateAddress({ ...addr, countryCode: "QQ" }).errors[0]?.code).toBe("COUNTRY_INVALID");
    expect(validateAddress({ ...addr, street: "x".repeat(101) }).errors[0]?.code).toBe("TOO_LONG");
    expect(isKnownCountry("XI")).toBe(true);
    expect(isKnownCountry("D")).toBe(false);
  });

  test("T-CON-032 CON-022 billing address completeness names the missing fields", () => {
    expect(checkBillingAddressComplete(addr)).toBeNull();
    expect(checkBillingAddressComplete({ ...addr, street: "", poBox: "1234" })).toBeNull();
    const e = checkBillingAddressComplete({ ...addr, street: "", postalCode: "" });
    expect(e?.code).toBe("CONTACT_ADDRESS_INCOMPLETE");
    expect(e?.message).toBe("Rechnungsadresse unvollständig: Straße oder Postfach, Postleitzahl fehlt.");
    expect(checkBillingAddressComplete(null)?.message).toBe("Rechnungsadresse unvollständig: Rechnungsadresse fehlt.");
  });

  test("CON-020 exactly one default per type: setting one unsets the others; the first is the default", () => {
    const stored = [
      { id: "a", type: "billing" as const, isDefault: true },
      { id: "b", type: "billing" as const, isDefault: false },
      { id: "c", type: "delivery" as const, isDefault: true },
    ];
    expect(defaultChanges(stored, { id: "b", type: "billing", wantsDefault: true })).toEqual({
      unset: ["a"],
      setTarget: true,
    });
    expect(defaultChanges(stored, { id: "new", type: "other", wantsDefault: false })).toEqual({
      unset: [],
      setTarget: true,
    });
    expect(defaultChanges(stored, { id: "new", type: "billing", wantsDefault: false })).toEqual({
      unset: [],
      setTarget: false,
    });
    expect(nextDefaultAfterRemoval(stored, { id: "a", type: "billing" })).toBe("b");
    expect(nextDefaultAfterRemoval(stored, { id: "b", type: "billing" })).toBeNull();
  });

  test("CON-021 address lines for lists", () => {
    expect(formatAddressLine(addr)).toBe("Hauptstr. 1, 10115 Berlin");
    expect(formatAddressLine({ ...addr, countryCode: "AT", postalCode: "1010", city: "Wien" })).toBe(
      "Hauptstr. 1, 1010 Wien, Österreich",
    );
    expect(formatAddressLine({ ...addr, street: "", poBox: "12" })).toBe("Postfach 12, 10115 Berlin");
  });
});

describe("CON-030 … CON-033 channels", () => {
  test("CON-032 e-mails: trim, lower-case domain; invalid → EMAIL_INVALID", () => {
    expect(normalizeEmail("  Anna.Mueller@Example.DE ")).toBe("Anna.Mueller@example.de");
    const r = validateChannel({ type: "email", value: "kein-at", isPrimary: true, isInvoiceEmail: true });
    expect(r.errors[0]).toMatchObject({ code: "EMAIL_INVALID", message: "Die E-Mail-Adresse „kein-at“ ist ungültig." });
  });

  test("CON-032 phones keep the input plus E.164 (default region DE) for tel: links", () => {
    expect(toE164("030 1234567")).toBe("+49301234567");
    expect(toE164("+43 1 234567")).toBe("+431234567");
    expect(toE164("0043 1 234567")).toBe("+431234567");
    expect(toE164("+49 (0)30 123456")).toBe("+4930123456");
    expect(toE164("1234")).toBeUndefined();
    expect(toE164("Zentrale")).toBeUndefined();
    const r = validateChannel({ type: "phone", value: "030 1234567", isPrimary: true, isInvoiceEmail: false });
    expect(r.value).toMatchObject({ value: "030 1234567", e164: "+49301234567" });
    expect(telHref("030 1234567")).toBe("tel:+49301234567");
    expect(telHref("Durchwahl 12")).toBe("tel:12");
  });

  test("§5.2 URLs get https://; invoice flag only on e-mails; duplicates refused", () => {
    expect(normalizeUrl("mueller.de")).toBe("https://mueller.de");
    expect(normalizeUrl("http://mueller.de")).toBe("http://mueller.de");
    expect(
      validateChannel({ type: "phone", value: "0301", isPrimary: false, isInvoiceEmail: true }).errors[0]?.code,
    ).toBe("INVOICE_EMAIL_TYPE");
    expect(
      validateChannel({ type: "email", value: "a@b.de", isPrimary: false, isInvoiceEmail: false }, [
        { type: "email", value: "A@B.DE" },
      ]).errors[0]?.message,
    ).toBe("Dieser Eintrag ist bereits vorhanden.");
    expect(validateChannel({ type: "web", value: " ", isPrimary: false, isInvoiceEmail: false }).errors[0]?.code).toBe(
      "REQUIRED",
    );
  });

  test("T-CON-049 CON-031 invoice e-mails: all of the contact; a person without own inherits the organisation's", () => {
    const org = [
      { type: "email" as const, value: "rechnung@m.de", isInvoiceEmail: true, isPrimary: true },
      { type: "email" as const, value: "buchhaltung@m.de", isInvoiceEmail: true, isPrimary: false },
      { type: "email" as const, value: "info@m.de", isInvoiceEmail: false, isPrimary: false },
    ];
    expect(invoiceRecipients(org, null)).toEqual(["rechnung@m.de", "buchhaltung@m.de"]);
    expect(invoiceRecipients([], org)).toEqual(["rechnung@m.de", "buchhaltung@m.de"]);
    const own = [{ type: "email" as const, value: "anna@m.de", isInvoiceEmail: true, isPrimary: true }];
    expect(invoiceRecipients(own, org)).toEqual(["anna@m.de"]);
    expect(primaryOf(org, "email")).toBe("rechnung@m.de");
    expect(primaryOf(org, "phone")).toBeUndefined();
  });
});
